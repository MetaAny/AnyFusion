import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { createDefaultCommandCatalog } from '../../src/commands/command-tree.js';
import { AgentClassService } from '../../src/executor/agent-class-service.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  new AgentClassService({ db }).seedDefaults();
  return db;
}

function createContext(db: Database.Database) {
  return {
    db,
    executor: { name: 'codex-cli' },
  } as any;
}

describe('agent class and planner route commands', () => {
  it('lists executor AgentClasses from the command surface', async () => {
    const db = createDb();
    const context = createContext(db);
    const catalog = createDefaultCommandCatalog();

    const initial = await catalog.execute('/executor list', context);
    expect(initial.content).toContain('Registered AgentClasses');
    expect(initial.content).toContain('codex-cli');
    expect(initial.content).toContain('planner');
    expect(initial.content).toContain('WorkUnits:');

    expect(initial.content).toContain('health=unverified');
    expect(initial.content).toContain('domains:');
    expect(initial.content).toContain('capabilities:');
    expect(initial.content).toContain('strengths:');
    expect(initial.content).toContain('primary use cases:');
    expect(initial.content).not.toContain('/executor register');
    expect(initial.content).not.toContain('/executor unregister');
  });

  it('does not expose the removed registration commands', async () => {
    const db = createDb();
    const context = createContext(db);
    const catalog = createDefaultCommandCatalog();

    for (const command of ['/executor register wizard', '/executor unregister codex-cli']) {
      expect((await catalog.execute(command, context)).content).toContain('未知命令');
    }
  });

  it('rejects removed register and unregister operations for canonical names', async () => {
    const db = createDb();
    const context = createContext(db);
    const catalog = createDefaultCommandCatalog();

    expect((await catalog.execute('/executor register codex-cli --command custom', context)).content)
      .toContain('未知命令');
    expect((await catalog.execute('/executor unregister codex-cli', context)).content)
      .toContain('未知命令');
  });
});
