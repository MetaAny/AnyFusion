// CLI entrypoint that assembles storage, runtime modules, gateway processes, and the default AnyFusion Planner TUI.
import { resolve } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { createDatabase } from './storage/database.js';
import { TaskRepo } from './storage/task-repo.js';
import { PreferenceRepo } from './storage/preference-repo.js';
import { TaskSearchIndexRepo } from './storage/task-search-index-repo.js';
import { TaskEngine } from './task/task-engine.js';
import { MemoryEngine } from './memory/memory-engine.js';
import { OrchestrationEngine } from './guidance/orchestration.js';
import { ContextRecaller } from './memory/context-recaller.js';
import { loadConfig } from './utils/config.js';
import { resolveMetaclawDir } from './utils/paths.js';
import { renderApp } from './tui/app.js';
import { parseCliArgs } from './cli/args.js';
import { runScriptedSessionFile } from './session/scripted-session.js';
import { createNotificationService } from './notifications/feishu.js';
import { nanoid } from 'nanoid';
import { MetaclawGatewayServer } from './gateway/server.js';
import { runGatewayClientUi } from './gateway/client-ui.js';
import { resolveGatewaySocketPath } from './gateway/gateway-paths.js';
import { MarkdownPreviewServer } from './integrations/markdown-preview.js';
import { runGatewaySetup } from './gateway/setup.js';
import { startFeishuRuntimeBridge } from './gateway/feishu-runtime.js';
import { runGatewayPairingCommand } from './gateway/pairing-cli.js';
import { formatGatewayDoctorChecks, runGatewayDoctor } from './gateway/doctor.js';
import { MetaclawSession } from './session/metaclaw-session.js';
import { PlannerTuiBridge } from './tui-bridge/planner-tui-bridge.js';
import { runPlannerTuiProcess } from './tui-bridge/planner-tui-process.js';
import { runExecutorCli } from './cli/executor-cli.js';
import { ProjectRepo } from './storage/project-repo.js';
import { ProjectService } from './project/project-service.js';
import { GatewayStatusReporter, inspectGatewayHealth } from './gateway/health.js';
import { FeishuSessionRegistry } from './gateway/feishu-session-registry.js';
import { WorkspacePublicationRepo } from './storage/workspace-publication-repo.js';
import { KernelEffectOutboxRepo } from './storage/kernel-effect-outbox-repo.js';
import { shouldRunPlannerTui } from './cli/runtime-mode.js';

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  const smokeRunId = process.env.ANYFUSION_SMOKE_RUN_ID?.trim() || null;
  const newTaskMetadata = smokeRunId
    ? { source: 'system_smoke' as const, smokeRunId }
    : undefined;

  // 1. 初始化目录
  const metaclawDir = resolveMetaclawDir();
  const snapshotDir = resolve(metaclawDir, 'snapshots');
  const gatewaySocketPath = resolveGatewaySocketPath(metaclawDir);
  if (!existsSync(metaclawDir)) mkdirSync(metaclawDir, { recursive: true });
  if (!existsSync(snapshotDir)) mkdirSync(snapshotDir, { recursive: true });

  if (cliArgs.connect) {
    await runGatewayClientUi(gatewaySocketPath);
    return;
  }

  if (cliArgs.gatewayCommand === 'setup') {
    await runGatewaySetup({ metaclawDir });
    return;
  }

  if (cliArgs.gatewayCommand === 'pairing') {
    runGatewayPairingCommand({
      metaclawDir,
      command: cliArgs.gatewayPairingCommand ?? 'list',
      userId: cliArgs.gatewayPairingUserId,
    });
    return;
  }

  if (cliArgs.gatewayCommand === 'doctor') {
    const configPath = resolve(metaclawDir, 'config.yaml');
    const config = loadConfig(configPath);
    const checks = runGatewayDoctor({ config, metaclawDir });
    console.log(formatGatewayDoctorChecks(checks));
    if (checks.some(check => check.status === 'fail')) process.exitCode = 1;
    return;
  }

  if (cliArgs.gatewayCommand === 'health') {
    const result = inspectGatewayHealth(metaclawDir);
    console.log(result.message);
    if (!result.healthy) process.exitCode = 1;
    return;
  }

  // 2. 加载配置
  const configPath = resolve(metaclawDir, 'config.yaml');
  const config = loadConfig(configPath);
  // 3. 初始化数据库
  const db = createDatabase(resolve(metaclawDir, 'metaclaw.db'));
  if (cliArgs.executorCommand) {
    console.log(await runExecutorCli({
      db,
      command: cliArgs.executorCommand,
      args: cliArgs.executorArgs ?? [],
    }));
    db.close();
    return;
  }
  const project = await new ProjectService(new ProjectRepo(db)).resolveProject(cliArgs.projectPath);
  process.env.METACLAW_PLANNER_WORKDIR = project.rootPath;
  const markdownPreviewConfig = config.integrations?.markdown_preview;
  const markdownPreviewServer = markdownPreviewConfig?.enabled
    ? new MarkdownPreviewServer(markdownPreviewConfig, project.rootPath)
    : null;
  if (markdownPreviewServer && markdownPreviewConfig) {
    try {
      await markdownPreviewServer.start();
      const markdownPreviewBaseUrl = (markdownPreviewConfig.public_base_url
        ?? `http://${markdownPreviewConfig.host}:${markdownPreviewConfig.port}`).replace(/\/+$/, '');
      console.log(`Markdown preview listening: ${markdownPreviewBaseUrl}`);
    } catch (error) {
      console.error(`Markdown preview start failed: ${(error as Error).message}`);
    }
  }

  // 4. 初始化 Repos
  const taskSearchIndexRepo = new TaskSearchIndexRepo(db);
  const taskRepo = new TaskRepo(db, taskSearchIndexRepo);
  const prefRepo = new PreferenceRepo(db);

  // 5. 初始化引擎
  const taskEngine = new TaskEngine(taskRepo, snapshotDir);
  const memoryEngine = new MemoryEngine(prefRepo);
  const orchestration = new OrchestrationEngine(taskEngine);

  // 7. Executor availability is resolved at dispatch time by the selected
  // backend. Startup keeps direct reply/query/planning available even when
  // the configured Executor runtime is unavailable.

  // 8. 初始化上下文召回器
  const sessionId = `sess_${nanoid(10)}`;
  const contextRecaller = new ContextRecaller(db);
  const notifier = createNotificationService(config);
  const plannerHostSocketPath = (process.env.METACLAW_PLANNER_HOST_SOCKET
    ?? process.env.METACLAW_PLANNER_TUI_SOCKET
    ?? resolve(metaclawDir, 'anyfusion-planner.sock')).trim();
  process.env.METACLAW_PLANNER_HOST_SOCKET = plannerHostSocketPath;
  process.env.METACLAW_PLANNER_TUI_SOCKET = plannerHostSocketPath;
  const plannerHost = new PlannerTuiBridge({ socketPath: plannerHostSocketPath, logger: console });
  await plannerHost.start();

  if (cliArgs.scriptPath) {
    try {
      const result = await runScriptedSessionFile(cliArgs.scriptPath, {
        taskEngine,
        memoryEngine,
        orchestration,
        db,
        config,
        sessionId,
        contextRecaller,
        notifier,
        plannerHost,
        project,
        newTaskMetadata,
      });
      if (result.output.length > 0) {
        process.stdout.write(`${result.output.join('\n')}\n`);
      }
    } finally {
      await plannerHost.stop();
    }
    return;
  }

  const plannerTuiSocketPath = plannerHostSocketPath;
  const plannerTuiCommand = process.env.METACLAW_PLANNER_TUI_COMMAND?.trim() ?? 'anyfusion-planner';
  process.env.METACLAW_PLANNER_TUI_COMMAND = plannerTuiCommand;
  if (shouldRunPlannerTui(cliArgs)) {
    const plannerTuiSession = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      db,
      config,
      sessionId,
      contextRecaller,
      notifier,
      plannerHost,
      project,
      newTaskMetadata,
    });
    plannerTuiSession.initialize({ showDashboard: false });
    const nativeGatewayServer = new MetaclawGatewayServer({
      socketPath: gatewaySocketPath,
      taskEngine,
      memoryEngine,
      orchestration,
      db,
      config,
      contextRecaller,
      notifier,
      workspaceRoot: project.rootPath,
      plannerHost,
    });
    await nativeGatewayServer.start();
    const blockedRecheckTimer = setInterval(() => {
      void plannerTuiSession.maybeReviewTaskPoolOnTimer().catch(error => {
        plannerTuiSession.appendSystemMessage(`错误: ${(error as Error).message}`);
      });
    }, plannerTuiSession.getBlockedRecheckIntervalMs());
    try {
      await runPlannerTuiProcess({
        socketPath: plannerTuiSocketPath,
        sessionId,
        cwd: project.rootPath,
      });
    } finally {
      clearInterval(blockedRecheckTimer);
      await plannerTuiSession.shutdown();
      await Promise.all([
        plannerHost.stop(),
        nativeGatewayServer.stop(),
        markdownPreviewServer?.stop() ?? Promise.resolve(),
      ]);
    }
    return;
  }

  const gatewayServer = new MetaclawGatewayServer({
    socketPath: gatewaySocketPath,
    taskEngine,
    memoryEngine,
    orchestration,
    db,
    config,
    contextRecaller,
    notifier,
    workspaceRoot: project.rootPath,
    plannerHost,
  });

  let gatewayFeishuBridge: Awaited<ReturnType<typeof startFeishuRuntimeBridge>> = null;
  let gatewaySessionRegistry: FeishuSessionRegistry | null = null;
  if (cliArgs.gateway) {
    const statusReporter = new GatewayStatusReporter(metaclawDir, gatewaySocketPath);
    statusReporter.update('starting');
    gatewaySessionRegistry = new FeishuSessionRegistry(stableSessionId => new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      db,
      config,
      sessionId: stableSessionId,
      contextRecaller,
      notifier,
      plannerHost,
      project,
    }));
    await gatewaySessionRegistry.preload([...new Set([
      ...new WorkspacePublicationRepo(db).listRecoverySessionIds('sess_feishu_'),
      ...new KernelEffectOutboxRepo(db).listCompletionRecoverySessionIds('sess_feishu_'),
    ])]);
    gatewayFeishuBridge = await startFeishuRuntimeBridge(config, {
      resolveSession: chatId => gatewaySessionRegistry!.get(chatId),
      statusReporter,
    });
    if (!gatewayFeishuBridge) throw new Error('Gateway service requires an enabled Feishu bridge');
  }
  await gatewayServer.start();
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await Promise.all([
        gatewayFeishuBridge?.stop() ?? Promise.resolve(),
        gatewaySessionRegistry?.stop() ?? Promise.resolve(),
        gatewayServer.stop(),
        plannerHost.stop(),
        markdownPreviewServer?.stop() ?? Promise.resolve(),
      ]);
    })();
    return shutdownPromise;
  };
  process.once('exit', () => {
    void gatewaySessionRegistry?.stop();
    void gatewayFeishuBridge?.stop();
    void markdownPreviewServer?.stop();
    void gatewayServer.stop();
    void plannerHost.stop();
  });
  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  if (cliArgs.gateway) {
    console.log(`Metaclaw Gateway listening: ${gatewaySocketPath}`);
    try {
      await gatewayFeishuBridge!.waitForFailure();
    } catch (error) {
      await shutdown();
      throw error;
    }
    return;
  }

  // 9. 启动 TUI
  renderApp({ taskEngine, memoryEngine, orchestration, db, config, sessionId, contextRecaller, notifier, plannerHost });
}

main().catch((error) => {
  console.error('启动失败:', error);
  process.exit(1);
});
