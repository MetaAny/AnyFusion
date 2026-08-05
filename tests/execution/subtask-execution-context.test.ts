import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { SubtaskHandoffRepo } from '../../src/storage/subtask-handoff-repo.js';
import { SubtaskExecutionContextBuilder } from '../../src/execution/subtask-execution-context.js';
import type { Subtask, Task } from '../../src/core/types.js';

function node(id: string, title: string, dependencies: Subtask['dependencies'] = []): Subtask {
  return {
    id, taskId: 'task_context', title, goal: `private goal for ${title}`, status: 'ready',
    dependencies, contextRefs: [], requiredCapabilities: ['workspace-engineering'],
    preferredAgentClassList: ['codex-cli'], deliveryKind: 'report',
    acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }], riskLevel: 'low',
    result: '', artifacts: [], verification: { warnings: [], completionSchemaVersion: null }, error: null,
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

describe('SubtaskExecutionContextBuilder', () => {
  it('injects only direct immutable handoffs and exposes siblings by identity, not goal', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`
      INSERT INTO tasks (
        id, title, goal, status, summary, snapshot_json, resources_json, artifacts_json,
        dependencies_json, priority_json, injected_prefs_json, last_scheduling_reason,
        last_interruption_reason, interruption_count, created_at, updated_at
      ) VALUES ('task_context', 'Task background', 'top-level background only', 'running', '', '[]', '[]', '[]', '[]', '{}', '[]', '', '', 0, ?, ?)
    `).run('2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
    const a = node('a', 'A');
    a.status = 'done';
    const b = node('b', 'B', [{ fromSubtaskId: 'a', requiredItems: [{ key: 'summary', type: 'text', description: 'A summary' }] }]);
    const c = node('c', 'C', [{ fromSubtaskId: 'b', requiredItems: [{ key: 'summary', type: 'text', description: 'B summary' }] }]);
    const repo = new SubtaskRepo(db);
    [a, b, c].forEach(subtask => repo.upsert(subtask));
    new SubtaskHandoffRepo(db).insert({
      taskId: 'task_context', fromSubtaskId: 'a', toSubtaskId: 'b', attemptId: 'attempt_a',
      items: [{ key: 'summary', type: 'text', value: 'normalized A delivery' }],
      completionSchemaVersion: 1, createdAt: '2026-07-17T00:00:01.000Z',
    });
    const task: Task = {
      id: 'task_context', title: 'Task background', goal: 'top-level background only', status: 'running', summary: '',
      snapshots: [], resources: [], artifacts: [], dependencies: [],
      prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
      injectedPreferences: [], lastSchedulingReason: '', lastInterruptionReason: '', interruptionCount: 0,
      createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
    };

    const built = new SubtaskExecutionContextBuilder(db).build({
      executionId: 'exec', task, subtask: b, allSubtasks: [a, b, c], attemptId: 'attempt_b',
      workUnitId: 'wu', sessionId: 'session',
      workspaceContext: { allowFilesystem: true, workingDirectory: '/repo', targetPaths: ['/repo/out'] },
      evidenceToolsAvailable: false,
    });

    expect(built.context.incomingHandoffs).toHaveLength(1);
    expect(built.context.incomingHandoffs[0]!.items).toEqual([{ key: 'summary', type: 'text', value: 'normalized A delivery' }]);
    expect(built.context.outgoingHandoffRequirements).toEqual([{
      toSubtaskId: 'c', requiredItems: [{ key: 'summary', type: 'text', description: 'B summary' }],
    }]);
    expect(built.context.outOfScopeSiblings).toEqual([{ id: 'a', title: 'A' }, { id: 'c', title: 'C' }]);
    expect(JSON.stringify(built.context.outOfScopeSiblings)).not.toContain('private goal');
    expect(built.context.taskBackground.instruction).toBe('background_only');
  });
});
