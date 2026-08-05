import { describe, expect, it, vi } from 'vitest';
import {
  CommandCatalog,
  type CommandContext,
  type CommandNode,
} from '../../src/commands/catalog.js';
import { createDefaultCommandCatalog } from '../../src/commands/command-tree.js';

const context = {} as CommandContext;

function createCatalog(): CommandCatalog {
  const nodes: CommandNode[] = [
    {
      kind: 'group',
      name: 'task',
      summary: '任务',
      children: [
        {
          kind: 'action',
          name: 'list',
          summary: '列表',
          effect: '列出任务',
          usages: ['/task list [all|done]'],
          examples: ['/task list done'],
          arguments: [{
            name: 'scope',
            kind: 'enum',
            description: '范围',
            optional: true,
            values: [
              { value: 'all', description: '全部' },
              { value: 'done', description: '完成' },
            ],
          }],
          execute: vi.fn(async args => ({
            type: 'text' as const,
            content: String(args.positionals.scope ?? 'all'),
          })),
        },
        {
          kind: 'action',
          name: 'block',
          summary: '阻塞',
          effect: '阻塞任务',
          usages: ['/task block <taskId> <reason...>'],
          examples: ['/task block task-1 "等待 review"'],
          arguments: [
            { name: 'taskId', kind: 'text', description: '任务 ID' },
            { name: 'reason', kind: 'rest', description: '原因' },
          ],
          execute: vi.fn(async args => ({
            type: 'text' as const,
            content: String(args.positionals.taskId) + ':' + String(args.positionals.reason),
          })),
        },
      ],
    },
    {
      kind: 'action',
      name: 'help',
      summary: '帮助',
      effect: '展示帮助',
      usages: ['/help [<commandPath...>]'],
      examples: ['/help task block'],
      arguments: [{ name: 'commandPath', kind: 'command-path', description: '路径', optional: true }],
      builtin: 'help',
    },
  ];
  return new CommandCatalog(nodes);
}

describe('CommandCatalog', () => {
  it('uses one tree for action listing and help descriptions', async () => {
    const catalog = createCatalog();
    expect(catalog.listActions()).toEqual(['/task list', '/task block', '/help']);
    expect(catalog.describe()).toContain('/task');
    expect((await catalog.execute('/help task block', context)).content)
      .toContain('/task block <taskId> <reason...>');
  });

  it('parses quotes, escapes, enums, optional args and rest text', async () => {
    expect((await createCatalog().execute('/task block task-1 "等待 review"', context)).content)
      .toBe('task-1:等待 review');
    expect((await createCatalog().execute('/task block task-1 等待\\ review', context)).content)
      .toBe('task-1:等待 review');
    expect((await createCatalog().execute('/task list done', context)).content).toBe('done');
    expect((await createCatalog().execute('/task list invalid', context)).content).toContain('值无效');
    expect((await createCatalog().execute('/task block task-1 "未闭合', context)).content).toContain('未闭合');
  });

  it('completes one level and returns an exact replacement range in the middle', () => {
    const catalog = createCatalog();
    const root = catalog.complete({ text: '/', cursor: 1, context });
    expect(root.suggestions.map(item => item.value)).toEqual(['task', 'help']);

    const child = catalog.complete({ text: '/task ', cursor: 6, context });
    expect(child.suggestions.map(item => item.value)).toEqual(['list', 'block']);

    const middle = catalog.complete({ text: '/task li done', cursor: 8, context });
    expect(middle.suggestions[0]?.replacement).toEqual({ start: 6, end: 8, text: 'list' });
  });

  it('uses a slash only for root command-node suggestions', () => {
    const catalog = createDefaultCommandCatalog();

    const root = catalog.complete({ text: '/', cursor: 1, context });
    expect(root.suggestions.find(item => item.value === 'executor')).toMatchObject({
      label: '/executor',
      replacement: { start: 0, end: 1, text: '/executor' },
    });
    const configRoot = catalog.complete({ text: '/con', cursor: 4, context });
    expect(configRoot.suggestions.find(item => item.value === 'config')).toMatchObject({
      label: '/config',
      replacement: { start: 0, end: 4, text: '/config' },
    });

    const executor = catalog.complete({ text: '/executor ', cursor: 10, context });
    expect(executor.suggestions.find(item => item.value === 'show')).toMatchObject({
      label: 'show',
      replacement: { start: 10, end: 10, text: 'show' },
    });

    const learning = catalog.complete({ text: '/learning ', cursor: 10, context });
    expect(learning.suggestions.find(item => item.value === 'patch')).toMatchObject({
      label: 'patch',
      replacement: { start: 10, end: 10, text: 'patch' },
    });

    const patch = catalog.complete({ text: '/learning patch ', cursor: 16, context });
    expect(patch.suggestions.find(item => item.value === 'approve')).toMatchObject({
      label: 'approve',
      replacement: { start: 16, end: 16, text: 'approve' },
    });

    for (const completion of [root, configRoot, executor, learning, patch]) {
      for (const suggestion of completion.suggestions) {
        if (suggestion.value === suggestion.label.replace(/^\//, '')) {
          expect(suggestion.label).toBe(suggestion.replacement.text);
        }
      }
    }
  });

  it('keeps typo replacements at their command-tree level and rejects nested groups as roots', async () => {
    const catalog = createDefaultCommandCatalog();

    expect(catalog.complete({ text: '/excutor', cursor: 8, context }).suggestions[0]).toMatchObject({
      label: '/executor',
      replacement: { start: 0, end: 8, text: '/executor' },
    });
    expect(catalog.complete({ text: '/executor shwo', cursor: 14, context }).suggestions[0]).toMatchObject({
      label: 'show',
      replacement: { start: 10, end: 14, text: 'show' },
    });
    expect((await catalog.execute('/register', context)).content).toContain('未知命令节点: register');
    expect((await catalog.execute('/patch', context)).content).toContain('未知命令节点: patch');
  });

  it('offers a nearest command node as a Tab replacement without making the typo executable', () => {
    const catalog = createCatalog();
    const rootTypo = catalog.complete({ text: '/taks', cursor: 5, context });
    expect(rootTypo.state).not.toBe('executable');
    expect(rootTypo.suggestions[0]?.replacement).toEqual({ start: 0, end: 5, text: '/task' });

    const nestedTypo = catalog.complete({ text: '/task lsit ', cursor: 11, context });
    expect(nestedTypo.state).toBe('invalid');
    expect(nestedTypo.suggestions[0]?.replacement).toEqual({ start: 6, end: 10, text: 'list' });
  });

  it('loads a dynamic reference provider once when validation and suggestions use the same prefix', () => {
    const candidates = vi.fn(() => [{ value: 'item-1', label: 'item-1', description: 'first item' }]);
    const catalog = new CommandCatalog([{
      kind: 'action',
      name: 'pick',
      summary: 'pick item',
      effect: 'pick item',
      usages: ['/pick <itemId>'],
      examples: ['/pick item-1'],
      arguments: [{
        name: 'itemId',
        kind: 'reference',
        description: 'item',
        candidates,
      }],
      execute: vi.fn(),
    }]);

    const completion = catalog.complete({ text: '/pick item-1', cursor: 12, context });
    expect(completion.state).toBe('executable');
    expect(candidates).toHaveBeenCalledTimes(1);
  });

  it('shows task titles while replacing with the immutable task id', () => {
    const taskEngine = {
      getTaskRepo: () => ({
        findAll: () => [
          { id: 'task-1', title: 'Prepare release notes', status: 'running', updatedAt: '2026-08-04T10:00:00.000Z' },
        ],
        findById: (id: string) => id === 'task-1'
          ? { id: 'task-1', title: 'Prepare release notes', status: 'running', updatedAt: '2026-08-04T10:00:00.000Z' }
          : null,
      }),
    };
    const completion = createDefaultCommandCatalog().complete({
      text: '/task show ',
      cursor: 11,
      context: { taskEngine, currentTaskId: null } as unknown as CommandContext,
    });
    expect(completion.suggestions[0]).toMatchObject({
      value: 'task-1',
      label: 'Prepare release notes · #task-1',
      description: '[RUNNING] updated 2026-08-04T10:00:00.000Z',
      replacement: { start: 11, end: 11, text: 'task-1' },
    });
  });

  it('distinguishes directories, incomplete actions and executable actions', () => {
    const catalog = createCatalog();
    expect(catalog.complete({ text: '/task', cursor: 5, context }).state).toBe('incomplete');
    expect(catalog.complete({ text: '/task block', cursor: 11, context }).state).toBe('incomplete');
    expect(catalog.complete({ text: '/task block task-1 reason', cursor: 25, context }).state).toBe('executable');
  });

  it('contains the migrated command tree without old roots or aliases', () => {
    const catalog = createDefaultCommandCatalog();
    const actions = catalog.listActions();
    const expectedActions = `
/task dashboard
/task list
/task clear
/task show
/task pause
/task resume
/task block
/task unblock
/task cancel
/task subtask-cancel
/task accept-partial
/task attach
/task history
/task recovery
/task recover
/task index rebuild
/task index search
/executor list
/executor refresh
/executor show
/executor feedback
/memory list
/memory search
/memory add
/memory edit
/memory delete
/memory stats
/memory vault export
/memory vault status
/profile user
/profile project
/profile executor
/learning candidates
/learning approve
/learning reject
/learning skill-feedback
/learning patch candidates
/learning patch approve
/learning cards
/learning skills
/learning weekly
/learning summary
/config
/help
/exit
`.trim().split('\n');
    expect(new Set(actions)).toEqual(new Set(expectedActions));
    const help = catalog.describe();
    for (const commandPath of actions) expect(help).toContain(commandPath);
    expect(actions).toContain('/task dashboard');
    expect(actions).toContain('/task index search');
    expect(actions).not.toContain('/task complete');
    expect(actions).not.toContain('/executor register <executorName>');
    expect(actions).not.toContain('/executor register wizard');
    expect(actions).not.toContain('/executor unregister');
    expect(actions).not.toContain('/learning promote');
    expect(actions).not.toContain('/learning patch promote');
    expect(actions).toContain('/profile user');
    expect(actions).toContain('/config');
    expect(actions).toContain('/help');
    expect(actions).toContain('/exit');
    expect(actions).not.toContain('/tasks');
    expect(actions).not.toContain('/dashboard');
    expect(actions).not.toContain('/quit');
  });
});
