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

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));

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
    console.log(formatGatewayDoctorChecks(runGatewayDoctor({ config, metaclawDir })));
    return;
  }

  if (
    cliArgs.gatewayCommand === 'install'
    || cliArgs.gatewayCommand === 'start'
    || cliArgs.gatewayCommand === 'stop'
    || cliArgs.gatewayCommand === 'restart'
    || cliArgs.gatewayCommand === 'status'
  ) {
    console.log(`请使用 ./metaclaw.sh ${cliArgs.gatewayCommand} 管理后台进程。`);
    return;
  }

  // 2. 加载配置
  const configPath = resolve(metaclawDir, 'config.yaml');
  const config = loadConfig(configPath);
  const markdownPreviewConfig = config.integrations?.markdown_preview;
  const markdownPreviewServer = markdownPreviewConfig?.enabled
    ? new MarkdownPreviewServer(markdownPreviewConfig, process.cwd())
    : null;
  if (markdownPreviewServer && markdownPreviewConfig) {
    try {
      await markdownPreviewServer.start();
      const markdownPreviewBaseUrl = (markdownPreviewConfig.public_base_url
        ?? `http://${markdownPreviewConfig.host}:${markdownPreviewConfig.port}`).replace(/\/+$/, '');
      console.log(
        `Markdown preview listening: ${markdownPreviewBaseUrl}`,
      );
    } catch (error) {
      console.error(`Markdown preview start failed: ${(error as Error).message}`);
    }
  }

  // 3. 初始化数据库
  const db = createDatabase(resolve(metaclawDir, 'metaclaw.db'));

  // 4. 初始化 Repos
  const taskSearchIndexRepo = new TaskSearchIndexRepo(db);
  const taskRepo = new TaskRepo(db, taskSearchIndexRepo);
  const prefRepo = new PreferenceRepo(db);

  // 5. 初始化引擎
  const taskEngine = new TaskEngine(taskRepo, snapshotDir);
  const memoryEngine = new MemoryEngine(prefRepo);
  const orchestration = new OrchestrationEngine(taskEngine);

  // 7. Executor availability is resolved from the verified attempt image at
  // dispatch time. Startup must keep direct reply/query/planning available
  // when Docker is unavailable and let Kernel surface a configuration block
  // only for work that actually requires execution.

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
  if (process.env.METACLAW_STANDBY_TUI !== '1') {
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
      workspaceRoot: process.cwd(),
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
        cwd: process.cwd(),
      });
    } finally {
      clearInterval(blockedRecheckTimer);
      plannerTuiSession.dispose();
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
    workspaceRoot: process.cwd(),
    plannerHost,
  });

  await gatewayServer.start();
  let gatewayFeishuBridge: Awaited<ReturnType<typeof startFeishuRuntimeBridge>> = null;
  let gatewayBlockedRecheckTimer: NodeJS.Timeout | null = null;
  let gatewaySession: MetaclawSession | null = null;
  if (cliArgs.gateway) {
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      db,
      config,
      sessionId,
      contextRecaller,
      notifier,
      plannerHost,
    });
    gatewaySession = session;
    session.initialize({ showDashboard: false });
    gatewayFeishuBridge = await startFeishuRuntimeBridge(config, session);
    gatewayBlockedRecheckTimer = setInterval(() => {
      void session.maybeReviewTaskPoolOnTimer().catch(error => {
        session.appendSystemMessage(`错误: ${(error as Error).message}`);
      });
    }, session.getBlockedRecheckIntervalMs());
  }
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (gatewayBlockedRecheckTimer) {
        clearInterval(gatewayBlockedRecheckTimer);
        gatewayBlockedRecheckTimer = null;
      }
      try {
        await Promise.all([
          gatewayFeishuBridge?.stop() ?? Promise.resolve(),
          gatewayServer.stop(),
          plannerHost.stop(),
          markdownPreviewServer?.stop() ?? Promise.resolve(),
        ]);
      } finally {
        gatewaySession?.dispose();
        gatewaySession = null;
      }
    })();
    return shutdownPromise;
  };
  process.once('exit', () => {
    if (gatewayBlockedRecheckTimer) clearInterval(gatewayBlockedRecheckTimer);
    gatewaySession?.dispose();
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
    await new Promise(() => undefined);
    return;
  }

  // 9. 启动 TUI
  renderApp({ taskEngine, memoryEngine, orchestration, db, config, sessionId, contextRecaller, notifier, plannerHost });
}

main().catch((error) => {
  console.error('启动失败:', error);
  process.exit(1);
});
