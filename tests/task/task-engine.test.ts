import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { tmpdir } from 'os';
import { resolve } from 'path';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('TaskEngine', () => {
  let engine: TaskEngine;
  let repo: TaskRepo;

  beforeEach(() => {
    const db = createTestDb();
    repo = new TaskRepo(db);
    engine = new TaskEngine(repo, resolve(tmpdir(), 'metaclaw-test-snapshots'));
  });

  it('should create a task', () => {
    const task = engine.create({ title: '测试任务', goal: '验证创建功能' });
    expect(task.id).toMatch(/^task_/);
    expect(task.title).toBe('测试任务');
    expect(task.status).toBe('created');
  });

  it.each(['', '   '])('should replace a blank explicit task id with a generated id', id => {
    const task = engine.create({ id, title: '测试任务', goal: '拒绝空主键' });

    expect(task.id).toMatch(/^task_/);
    expect(repo.findById(id)).toBeNull();
  });

  it('should transition task status', () => {
    const task = engine.create({ title: '测试', goal: '测试' });
    const ready = engine.transition(task.id, 'ready');
    expect(ready.status).toBe('ready');

    const running = engine.transition(task.id, 'running');
    expect(running.status).toBe('running');
  });

  it('should reject invalid transitions', () => {
    const task = engine.create({ title: '测试', goal: '测试' });
    expect(() => engine.transition(task.id, 'done')).toThrow('非法状态迁移');
  });

  it('should park and resume a task', () => {
    const task = engine.create({ title: '测试', goal: '测试' });
    engine.transition(task.id, 'ready');
    engine.transition(task.id, 'running');

    const parked = engine.park(task.id, '临时切换', {
      done: ['步骤1完成'],
      pending: ['步骤2'],
      nextStep: '继续步骤2',
      pauseReason: '临时切换',
    });
    expect(parked.status).toBe('parked');
    expect(parked.snapshots).toHaveLength(1);

    const { task: resumed, resumeSummary } = engine.resume(task.id);
    expect(resumed.status).toBe('ready');
    expect(resumeSummary.lastProgress).toContain('步骤1完成');
    expect(resumeSummary.nextStep).toBe('继续步骤2');
  });

  it('should block and unblock a task', () => {
    const task = engine.create({ title: '测试', goal: '测试' });
    engine.transition(task.id, 'ready');
    engine.transition(task.id, 'running');

    const blocked = engine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: '等待客户资料',
      status: 'waiting',
    });
    expect(blocked.status).toBe('blocked');
    expect(blocked.dependencies).toHaveLength(1);

    const unblocked = engine.unblock(task.id);
    expect(unblocked.status).toBe('ready');
    expect(unblocked.dependencies[0].status).toBe('resolved');
  });

  it('should attach resources', () => {
    const task = engine.create({ title: '测试', goal: '测试' });
    const updated = engine.attachResource(task.id, '/path/to/file.pdf');
    expect(updated.resources).toContain('/path/to/file.pdf');
  });

  it('should persist scheduler metadata on tasks', () => {
    const task = engine.create({ title: '测试', goal: '测试' });

    repo.update(task.id, {
      lastSchedulingReason: '截止时间临近',
      lastInterruptionReason: '被更高优先级任务抢占',
      interruptionCount: 2,
    });

    const updated = repo.findById(task.id);
    expect(updated?.lastSchedulingReason).toBe('截止时间临近');
    expect(updated?.lastInterruptionReason).toBe('被更高优先级任务抢占');
    expect(updated?.interruptionCount).toBe(2);
  });
});
