import { describe, expect, it } from 'vitest';
import {
  deriveCancellationClosure,
  deriveRunnableFrontier,
  validateWorkGraph,
  type WorkGraphRuntimeFact,
  type WorkGraphSubtask,
} from '../../src/work-graph/index.js';

function subtask(
  id: string,
  dependencies: WorkGraphSubtask['dependencies'] = [],
  preferredAgentClassList: WorkGraphSubtask['preferredAgentClassList'] = ['codex-cli'],
): WorkGraphSubtask {
  return {
    id,
    title: id,
    goal: `complete ${id}`,
    dependencies,
    contextRefs: [{ kind: 'current_user_input' }],
    requiredCapabilities: ['workspace-engineering'],
    preferredAgentClassList,
    deliveryKind: 'report',
    acceptance: [{ key: 'complete', description: `complete ${id}`, requiredEvidence: [] }],
    riskLevel: 'low',
  };
}

function edge(fromSubtaskId: string): WorkGraphSubtask['dependencies'][number] {
  return {
    fromSubtaskId,
    requiredItems: [{ key: 'result', type: 'text', description: 'normalized upstream result' }],
  };
}

describe('Work Graph v4 structural rules', () => {
  it('accepts a valid direct handoff graph', () => {
    expect(validateWorkGraph({
      subtasks: [subtask('a'), subtask('b', [edge('a')], ['pi-agent'])],
    })).toEqual([]);
  });

  it('reports adjacent same-preferred work that one AgentClass should complete as one Subtask', () => {
    expect(validateWorkGraph({
      subtasks: [subtask('implement'), subtask('verify', [edge('implement')])],
    })).toContainEqual(expect.objectContaining({
      code: 'mergeable_same_agent_chain',
      subtaskIds: ['implement', 'verify'],
      message: 'subtasks implement -> verify form a mergeable codex-cli single chain',
    }));
  });

  it('allows a reentrant AgentClass to own multiple nodes in one runnable layer', () => {
    expect(validateWorkGraph({
      subtasks: [subtask('root'), subtask('left', [edge('root')]), subtask('right', [edge('root')])],
    })).toEqual([]);
  });

  it.each([
    {
      name: 'plain chain',
      subtasks: [subtask('a'), subtask('b', [edge('a')])],
      expected: true,
    },
    {
      name: 'upstream accepts a join',
      subtasks: [
        subtask('left', [], ['pi-agent']),
        subtask('right'),
        subtask('a', [edge('left'), edge('right')]),
        subtask('b', [edge('a')]),
      ],
      expected: true,
    },
    {
      name: 'downstream fans out later',
      subtasks: [
        subtask('a'),
        subtask('b', [edge('a')]),
        subtask('left', [edge('b')], ['pi-agent']),
        subtask('right', [edge('b')], ['pi-agent']),
      ],
      expected: true,
    },
    {
      name: 'upstream has another child',
      subtasks: [
        subtask('a'),
        subtask('b', [edge('a')]),
        subtask('other', [edge('a')], ['pi-agent']),
      ],
      expected: false,
    },
    {
      name: 'downstream has another dependency',
      subtasks: [
        subtask('a'),
        subtask('other', [], ['pi-agent']),
        subtask('b', [edge('a'), edge('other')]),
      ],
      expected: false,
    },
    {
      name: 'preferred AgentClasses differ',
      subtasks: [subtask('a'), subtask('b', [edge('a')], ['pi-agent'])],
      expected: false,
    },
  ])('applies the exact mergeable-chain rule: $name', ({ subtasks, expected }) => {
    const violations = validateWorkGraph({ subtasks });
    expect(violations.some(item => item.code === 'mergeable_same_agent_chain')).toBe(expected);
  });

  it('rejects ordering-only dependencies', () => {
    const graph = { subtasks: [subtask('a'), subtask('b', [{ fromSubtaskId: 'a', requiredItems: [] }])] };
    expect(validateWorkGraph(graph).map(item => item.code)).toContain('dependency_items_count_invalid');
  });

  it('rejects duplicate keys, invalid keys and duplicate context refs', () => {
    const invalid = subtask('a');
    invalid.acceptance = [
      { key: 'Bad Key', description: 'one', requiredEvidence: [] },
      { key: 'Bad Key', description: 'two', requiredEvidence: [] },
    ];
    invalid.contextRefs = [{ kind: 'current_user_input' }, { kind: 'current_user_input' }];
    expect(validateWorkGraph({ subtasks: [invalid] }).map(item => item.code)).toEqual(expect.arrayContaining([
      'duplicate_acceptance_key',
      'duplicate_context_ref',
      'invalid_key',
    ]));
  });

  it('rejects unknown dependencies and cycles', () => {
    expect(validateWorkGraph({ subtasks: [subtask('a', [edge('missing')])] }).map(item => item.code))
      .toEqual(expect.arrayContaining(['missing_entry_node', 'unknown_dependency']));
    expect(validateWorkGraph({ subtasks: [subtask('a', [edge('b')]), subtask('b', [edge('a')])] }).map(item => item.code))
      .toEqual(expect.arrayContaining(['dependency_cycle', 'missing_entry_node']));
  });
});

describe('Work Graph v5 runnable frontier', () => {
  it('returns every dependency-satisfied node in stable topology, authorization, and id order', () => {
    const subtasks = [
      subtask('root-a', [], ['pi-agent']),
      subtask('root-b'),
      subtask('later-z', [edge('root-a')], ['pi-agent']),
      subtask('later-a', [edge('root-b')]),
    ];
    const facts: WorkGraphRuntimeFact[] = [
      runtimeFact('root-a', 'done'),
      runtimeFact('root-b', 'done'),
      runtimeFact('later-z', 'ready', 1),
      runtimeFact('later-a', 'ready', 0),
    ];

    expect(deriveRunnableFrontier({ subtasks }, facts)).toEqual(['later-a', 'later-z']);
  });

  it('does not expose awaiting-integration dependencies or a Subtask with pending dispatch', () => {
    const subtasks = [
      subtask('published'),
      subtask('candidate', [], ['pi-agent']),
      subtask('downstream', [edge('candidate')]),
      subtask('independent', [edge('published')], ['pi-agent']),
    ];
    const facts: WorkGraphRuntimeFact[] = [
      runtimeFact('published', 'done'),
      runtimeFact('candidate', 'awaiting_integration'),
      runtimeFact('downstream', 'ready'),
      runtimeFact('independent', 'ready', null, true),
    ];

    expect(deriveRunnableFrontier({ subtasks }, facts)).toEqual([]);
  });
});

describe('Work Graph cancellation closure', () => {
  it('cancels an atomic target batch and every transitive downstream node in stable reverse topology order', () => {
    const subtasks = [
      subtask('root'),
      subtask('left', [edge('root')]),
      subtask('right', [edge('root')]),
      subtask('left-leaf', [edge('left')]),
      subtask('join', [edge('left-leaf'), edge('right')]),
      subtask('independent'),
    ];

    expect(deriveCancellationClosure(
      { subtasks },
      subtasks.map(item => ({ subtaskId: item.id, status: 'ready' })),
      ['left', 'right'],
    )).toEqual({
      ok: true,
      subtaskIds: ['join', 'left-leaf', 'left', 'right'],
    });
  });
});

function runtimeFact(
  subtaskId: string,
  status: WorkGraphRuntimeFact['status'],
  firstDispatchOrder: number | null = null,
  hasPendingOrActiveAttempt = false,
): WorkGraphRuntimeFact {
  return { subtaskId, status, firstDispatchOrder, hasPendingOrActiveAttempt };
}
