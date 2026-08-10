import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const artifactExpectedLine = 'MetaClaw real task smoke passed.';
const pythonHelloFileName = 'hello.py';
const pythonHelloSource = 'print("Hello world")';
const pythonHelloOutput = 'Hello world';
export const plannerMemoryMarker = 'planner-memory-sunrise';
export const smokeApprovalDirective = '@smoke-approve-repository-promotion';
const scenarioNames = new Set(['planner-session', 'artifact', 'python-hello', 'pi-research']);

export function readOption(args, name) {
  const inline = args.find(arg => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }

  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseExecutorCommand(value) {
  const command = String(value).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(command)) {
    throw new Error(`Invalid smoke executor command: ${value}`);
  }
  return command;
}

export function parseScenario(value) {
  const scenario = String(value).trim();
  if (!scenarioNames.has(scenario)) {
    throw new Error(`Invalid smoke scenario: ${value}. Expected one of: ${[...scenarioNames].join(', ')}`);
  }
  return scenario;
}

export function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

export function installPiConfig(input = {}) {
  const repoRoot = input.repoRoot ?? process.cwd();
  const targetHome = input.targetHome ?? homedir();
  const repoSourceDir = join(repoRoot, 'docker', 'pi-config');
  const sourceDir = input.sourceDir
    ?? (existsSync(repoSourceDir) ? repoSourceDir : '/opt/metaclaw/pi-config');
  const targetDir = join(targetHome, '.pi', 'agent');

  for (const fileName of ['models.json', 'settings.json']) {
    const source = join(sourceDir, fileName);
    if (!existsSync(source)) {
      throw new Error(`Missing Pi smoke config file: ${source}`);
    }
  }

  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(sourceDir, 'models.json'), join(targetDir, 'models.json'));
  copyFileSync(join(sourceDir, 'settings.json'), join(targetDir, 'settings.json'));
  return targetDir;
}

export function bootstrapExecutor(input) {
  if (input.executorCommand !== 'pi') {
    return null;
  }

  return installPiConfig({
    repoRoot: input.repoRoot,
    targetHome: input.executorHome,
  });
}

export function buildScenarioScript(scenario) {
  if (scenario === 'planner-session') {
    return [
      `请记住本次会话测试短语是 ${plannerMemoryMarker}。只回复“已记住”，不要创建任务。`,
      '刚才的测试短语是什么？只回复短语，不要查询任务或创建任务。',
      '/exit',
      '',
    ].join('\n');
  }

  if (scenario === 'artifact') {
    return [
      `Create a file named smoke-result.md inside MetaClaw's managed Task workspace. The Runtime will provide the exact authorized target directory to the Executor, so do not ask me for a path. Its content must include this exact line: ${artifactExpectedLine} After creating it, tell me the absolute file path.`,
      smokeApprovalDirective,
      '/exit',
      '',
    ].join('\n');
  }

  if (scenario === 'pi-research') {
    return [
      '请创建一个持久调研任务，不要直接回复：使用 web_search 和 web_fetch 核验 Node.js 官方首页域名、页面标题和首页对 Node.js 的描述，给出带来源引用的调研报告。不要修改工作区。',
      smokeApprovalDirective,
      '/exit',
      '',
    ].join('\n');
  }

  return [
    `请在当前工作区新建 ${pythonHelloFileName}，内容严格为一行 ${pythonHelloSource}。使用 python3 运行该文件，并确认标准输出严格为 ${pythonHelloOutput}。`,
    smokeApprovalDirective,
    '/exit',
    '',
  ].join('\n');
}

export function buildSmokeChildEnv(input) {
  return {
    METACLAW_HOME: input.metaclawHome,
    ANYFUSION_CONFIG_HOME: input.anyFusionConfigHome,
    METACLAW_PLANNER_SESSION_DIR: join(input.metaclawHome, 'anyfusion-planner', 'sessions'),
    METACLAW_PLANNER_SCHEMA_PATH: join(input.repoRoot, 'dist', 'planning-agent-plan-v7.schema.json'),
    ANYFUSION_SMOKE_RUN_ID: input.smokeRunId,
  };
}

export function findPythonCommand() {
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf-8' });
    if (result.status === 0) {
      return command;
    }
  }

  throw new Error('Smoke failed: neither python3 nor python is available for independent verification');
}

export function readAuthoritativeTaskState(metaclawHome, smokeRunId) {
  const dbPath = join(metaclawHome, 'metaclaw.db');
  if (!existsSync(dbPath)) {
    throw new Error(`Smoke failed: authoritative database does not exist: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const tasks = db.prepare(`
      SELECT id, source, smoke_run_id AS smokeRunId, status, title, artifacts_json AS artifactsJson
      FROM tasks
      WHERE smoke_run_id = ?
      ORDER BY created_at, id
    `).all(smokeRunId);
    const taskId = tasks.length === 1 ? tasks[0].id : null;
    return {
      acceptedProposalCount: Number(db.prepare(`
        SELECT COUNT(DISTINCT submission.submission_id) AS count
        FROM planner_proposal_submissions submission
        JOIN kernel_decisions decision ON decision.event_id = submission.event_id
        JOIN tasks task ON task.id = decision.task_id
        WHERE submission.status = 'accepted' AND task.smoke_run_id = ?
      `).get(smokeRunId).count),
      tasks,
      subtasks: db.prepare(`
        SELECT id, task_id AS taskId, status, error, artifacts_json AS artifactsJson
        FROM subtasks
        WHERE task_id = ?
        ORDER BY created_at, id
      `).all(taskId),
      receipts: db.prepare(`
        SELECT attempt_id AS attemptId, task_id AS taskId, subtask_id AS subtaskId,
               agent_class_name AS agentClassName,
               terminal_state AS terminalState, error_code AS errorCode,
               error_detail AS errorDetail, completed_at AS completedAt
        FROM executor_attempt_receipts
        WHERE task_id = ?
        ORDER BY completed_at DESC, attempt_id
      `).all(taskId),
      publications: db.prepare(`
        SELECT id, task_id AS taskId, subtask_id AS subtaskId, status,
               error_summary AS errorSummary
        FROM workspace_publications
        WHERE task_id = ?
        ORDER BY created_at, id
      `).all(taskId),
      dispatchItems: db.prepare(`
        SELECT attempt_id AS attemptId, task_id AS taskId, subtask_id AS subtaskId,
               status, error_summary AS errorSummary
        FROM kernel_dispatch_items
        WHERE task_id = ?
        ORDER BY created_at, attempt_id
      `).all(taskId),
    };
  } finally {
    db.close();
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatAuthoritativeFailure(state) {
  return JSON.stringify({
    acceptedProposalCount: state.acceptedProposalCount,
    tasks: state.tasks,
    subtasks: state.subtasks,
    receipts: state.receipts,
    publications: state.publications,
    dispatchItems: state.dispatchItems,
  });
}

export function buildSmokeConfig(input) {
  const templatePath = input.templatePath ?? join(input.repoRoot, 'docker', 'tui-config.yaml');
  if (!existsSync(templatePath)) {
    throw new Error(`Smoke failed: shell config template does not exist: ${templatePath}`);
  }
  return readFileSync(templatePath, 'utf-8')
    .replace(/^(\s*command:)\s*.*$/m, `$1 ${input.executorCommand}`)
    .replace(/^(\s*timeout:)\s*.*$/m, `$1 ${input.executorTimeout}`)
    .replace(/^(\s*max_duration:)\s*.*$/m, `$1 ${input.executorMaxDuration}`);
}

export function verifyAuthoritativeTaskState(state) {
  if (!state) {
    throw new Error('Smoke failed: authoritative Task state was not provided');
  }
  if (state.acceptedProposalCount !== 1) {
    throw new Error(`Smoke failed: expected exactly one accepted proposal, found ${state.acceptedProposalCount}`);
  }
  if (state.tasks.length !== 1) {
    throw new Error(`Smoke failed: expected exactly one authoritative Task, found ${state.tasks.length}`);
  }

  const task = state.tasks[0];
  if (task.source !== 'system_smoke' || !task.smokeRunId) {
    throw new Error(`Smoke failed: authoritative Task ${task.id} is not owned by a system_smoke run`);
  }
  if (task.status !== 'done') {
    throw new Error([
      `Smoke failed: authoritative Task ${task.id} is ${task.status}, not done.`,
      `Authoritative state: ${formatAuthoritativeFailure(state)}`,
    ].join('\n'));
  }

  const subtasks = state.subtasks.filter(subtask => subtask.taskId === task.id);
  if (subtasks.length === 0) {
    throw new Error(`Smoke failed: authoritative Task ${task.id} has no Subtasks`);
  }
  const unfinishedSubtask = subtasks.find(subtask => subtask.status !== 'done');
  if (unfinishedSubtask) {
    throw new Error(`Smoke failed: authoritative Subtask ${unfinishedSubtask.id} is ${unfinishedSubtask.status}, not done`);
  }

  const latestReceipts = [];
  for (const subtask of subtasks) {
    const latestReceipt = state.receipts.find(receipt => (
      receipt.taskId === task.id && receipt.subtaskId === subtask.id
    ));
    if (!latestReceipt || latestReceipt.terminalState !== 'completed') {
      throw new Error([
        `Smoke failed: latest receipt for Subtask ${subtask.id} is ${latestReceipt?.terminalState ?? 'missing'}, not completed.`,
        `Authoritative state: ${formatAuthoritativeFailure(state)}`,
      ].join('\n'));
    }
    latestReceipts.push(latestReceipt);
  }

  const publications = state.publications.filter(publication => publication.taskId === task.id);
  if (publications.length === 0) {
    throw new Error(`Smoke failed: authoritative Task ${task.id} has no workspace publication`);
  }
  const unfinishedPublication = publications.find(publication => publication.status !== 'integrated');
  if (unfinishedPublication) {
    throw new Error(`Smoke failed: workspace publication ${unfinishedPublication.id} is ${unfinishedPublication.status}, not integrated`);
  }

  const dispatchItems = state.dispatchItems.filter(item => item.taskId === task.id);
  if (dispatchItems.length === 0) {
    throw new Error(`Smoke failed: authoritative Task ${task.id} has no dispatch items`);
  }
  const unfinishedDispatch = dispatchItems.find(item => item.status !== 'terminal');
  if (unfinishedDispatch) {
    throw new Error(`Smoke failed: dispatch ${unfinishedDispatch.attemptId} is ${unfinishedDispatch.status}, not terminal`);
  }

  return {
    taskId: task.id,
    artifacts: subtasks.flatMap(subtask => parseJsonArray(subtask.artifactsJson)),
    executorNames: [...new Set(latestReceipts.map(receipt => String(receipt.agentClassName)))],
  };
}

export function verifyArtifactScenario(input) {
  const authoritative = verifyAuthoritativeTaskState(input.authoritativeState);
  const artifactPath = authoritative.artifacts
    .map(String)
    .find(artifact => artifact.replaceAll('\\', '/').endsWith('/smoke-result.md'));
  if (!artifactPath) {
    throw new Error('Smoke failed: authoritative Subtask artifacts do not include smoke-result.md');
  }

  if (!existsSync(artifactPath)) {
    throw new Error(`Smoke failed: artifact path does not exist: ${artifactPath}`);
  }

  const content = readFileSync(artifactPath, 'utf-8');
  if (!content.includes(artifactExpectedLine)) {
    throw new Error(`Smoke failed: artifact content does not include "${artifactExpectedLine}"`);
  }

  if (/Task Memory Cards/.test(input.output) || /娴犺濮熺拋鏉跨箓閸楋紕澧栭敍鍦盿sk Memory Cards/.test(input.output)) {
    throw new Error('Smoke failed: current task was recalled as task memory during its first execution');
  }

  if (/Summary:\s*Created file:\s*``/.test(input.output) || /閹芥顩?\s*瀹告彃鍨卞鐑樻瀮娴犺绱癭`/.test(input.output)) {
    throw new Error('Smoke failed: task summary used an empty quoted artifact path');
  }

  return { artifactPath, taskId: authoritative.taskId, executorNames: authoritative.executorNames };
}

export function verifyPythonHelloScenario(input) {
  const authoritative = verifyAuthoritativeTaskState(input.authoritativeState);
  const pythonFile = authoritative.artifacts
    .map(String)
    .find(artifact => artifact.replaceAll('\\', '/').endsWith(`/${pythonHelloFileName}`));
  if (!pythonFile) {
    throw new Error(`Smoke failed: authoritative Subtask artifacts do not include ${pythonHelloFileName}`);
  }
  if (!existsSync(pythonFile)) {
    throw new Error(`Smoke failed: published artifact does not exist: ${pythonFile}`);
  }
  const source = readFileSync(pythonFile, 'utf-8').trimEnd();
  if (source !== pythonHelloSource) {
    throw new Error(`Smoke failed: ${pythonFile} content was ${JSON.stringify(source)}, expected ${JSON.stringify(pythonHelloSource)}`);
  }

  const pythonCommand = findPythonCommand();
  const result = spawnSync(pythonCommand, [pythonFile], {
    cwd: input.workdir,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Smoke failed: independent Python run failed with exit code ${result.status}: ${result.stderr ?? ''}`);
  }

  if ((result.stdout ?? '').trim() !== pythonHelloOutput) {
    throw new Error(`Smoke failed: independent Python stdout was "${(result.stdout ?? '').trim()}"`);
  }

  return {
    artifactPath: pythonFile,
    pythonCommand,
    taskId: authoritative.taskId,
    executorNames: authoritative.executorNames,
  };
}

export function verifyPiResearchScenario(input) {
  const authoritative = verifyAuthoritativeTaskState(input.authoritativeState);
  if (!authoritative.executorNames.includes('pi-agent')) {
    throw new Error(
      `Smoke failed: pi-research expected a completed pi-agent receipt, observed ${authoritative.executorNames.join(', ') || 'none'}`,
    );
  }
  return {
    taskId: authoritative.taskId,
    executorNames: authoritative.executorNames,
  };
}

export function verifyPlannerSessionScenario(input) {
  if (input.sessionFiles.length !== 1) {
    throw new Error(
      `Smoke failed: expected exactly one persisted AnyFusion-Pi session file for two turns, found ${input.sessionFiles.length}`,
    );
  }
  const recall = input.interactions.find(row => String(row.userInput ?? '').includes('刚才的测试短语是什么'));
  if (!recall || !String(recall.systemOutput ?? '').includes(plannerMemoryMarker)) {
    throw new Error(`Smoke failed: the second Planner reply did not recall the marker from its persisted AnyFusion-Pi session. Observed output: ${String(recall?.systemOutput ?? '<missing>')}`);
  }
  return { nativeSessionPath: input.sessionFiles[0] };
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    encoding: 'utf-8',
    maxBuffer: 100 * 1024 * 1024,
    shell: options.shell ?? false,
  });

  if (options.logPath) {
    writeFileSync(options.logPath, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }

  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    const termination = result.error?.message
      ?? (result.signal ? `terminated by ${result.signal}` : `exit code ${result.status}`);
    throw new Error(`${command} ${args.join(' ')} failed: ${termination}`);
  }

  return result;
}

export function cleanupOwnedSmokeArtifacts(input) {
  if (input.keepArtifacts || input.managedByHost) return;
  for (const [path, owned] of [
    [input.metaclawHome, input.ownsMetaclawHome],
    [input.executorHome, input.ownsExecutorHome],
    [input.workdir, input.ownsWorkdir],
    [input.scriptDir, input.ownsScriptDir],
  ]) {
    if (owned) rmSync(path, { recursive: true, force: true });
  }
}

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function smokeTaskRow(db, smokeRunId) {
  return db.prepare(`
    SELECT id, project_id AS projectId, source, smoke_run_id AS smokeRunId, status
    FROM tasks WHERE smoke_run_id = ?
  `).get(smokeRunId);
}

function smokeTaskQuiescence(db, taskId) {
  const checks = {
    dispatchItems: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM kernel_dispatch_items
      WHERE task_id = ? AND status IN ('pending_launch', 'launching', 'running', 'cancelling', 'uncertain')
    `).get(taskId).count),
    publications: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM workspace_publications
      WHERE task_id = ? AND status IN (
        'awaiting_approval', 'pending', 'applying', 'conflicted', 'cancelling', 'uncertain'
      )
    `).get(taskId).count),
    sandboxes: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM attempt_sandboxes
      WHERE task_id = ? AND status <> 'removed'
    `).get(taskId).count),
    leases: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM resource_leases
      WHERE task_id = ? AND released_at IS NULL
    `).get(taskId).count),
    workUnits: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM work_units
      WHERE claimed_task_id = ? AND state IN ('starting', 'claimed', 'running', 'waiting', 'draining')
    `).get(taskId).count),
  };
  return {
    quiet: Object.values(checks).every(count => count === 0),
    checks,
  };
}

function runSmokeCommandScript(input, lines, label) {
  const scriptPath = join(input.scriptDir, `${label}.txt`);
  const logPath = join(input.scriptDir, `${label}.log`);
  writeFileSync(scriptPath, [...lines, '/exit', ''].join('\n'));
  const result = run('node', [
    join(input.repoRoot, 'dist/index.js'),
    '--project', input.workdir,
    '--script', scriptPath,
  ], {
    cwd: input.workdir,
    env: input.childEnv,
    logPath,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (output.includes('操作失败:')) {
    throw new Error(`Smoke ${label} command failed: ${output.slice(-2_000)}`);
  }
  return output;
}

export function smokeTaskOwnedRuntimePaths(metaclawHome, projectId, taskId) {
  return [
    join(metaclawHome, 'project-worktrees', projectId, 'workspaces', taskId),
  ];
}

export function finalizeSmokeTask(input) {
  const dbPath = join(input.metaclawHome, 'metaclaw.db');
  if (!existsSync(dbPath)) return { taskId: null, purged: false, diagnostics: { databaseMissing: true } };
  let db = new Database(dbPath);
  let task = smokeTaskRow(db, input.smokeRunId);
  if (!task) {
    db.close();
    return { taskId: null, purged: false, diagnostics: { taskMissing: true } };
  }
  if (task.source !== 'system_smoke' || task.smokeRunId !== input.smokeRunId) {
    db.close();
    throw new Error(`Smoke cleanup refused non-owned Task ${task.id}`);
  }
  const taskId = task.id;
  const workspaceRows = db.prepare(`
    SELECT root_uri AS rootUri, managed_repository_uri AS managedRepositoryUri
    FROM workspace_records WHERE task_id = ?
  `).all(taskId);
  db.close();

  if (!['done', 'archived', 'cancelled'].includes(task.status)) {
    runSmokeCommandScript(input, [`/task cancel ${taskId}`], 'smoke-cancel');
  }

  let quiescence = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    db = new Database(dbPath, { readonly: true });
    task = smokeTaskRow(db, input.smokeRunId);
    quiescence = task ? smokeTaskQuiescence(db, taskId) : { quiet: true, checks: {} };
    const terminal = task && ['done', 'archived', 'cancelled'].includes(task.status);
    db.close();
    if (!task || (terminal && quiescence.quiet)) break;
    waitSync(250);
  }
  if (!task || !['done', 'archived', 'cancelled'].includes(task.status) || !quiescence?.quiet) {
    throw new Error(`Smoke Task ${taskId} did not become terminal and quiescent: ${JSON.stringify(quiescence?.checks ?? {})}`);
  }

  runSmokeCommandScript(input, [`/task purge ${taskId} --confirm ${taskId}`], 'smoke-purge');
  db = new Database(dbPath, { readonly: true });
  try {
    if (db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)) {
      throw new Error(`Smoke purge left Task ${taskId} in the database`);
    }
    const residueTables = [
      'subtasks',
      'task_events',
      'executor_attempt_receipts',
      'kernel_events',
      'kernel_decisions',
      'kernel_dispatch_items',
      'workspace_records',
      'workspace_publications',
      'resource_leases',
      'attempt_sandboxes',
      'interactions',
      'task_memory_cards',
    ];
    for (const table of residueTables) {
      const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE task_id = ?`).get(taskId).count);
      if (count !== 0) throw new Error(`Smoke purge left ${count} ${table} rows for ${taskId}`);
    }
    const foreignKeyErrors = db.pragma('foreign_key_check');
    if (foreignKeyErrors.length > 0) {
      throw new Error(`Smoke purge failed foreign_key_check: ${JSON.stringify(foreignKeyErrors)}`);
    }
  } finally {
    db.close();
  }
  for (const row of workspaceRows) {
    for (const value of [row.rootUri, row.managedRepositoryUri]) {
      if (!value) continue;
      const path = String(value).startsWith('file:')
        ? fileURLToPath(String(value))
        : String(value);
      if (existsSync(path)) throw new Error(`Smoke purge left workspace path: ${path}`);
    }
  }
  for (const path of smokeTaskOwnedRuntimePaths(input.metaclawHome, task.projectId, taskId)) {
    if (existsSync(path)) throw new Error(`Smoke purge left task-owned runtime path: ${path}`);
  }
  return { taskId, purged: true, diagnostics: quiescence.checks };
}

export function recordSmokeRunAudit(input) {
  const dbPath = join(input.metaclawHome, 'metaclaw.db');
  if (!existsSync(dbPath)) return;
  const db = new Database(dbPath);
  try {
    const table = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'smoke_run_audits'
    `).get();
    if (!table) return;
    db.transaction(() => {
      db.prepare(`
        INSERT INTO smoke_run_audits (
          run_id, scenario, executor_id, result, diagnostics_json, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          executor_id = excluded.executor_id,
          result = excluded.result,
          diagnostics_json = excluded.diagnostics_json,
          completed_at = excluded.completed_at
      `).run(
        input.runId,
        input.scenario,
        input.executorId,
        input.result,
        JSON.stringify(input.diagnostics),
        input.startedAt,
        input.completedAt,
      );
      db.prepare(`
        DELETE FROM smoke_run_audits
        WHERE run_id NOT IN (
          SELECT run_id FROM smoke_run_audits
          ORDER BY completed_at DESC, run_id DESC
          LIMIT 20
        )
      `).run();
    })();
  } finally {
    db.close();
  }
}

function readPlannerDiagnostics(repoRoot, metaclawHome) {
  const dbPath = join(metaclawHome, 'metaclaw.db');
  if (!existsSync(dbPath)) return '';
  const source = [
    "import Database from 'better-sqlite3';",
    "const db = new Database(process.argv[1], { readonly: true });",
    "const rows = db.prepare('SELECT status, attempt_count, error_summary FROM planner_runs ORDER BY created_at DESC LIMIT 3').all();",
    "const decisions = db.prepare('SELECT event_type, action, reason FROM kernel_decisions ORDER BY created_at DESC LIMIT 5').all();",
    "const attempts = db.prepare('SELECT terminal_state, error_code, error_detail, failure_json, substr(raw_response, 1, 1000) AS response FROM executor_attempt_receipts ORDER BY completed_at DESC LIMIT 3').all();",
    "const sandboxes = db.prepare('SELECT status, exit_code, cleanup_status, cleanup_error FROM attempt_sandboxes ORDER BY created_at DESC LIMIT 3').all();",
    'process.stdout.write(JSON.stringify({ plannerRuns: rows, decisions, attempts, sandboxes }));',
  ].join(' ');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, dbPath], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
  return result.status === 0 ? String(result.stdout ?? '').trim() : '';
}

function readPlannerInteractions(repoRoot, metaclawHome) {
  const dbPath = join(metaclawHome, 'metaclaw.db');
  const source = [
    "import Database from 'better-sqlite3';",
    "const db = new Database(process.argv[1], { readonly: true });",
    "const rows = db.prepare('SELECT user_input AS userInput, system_output AS systemOutput FROM interactions ORDER BY created_at ASC').all();",
    'process.stdout.write(JSON.stringify(rows));',
  ].join(' ');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, dbPath], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Smoke failed: could not read Planner interaction evidence: ${result.stderr ?? ''}`);
  }
  return JSON.parse(String(result.stdout ?? '[]'));
}

export function runSmoke(rawArgs = process.argv.slice(2), env = process.env) {
  if (env.METACLAW_SMOKE_NATIVE !== 'true' && env.METACLAW_SMOKE_IN_DOCKER !== 'true') {
    runDockerSmoke(rawArgs, env);
    return;
  }
  const repoRoot = resolve(env.METACLAW_SMOKE_REPO_ROOT ?? process.cwd());
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    process.stdout.write(buildHelp());
    return;
  }

  const executorCommand = parseExecutorCommand(
    readOption(rawArgs, '--executor') ?? env.METACLAW_SMOKE_EXECUTOR ?? 'codex',
  );
  const scenario = parseScenario(
    readOption(rawArgs, '--scenario') ?? env.METACLAW_SMOKE_SCENARIO ?? 'planner-session',
  );
  const executorTimeout = parsePositiveInteger(
    readOption(rawArgs, '--timeout') ?? env.METACLAW_SMOKE_TIMEOUT,
    900,
  );
  const executorMaxDuration = parsePositiveInteger(
    readOption(rawArgs, '--max-duration') ?? env.METACLAW_SMOKE_MAX_DURATION,
    3600,
  );
  const keepArtifacts = env.METACLAW_SMOKE_KEEP_ARTIFACTS === 'true';
  const managedByHost = env.METACLAW_SMOKE_MANAGED_BY_HOST === 'true';
  const smokeRunId = env.ANYFUSION_SMOKE_RUN_ID?.trim()
    || `smoke_${Date.now()}_${randomUUID()}`;
  const startedAt = new Date().toISOString();
  let smokePassed = false;
  let executorId = null;
  let cleanupResult = { taskId: null, purged: false, diagnostics: {} };
  let cleanupFailure = null;

  const smokeRoot = env.METACLAW_SMOKE_ROOT ? resolve(env.METACLAW_SMOKE_ROOT) : tmpdir();
  mkdirSync(smokeRoot, { recursive: true });
  const ownsMetaclawHome = !env.METACLAW_HOME;
  const ownsExecutorHome = !env.METACLAW_SMOKE_EXECUTOR_HOME;
  const ownsWorkdir = !env.METACLAW_SMOKE_WORKDIR;
  const ownsScriptDir = !env.METACLAW_SMOKE_SCRIPT_DIR;
  const metaclawHome = env.METACLAW_HOME
    ? resolve(env.METACLAW_HOME)
    : mkdtempSync(join(smokeRoot, 'metaclaw-smoke-home-'));
  const executorHome = env.METACLAW_SMOKE_EXECUTOR_HOME
    ? resolve(env.METACLAW_SMOKE_EXECUTOR_HOME)
    : mkdtempSync(join(smokeRoot, 'metaclaw-smoke-executor-home-'));
  const workdir = env.METACLAW_SMOKE_WORKDIR
    ? resolve(env.METACLAW_SMOKE_WORKDIR)
    : mkdtempSync(join(smokeRoot, 'metaclaw-smoke-work-'));
  const scriptDir = env.METACLAW_SMOKE_SCRIPT_DIR
    ? resolve(env.METACLAW_SMOKE_SCRIPT_DIR)
    : mkdtempSync(join(smokeRoot, 'metaclaw-smoke-script-'));
  for (const directory of [metaclawHome, executorHome, workdir, scriptDir]) {
    mkdirSync(directory, { recursive: true });
  }
  const scriptPath = join(scriptDir, 'script.txt');
  const outputPath = join(scriptDir, 'metaclaw-output.log');
  const childEnv = buildSmokeChildEnv({
    metaclawHome,
    anyFusionConfigHome: resolve(
      env.ANYFUSION_CONFIG_HOME ?? join(homedir(), '.config', 'anyfusion'),
    ),
    repoRoot,
    smokeRunId,
  });

  try {
    const runtimeConfigPath = join(metaclawHome, 'config.yaml');
    if (ownsMetaclawHome || managedByHost) {
      writeFileSync(runtimeConfigPath, buildSmokeConfig({
        repoRoot,
        templatePath: env.METACLAW_SMOKE_CONFIG_TEMPLATE,
        executorCommand,
        executorTimeout,
        executorMaxDuration,
      }));
    } else if (!existsSync(runtimeConfigPath)) {
      throw new Error(`Smoke failed: current Runtime config does not exist: ${runtimeConfigPath}`);
    }

    bootstrapExecutor({ executorCommand, executorHome, repoRoot });
    writeFileSync(scriptPath, buildScenarioScript(scenario));

    if (env.METACLAW_SMOKE_SKIP_BUILD !== 'true') {
      run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
        cwd: repoRoot,
        shell: process.platform === 'win32',
      });
    }
    const plannerSessionDir = join(metaclawHome, 'anyfusion-planner', 'sessions');

    const runResult = run('node', [
      join(repoRoot, 'dist/index.js'),
      '--project', workdir,
      '--script', scriptPath,
    ], {
      cwd: workdir,
      env: childEnv,
      logPath: outputPath,
    });

    const output = `${runResult.stdout ?? ''}\n${runResult.stderr ?? ''}`;
    const authoritativeState = scenario === 'planner-session'
      ? null
      : readAuthoritativeTaskState(metaclawHome, smokeRunId);

    const verification = scenario === 'planner-session'
      ? verifyPlannerSessionScenario({
        interactions: readPlannerInteractions(repoRoot, metaclawHome),
        sessionFiles: findFiles(
          plannerSessionDir,
          filePath => filePath.endsWith('.jsonl'),
        ),
      })
      : scenario === 'artifact'
        ? verifyArtifactScenario({ output, workdir, authoritativeState })
        : scenario === 'python-hello'
          ? verifyPythonHelloScenario({ output, workdir, authoritativeState })
          : verifyPiResearchScenario({ authoritativeState });
    executorId = verification.executorNames?.[0] ?? executorCommand;
    smokePassed = true;

    process.stdout.write([
      scenario === 'planner-session'
        ? 'MetaClaw native Planner session smoke passed.'
        : 'MetaClaw real task smoke passed.',
      `Executor: ${verification.executorNames?.join(', ') ?? executorCommand}`,
      `Scenario: ${scenario}`,
      scenario === 'planner-session'
        ? `Native session: ${verification.nativeSessionPath}`
        : scenario === 'pi-research'
          ? `Task: ${verification.taskId}`
          : `Artifact: ${verification.artifactPath}`,
      `Workdir: ${workdir}`,
      '',
    ].join('\n'));
  } catch (error) {
    const plannerDiagnostics = readPlannerDiagnostics(repoRoot, metaclawHome);
    if (plannerDiagnostics) process.stderr.write(`Planner diagnostics: ${plannerDiagnostics}\n`);
    process.stderr.write([
      keepArtifacts
        ? 'Smoke failed; diagnostics were preserved:'
        : 'Smoke failed; generated artifacts will be removed. Set METACLAW_SMOKE_KEEP_ARTIFACTS=true to preserve them:',
      ...(keepArtifacts ? [`  METACLAW_HOME: ${metaclawHome}`] : []),
      `  Workdir: ${workdir}`,
      ...(keepArtifacts ? [`  Output: ${outputPath}`] : []),
      '',
    ].join('\n'));
    throw error;
  } finally {
    if (scenario !== 'planner-session') {
      try {
        cleanupResult = finalizeSmokeTask({
          repoRoot,
          metaclawHome,
          scriptDir,
          workdir,
          smokeRunId,
          childEnv,
        });
      } catch (error) {
        cleanupFailure = error instanceof Error ? error : new Error(String(error));
        process.stderr.write(`Smoke cleanup failed: ${cleanupFailure.message}\n`);
      }
    }
    recordSmokeRunAudit({
      metaclawHome,
      runId: smokeRunId,
      scenario,
      executorId,
      result: smokePassed && !cleanupFailure ? 'passed' : 'failed',
      diagnostics: {
        taskId: cleanupResult.taskId,
        purged: cleanupResult.purged,
        cleanup: cleanupResult.diagnostics,
        cleanupError: cleanupFailure?.message.slice(0, 500) ?? null,
      },
      startedAt,
      completedAt: new Date().toISOString(),
    });
    cleanupOwnedSmokeArtifacts({
      keepArtifacts,
      managedByHost,
      metaclawHome,
      executorHome,
      workdir,
      scriptDir,
      ownsMetaclawHome,
      ownsExecutorHome,
      ownsWorkdir,
      ownsScriptDir,
    });
    if (smokePassed && cleanupFailure) throw cleanupFailure;
  }
}

function runDockerSmoke(rawArgs, env) {
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    process.stdout.write(buildHelp());
    return;
  }
  const repoRoot = resolve(process.cwd());
  const anyFusionPiRoot = resolve(
    env.ANYFUSION_PI_ROOT ?? join(repoRoot, '..', 'AnyFusion-Pi'),
  );
  if (!existsSync(join(anyFusionPiRoot, 'package.json'))) {
    throw new Error(`Smoke requires the sibling AnyFusion-Pi repository at ${anyFusionPiRoot}`);
  }
  const scenario = parseScenario(
    readOption(rawArgs, '--scenario') ?? env.METACLAW_SMOKE_SCENARIO ?? 'planner-session',
  );
  const plannerTimeoutMs = parsePositiveInteger(env.METACLAW_PLANNER_TIMEOUT_MS, 180_000);
  const smokeRoot = mkdtempSync(join(tmpdir(), 'metaclaw-docker-smoke-'));
  const dataRoot = join(smokeRoot, 'data');
  const workspaceRoot = join(smokeRoot, 'workspace');
  const auxiliaryRoot = join(smokeRoot, 'auxiliary');
  for (const directory of [dataRoot, workspaceRoot, auxiliaryRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  const suffix = `${process.pid}-${Date.now()}`;
  const control = `metaclaw-smoke-control-${suffix}`;
  const runtimeImage = 'metaclaw-runtime';
  const mounts = [
    ['docker/planner-pi.env', '/run/metaclaw/env/planner-pi.env'],
    ['docker/executor-codex.env', '/run/metaclaw/env/executor-codex.env'],
    ['docker/executor-pi.env', '/run/metaclaw/env/executor-pi.env'],
  ];
  for (const [hostPath] of mounts) {
    if (!existsSync(join(repoRoot, hostPath))) {
      throw new Error(`Smoke requires ${hostPath}; copy the corresponding .env.example and configure the provider.`);
    }
  }

  const keepArtifacts = env.METACLAW_SMOKE_KEEP_ARTIFACTS === 'true';
  try {
    run('docker', [
      'build',
      '--build-context', `anyfusion-pi=${anyFusionPiRoot}`,
      '-f', 'docker/Dockerfile.runtime',
      '-t', runtimeImage,
      '.',
    ], { cwd: repoRoot });
    const createArgs = [
      'create', '--name', control, '--network', 'bridge',
      '--workdir', '/workspace',
      '--mount', `type=bind,src=${workspaceRoot},dst=/workspace`,
      '--mount', `type=bind,src=${dataRoot},dst=/data`,
      '--mount', `type=bind,src=${auxiliaryRoot},dst=/smoke`,
      ...mounts.flatMap(([hostPath, containerPath]) => [
        '--mount', `type=bind,src=${join(repoRoot, hostPath)},dst=${containerPath},readonly`,
      ]),
      '-e', 'METACLAW_SMOKE_IN_DOCKER=true',
      '-e', 'METACLAW_SMOKE_SKIP_BUILD=true',
      '-e', 'METACLAW_SMOKE_REPO_ROOT=/app',
      '-e', 'METACLAW_SMOKE_CONFIG_TEMPLATE=/opt/metaclaw/default-config.yaml',
      '-e', 'METACLAW_SMOKE_ROOT=/smoke',
      '-e', 'METACLAW_SMOKE_EXECUTOR_HOME=/smoke/executor-home',
      '-e', 'METACLAW_SMOKE_SCRIPT_DIR=/smoke/script',
      '-e', 'METACLAW_SMOKE_WORKDIR=/workspace',
      '-e', 'METACLAW_SMOKE_MANAGED_BY_HOST=true',
      '-e', 'METACLAW_HOME=/data/metaclaw',
      '-e', `METACLAW_PLANNER_TIMEOUT_MS=${plannerTimeoutMs}`,
      '-e', 'METACLAW_EXECUTOR_BACKEND=worktree',
      runtimeImage,
      'node', '/app/scripts/smoke-metaclaw-real-task.mjs',
      ...rawArgs,
    ];
    run('docker', createArgs, { cwd: repoRoot });
    const result = run('docker', ['start', '--attach', control], { cwd: repoRoot });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
  } finally {
    spawnSync('docker', ['rm', '-f', control], { cwd: repoRoot, encoding: 'utf8' });
    if (!keepArtifacts) {
      rmSync(smokeRoot, { recursive: true, force: true });
    } else {
      process.stderr.write(`Docker smoke diagnostics preserved at: ${smokeRoot}\n`);
    }
  }
}

function buildHelp() {
  return [
    'Usage: npm run smoke:metaclaw -- [--executor <command>] [--scenario <planner-session|artifact|python-hello|pi-research>] [--timeout <seconds>] [--max-duration <seconds>]',
    '',
    'Environment variables:',
    '  METACLAW_SMOKE_EXECUTOR      Executor command to place in the isolated config. It does not override Planner routing.',
    '  METACLAW_SMOKE_SCENARIO      Scenario to run. Defaults to planner-session (two-turn AnyFusion Planner memory).',
    '  METACLAW_SMOKE_TIMEOUT       Continuous no-output timeout in seconds.',
    '  METACLAW_SMOKE_MAX_DURATION  Legacy max_duration value in seconds.',
    '  METACLAW_PLANNER_TIMEOUT_MS   Planner RPC timeout forwarded to the Runtime; Docker smoke defaults to 180000.',
    '  METACLAW_SMOKE_KEEP_ARTIFACTS Set to true to preserve smoke data after completion or failure.',
    '  METACLAW_SMOKE_IN_DOCKER      Internal recursion guard; ordinary smoke runs create the control container automatically.',
    '',
    'Examples:',
    '  npm run smoke:metaclaw',
    '  npm run smoke:metaclaw -- --executor pi --scenario pi-research',
    '  METACLAW_SMOKE_EXECUTOR=pi METACLAW_SMOKE_SCENARIO=pi-research npm run smoke:metaclaw',
    '',
  ].join('\n');
}

function findFiles(root, predicate) {
  const results = [];
  for (const entry of readdirSync(root)) {
    const entryPath = join(root, entry);
    const stats = statSync(entryPath);
    if (stats.isDirectory()) {
      results.push(...findFiles(entryPath, predicate));
      continue;
    }

    if (stats.isFile() && predicate(entryPath)) {
      results.push(entryPath);
    }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSmoke();
}
