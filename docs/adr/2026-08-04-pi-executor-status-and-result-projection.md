# Pi 执行器状态与结果投影修复计划

> 状态：已完成；核心实现、聚焦测试、Pi 静态检查/离线构建与 MetaClaw smoke 均通过
> 计划日期：2026-08-04
> 实施日期：2026-08-04
> 完成日期：2026-08-04
> 目标产品名：AnyFusion；`MetaClaw` / `metaclaw` 继续作为内部运行时名称与兼容 CLI alias
> Pi fork 本地路径：`D:\Internships\AnyInt\AnyFusion-Pi`
> 核心边界：Pi 只展示 MetaClaw 已有状态和已集成事实；Kernel、Execution、Executor 与 publication authority 不变

## 目标

- 在 Pi Task Dashboard 中使用原生 `Loader` 展示当前 Session 快照里的 `runningExecutorName`，并在状态清空、快照失效或组件销毁时停止动画。
- 将当前 MetaClaw session 关联 Task 的成功 integrated publication 逐条投影到 Pi 对话，包含 Executor 原始总结、完整 artifact 路径、warnings、integration commit 和完成时间。
- 结果进入持久 Pi transcript 和 Planner 上下文，但使用 `triggerTurn: false` 被动写入；消息到达本身不得触发、steer 或续写 Planner。
- 以 publication ID 在 MetaClaw socket 和 Pi session 两侧去重，并补发当前 session 内尚未展示的历史成功结果。
- 保持 Host Protocol v2 与 snapshot schema 不变；旧客户端继续忽略未知通知。

## 已交付实现

### MetaClaw

- `WorkspacePublicationRepo.listIntegratedByTaskIds()` 只读查询指定 Task 集合的 integrated publication，并按完成时间、publication ID 稳定升序返回。
- `MetaclawSession.getPlannerTuiExecutorResults()` 从当前 session 的 Kernel decision ledger 推导关联 Task，组装 schema v1 的只读结果投影；失败、冲突、取消和未集成记录不会进入最终结果。
- Host Protocol v2 hello 增加 `executor_result` capability，并新增向后兼容的 `executor_result` 通知。Bridge 在初次订阅和现有 Session 通知链路上检查结果，每个 socket 只发送一次 publication ID。
- 单条 JSONL 超过 1 MiB 时只截断总结正文并设置 `reportTruncated=true`；身份字段和完整 artifact 清单保持不变。

### AnyFusion-Pi

- Task Dashboard 绑定 Pi `TUI` 并复用原生 `Loader`，增加独立的 Executor 执行区块；focused Task 静态副行不再重复 Executor 名称。
- Host client 校验 schema v1 通知并通过独立 listener 交给 InteractiveMode；malformed 通知被忽略，capability 缺失只产生降级提示。
- `AnyFusionExecutorResultInbox` 从 Pi branch 恢复已展示 publication ID，在 streaming/compaction 期间排队，并在 Session 空闲后按完成顺序调用 `sendCustomMessage(..., { triggerTurn: false })`。
- 每个 Subtask 对应一条 `anyfusion-executor-result` custom message；消息展示总结、warnings、commit 和全部 artifact 路径，不读取或内联文件内容。
- 固定 Planner Skill 明确该消息是已集成只读事实：到达本身不是语义回合，Planner 仅在当前用户明确询问结果、输出、artifact 或状态时引用。

## 测试与验收

- Pi 四组初始定向测试通过：3 个文件通过、1 个 Unix socket 文件按 Windows 条件跳过，13 项通过、1 项跳过；覆盖 Loader 帧变化与清理、结果 Markdown/持久化元数据、busy queue、publication ID 去重、Host capability、合法/非法通知以及 Planner Skill 约束。
- 生命周期审查后增加 branch 去重集合重置与 idle-after-event 调度；对应 inbox 定向测试 6 项通过。
- Pi `npm run check` 通过：Biome 检查 749 个文件，pinned dependencies、relative imports、shrinkwrap、`tsgo --noEmit` 和 browser smoke 全部通过。
- Pi `npm run build:offline` 通过，包含 TUI、AI、Agent Core 和 Coding Agent。首次检查揭示本机 `node_modules` 缺少锁定的 `@modelcontextprotocol/sdk@1.25.2`；执行 `npm install` 按既有 lockfile 补齐后，检查和构建均通过，依赖清单未修改。
- MetaClaw Linux Docker 聚焦测试通过：SQLite publication 查询和 Unix socket Host bridge 共 2 个文件、7 项测试通过；覆盖 session/task 范围、integrated 过滤、稳定排序、完整 artifacts、backlog/增量/每 socket 去重及 1 MiB 截断。
- `npm run smoke:metaclaw` 通过 native Planner 双轮 session 场景；`npm run smoke:metaclaw -- --scenario artifact` 通过真实 Planner → Kernel → Codex Executor → integrated artifact 链路。
- MetaClaw `npm run lint` 已执行，但被本任务开始前即存在的无关类型错误阻塞：`src/execution/completion-protocol.ts` 的 completion envelope narrowing，以及 `src/execution/subtask-attempt-runner.ts` 的 `WorkspaceDelta`/`Record<string, unknown>` 不兼容；本次修改文件未出现在错误列表。
- 双仓库 `git diff --check` 通过。MetaClaw closing implementation commit：`4fd021e`（`feat: project executor results to planner host`）；AnyFusion-Pi 对应提交：`0774f0b5`（`fix: restore executor status and result display`）。

## 非目标

- 不修改旧 `src/tui/` Ink 界面。
- 不增加 Planner 存储写入、第二语义路由、Runtime 恢复策略或 Executor 控制能力。
- 不扩大 snapshot schema，不内联 artifact 文件内容，不把失败或未集成 attempt 伪装成最终结果。
