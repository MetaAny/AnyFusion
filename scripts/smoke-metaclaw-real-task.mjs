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
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const artifactExpectedLine = 'MetaClaw real task smoke passed.';
const pythonHelloFileName = 'hello.py';
const pythonHelloSource = 'print("Hello world")';
const pythonHelloOutput = 'Hello world';
export const plannerMemoryMarker = 'planner-memory-sunrise';
const scenarioNames = new Set(['planner-session', 'artifact', 'python-hello']);

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
      '/exit',
      '',
    ].join('\n');
  }

  return [
    `请在当前工作区新建 ${pythonHelloFileName}，内容严格为一行 ${pythonHelloSource}。使用 python3 运行该文件，并确认标准输出严格为 ${pythonHelloOutput}。`,
    '/exit',
    '',
  ].join('\n');
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

export function readAuthoritativeTaskState(metaclawHome) {
  const dbPath = join(metaclawHome, 'metaclaw.db');
  if (!existsSync(dbPath)) {
    throw new Error(`Smoke failed: authoritative database does not exist: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      acceptedProposalCount: Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM planner_proposal_submissions
        WHERE status = 'accepted'
      `).get().count),
      tasks: db.prepare(`
        SELECT id, status, title, artifacts_json AS artifactsJson
        FROM tasks
        ORDER BY created_at, id
      `).all(),
      subtasks: db.prepare(`
        SELECT id, task_id AS taskId, status, error, artifacts_json AS artifactsJson
        FROM subtasks
        ORDER BY created_at, id
      `).all(),
      receipts: db.prepare(`
        SELECT attempt_id AS attemptId, task_id AS taskId, subtask_id AS subtaskId,
               terminal_state AS terminalState, error_code AS errorCode,
               error_detail AS errorDetail, completed_at AS completedAt
        FROM executor_attempt_receipts
        ORDER BY completed_at DESC, attempt_id
      `).all(),
      publications: db.prepare(`
        SELECT id, task_id AS taskId, subtask_id AS subtaskId, status,
               error_summary AS errorSummary
        FROM workspace_publications
        ORDER BY created_at, id
      `).all(),
      dispatchItems: db.prepare(`
        SELECT attempt_id AS attemptId, task_id AS taskId, subtask_id AS subtaskId,
               status, error_summary AS errorSummary
        FROM kernel_dispatch_items
        ORDER BY created_at, attempt_id
      `).all(),
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

  return { artifactPath, taskId: authoritative.taskId };
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

  return { artifactPath: pythonFile, pythonCommand, taskId: authoritative.taskId };
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
  if (env.METACLAW_SMOKE_IN_DOCKER !== 'true') {
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

  const smokeRoot = env.METACLAW_SMOKE_ROOT ? resolve(env.METACLAW_SMOKE_ROOT) : tmpdir();
  mkdirSync(smokeRoot, { recursive: true });
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
  let succeeded = false;

  try {
    writeFileSync(join(metaclawHome, 'config.yaml'), buildSmokeConfig({
      repoRoot,
      templatePath: env.METACLAW_SMOKE_CONFIG_TEMPLATE,
      executorCommand,
      executorTimeout,
      executorMaxDuration,
    }));

    bootstrapExecutor({ executorCommand, executorHome, repoRoot });
    writeFileSync(scriptPath, buildScenarioScript(scenario));

    if (env.METACLAW_SMOKE_SKIP_BUILD !== 'true') {
      run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
        cwd: repoRoot,
        shell: process.platform === 'win32',
      });
    }
    const plannerSessionDir = join(metaclawHome, 'anyfusion-planner', 'sessions');
    const childEnv = {
      METACLAW_HOME: metaclawHome,
      METACLAW_PLANNER_SESSION_DIR: plannerSessionDir,
      METACLAW_PLANNER_SCHEMA_PATH: join(repoRoot, 'dist', 'planning-agent-plan-v7.schema.json'),
    };
    if (executorCommand === 'pi') {
      childEnv.HOME = executorHome;
      childEnv.USERPROFILE = executorHome;
    }

    const runResult = run('node', [join(repoRoot, 'dist/index.js'), '--script', scriptPath], {
      cwd: workdir,
      env: childEnv,
      logPath: outputPath,
    });

    const output = `${runResult.stdout ?? ''}\n${runResult.stderr ?? ''}`;
    if (executorCommand === 'pi' && !output.includes('pi-agent')) {
      process.stderr.write(output);
      throw new Error('Smoke failed: expected route/execution output to mention pi-agent');
    }

    const authoritativeState = scenario === 'planner-session'
      ? null
      : readAuthoritativeTaskState(metaclawHome);

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
        : verifyPythonHelloScenario({ output, workdir, authoritativeState });

    process.stdout.write([
      scenario === 'planner-session'
        ? 'MetaClaw native Planner session smoke passed.'
        : 'MetaClaw real task smoke passed.',
      `Executor: ${executorCommand}`,
      `Scenario: ${scenario}`,
      scenario === 'planner-session'
        ? `Native session: ${verification.nativeSessionPath}`
        : `Artifact: ${verification.artifactPath}`,
      `Workdir: ${workdir}`,
      '',
    ].join('\n'));
    succeeded = true;
  } catch (error) {
    const plannerDiagnostics = readPlannerDiagnostics(repoRoot, metaclawHome);
    if (plannerDiagnostics) process.stderr.write(`Planner diagnostics: ${plannerDiagnostics}\n`);
    process.stderr.write([
      'Smoke failed; diagnostics were preserved:',
      `  METACLAW_HOME: ${metaclawHome}`,
      `  Workdir: ${workdir}`,
      `  Output: ${outputPath}`,
      '',
    ].join('\n'));
    throw error;
  } finally {
    if (succeeded && env.METACLAW_SMOKE_MANAGED_BY_HOST !== 'true') {
      rmSync(metaclawHome, { recursive: true, force: true });
      rmSync(executorHome, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
      rmSync(scriptDir, { recursive: true, force: true });
    }
  }
}

function runDockerSmoke(rawArgs, env) {
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    process.stdout.write(buildHelp());
    return;
  }
  const repoRoot = resolve(process.cwd());
  const anyFusionPiRoot = resolve(repoRoot, '..', 'AnyFusion-Pi');
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

  let succeeded = false;
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
    succeeded = true;
  } finally {
    spawnSync('docker', ['rm', '-f', control], { cwd: repoRoot, encoding: 'utf8' });
    if (succeeded) {
      rmSync(smokeRoot, { recursive: true, force: true });
    } else {
      process.stderr.write(`Docker smoke diagnostics preserved at: ${smokeRoot}\n`);
    }
  }
}

function buildHelp() {
  return [
    'Usage: npm run smoke:metaclaw -- [--executor <command>] [--scenario <planner-session|artifact|python-hello>] [--timeout <seconds>] [--max-duration <seconds>]',
    '',
    'Environment variables:',
    '  METACLAW_SMOKE_EXECUTOR      Executor command to place in the isolated config. Defaults to codex.',
    '  METACLAW_SMOKE_SCENARIO      Scenario to run. Defaults to planner-session (two-turn AnyFusion Planner memory).',
    '  METACLAW_SMOKE_TIMEOUT       Continuous no-output timeout in seconds.',
    '  METACLAW_SMOKE_MAX_DURATION  Legacy max_duration value in seconds.',
    '  METACLAW_PLANNER_TIMEOUT_MS   Planner RPC timeout forwarded to the Runtime; Docker smoke defaults to 180000.',
    '  METACLAW_SMOKE_IN_DOCKER      Internal recursion guard; ordinary smoke runs create the control container automatically.',
    '',
    'Examples:',
    '  npm run smoke:metaclaw',
    '  npm run smoke:metaclaw -- --executor pi --scenario python-hello',
    '  METACLAW_SMOKE_EXECUTOR=pi METACLAW_SMOKE_SCENARIO=python-hello npm run smoke:metaclaw',
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
