# AnyFusion Codex 原生 TUI 定制迁移计划（失败归档）

> 状态：失败并终止；不得继续作为当前实施依据
> 终止日期：2026-07-31
> 替代计划：[AnyFusion Pi Planner 与原生 TUI 迁移计划](../../plans/2026-07-31-pi-planner-tui-migration.md)
> 计划日期：2026-07-30
> 目标产品名：AnyFusion；`MetaClaw` / `metaclaw` 继续作为内部运行时名称与兼容 CLI alias
> 核心边界：本计划只调整本地 TUI 展示与接入，不修改 Kernel、Execution、Executor 的设计逻辑

## 失败结论

本计划的 Planner/Kernel/Executor 所有权边界仍然成立，但 Codex fork 作为 Planner TUI 载体失败：

- Codex Rust workspace 的依赖下载和本地编译经过数小时仍无法完成；
- Linux 服务器同样出现长时间编译和资源饥饿；
- 该构建、发布和持续 rebase 成本远超一次 Planner presentation 迁移可接受范围；
- 继续投入只会扩大 downstream 运维负担，不会改善 AnyFusion Kernel 或 Executor 能力。

因此自 2026-07-31 起停止 AnyFusion-Codex 功能开发、服务器编译和默认入口推进。本文件保留当时的设计与交付状态，作为失败路线的历史记录；其中的只读 Task panel、proposal 重新校验、Application-Shell bridge、进程隔离、Ink TUI 保留和不修改 Kernel/Executor 等边界由 Pi 替代计划继承。

不得根据本文件继续实施“Codex 作为默认 Planner TUI”的结论。当前实施依据是新的 Pi 迁移计划。

## 终止时交付状态

实现已经落在两个独立仓库：

- `MetaAny/AnyFusion`：默认入口、Application-Shell bridge、Stop Hook、Planner 配置、Docker 装配与回归测试；
- `MetaAny/anyfusion-codex`：固定 upstream commit 的浅 Fork，仅包含 TUI、只读任务面板、Planner 展示和发布包装。

本机已经完成 AnyFusion 主仓库的 TypeScript lint/build、Docker 全量 Vitest、容器内 build、Stop Hook 与 shell 语法验证。AnyFusion-Codex 的 Rust 编译、原生 TUI 交互和最终 Linux 发布产物刻意留给服务器完成，当前不得将计划标记为最终完成。

实际运行逻辑为：AnyFusion 默认启动修改版 Codex Planner TUI；`PlannerTuiBridge` 通过本地 mode-`0600` Unix JSONL socket 只读投影 Task 状态。Codex Stop Hook 只提交一个 Planner proposal，`MetaclawSession` 随后重新执行 v6 schema 与语义校验，并复用既有 `plan_proposed → DurableKernelWorkflow → ControlKernel` 路径。Planner MCP 仍然只读。Executor attempt 始终使用原版 Codex 镜像。原 `src/tui/` Ink 实现完整保留，可通过 `METACLAW_STANDBY_TUI=1` 作为备用入口启动。

## 结论

AnyFusion 继续选择 Codex 作为 Planner 的原生会话与 Agent 载体，不迁移到 Pi，也不引入通用
Agent Harness。本次迁移采用 **Codex TUI 浅 fork**：保留 Codex 的 thread、turn、历史、
resume、fork、compaction、原生命令、MCP、Skills、Hooks、approval、sandbox 和 agent loop，
只对 TUI 做以下定制：

1. 将 Codex TUI 的产品展示、品牌和布局替换为 AnyFusion；
2. 在不改变任何 Task/Kernel/Executor 语义的前提下，尽可能增加 AnyFusion Task、Subtask、
   Executor、blocked reason 和运行进度面板。

当前 `src/tui/` 下的 Ink TUI **不得删除**。它在新 TUI 成为默认入口后进入“暂时弃用、
保留源码”的备用模块状态，用于未来重新启用；本计划不为其投入持续构建、兼容或回归维护成本。

## 本次讨论形成的设计摘要

- 不选择 Pi。Codex 更适合作为现有 Planner 会话、历史、压缩和远程连接载体。
- 不重新实现 Codex App Server client，也不重写 Codex agent loop。
- 不采用 Stock Codex TUI 原样切换；AnyFusion 需要维护一个改动范围受控的 Codex TUI
  downstream fork。
- Codex 继续拥有 conversation state；MetaClaw 继续拥有 Task/Kernel/Executor state。
- 新任务面板只读取现有权威状态，不解释策略、不修改数据库、不直接控制 Executor。
- 原有 Ink TUI 保留为备用源码模块，不删除源码、测试和依赖；不承诺本计划后持续提供启动入口或兼容验证。

## 不可突破的边界

### 1. 只改 TUI 展示层

本计划允许修改：

- Codex TUI 的品牌、主题、标题、布局和组件；
- 新增 AnyFusion 任务面板及其 TUI 内部状态；
- TUI 对现有只读查询接口的调用；
- TUI launcher、默认入口和备用 TUI 源码保留声明；
- 与 TUI 直接相关的构建、打包和 smoke。

本计划不包含新的业务工作流、调度策略、恢复策略或执行策略。

### 2. Kernel 完全不变

不得修改：

- `src/kernel/` 的 Decision 语义、事件、action、恢复和授权规则；
- `ControlKernel.decide(event, snapshot)` Interface；
- `DurableKernelWorkflow` 的持久化、apply、replay 和幂等语义；
- Task admission、retry、fallback、replan、availability、permission 和 cancellation policy；
- Work Graph 的状态机、图规则和 publication contract。

TUI 不得成为第二个 semantic router 或 policy owner。

### 3. Execution 与 Executor 完全不变

不得修改：

- `src/execution/` 的 attempt、sandbox、lease、recovery、publication 和 Git 逻辑；
- `src/executor/` 的 AgentClass、Executor registry、image、permission profile 和 probe 逻辑；
- Codex/Pi Executor 的执行协议；
- Docker sandbox、workspace、resource partition 和 capability security contract。

任务面板只能展示这些模块已经产生的事实，不能改变其含义。

### 4. 不删除现有 Ink TUI

`src/tui/` 是本项目显式保留的 **备用 TUI 模块**：

- 保留所有源码；
- 保留 Ink/React 依赖；
- 保留相关单元测试源码与 fixture，但不要求持续运行；
- 允许保留现有启动接线，但不新增或维护 `--classic-tui` 等专用入口；
- 不要求与新 TUI 同时新增功能，也不承诺持续可构建、可启动或可用于即时回滚；
- 不改名为 archive，不移动到 `docs/archive/`，不把它视为历史废弃代码。

“暂时弃用”表示源码仍在，但当前不承担持续可运行、兼容或回归责任。

### 5. 保持 Codex 上游能力

除 TUI 展示与必要的 composition hook 外，不修改：

- Codex App Server；
- thread/turn/item protocol；
- native thread storage；
- history/resume/fork/compaction；
- model、auth 和 account；
- MCP client、Skills 和 Hooks runtime；
- command/tool rendering 语义；
- approvals 与 sandbox；
- agent loop 和模型提示协议。

如果某项 AnyFusion UI 需求必须修改上述模块才能实现，该需求退出本计划，另行评审。

## 目标结构

```text
anyfusion launcher
  ├─ 默认：AnyFusion Codex TUI downstream build
  │    ├─ 原生 Codex conversation / commands / history / compaction
  │    └─ AnyFusion read-only Task panel
  │
  └─ 备用源码：现有 Ink TUI（暂时弃用，不保证入口与持续可运行性）

AnyFusion Codex TUI
  ├─ 连接原生 Codex App Server
  └─ 通过现有只读 Planner MCP 查询 MetaClaw 状态

MetaClaw Runtime
  ├─ Planning plan validation
  ├─ ControlKernel / KernelWorkflow
  ├─ Task / Work Graph / Storage
  └─ Execution / Executor / Sandbox / Git publication
```

新 TUI 只是 presentation adapter。它不会替代或包装 Kernel，也不会改变执行链。

## Planner 前端提交桥

只读 MCP 只负责提供事实，不能承担用户输入或计划提交。默认 TUI 通过一个位于
Application Shell 的本地 Unix-socket bridge 完成前端交接：

```text
AnyFusion Codex TUI（原生 thread/commands/history/compact）
  ├─ Planner MCP：只读查询事实
  └─ Stop hook：提交结构化 PlanningAgentPlan
          ↓
PlannerTuiBridge（仅做协议校验、会话投影与提交转交）
          ↓
现有 plan validation → plan_proposed → DurableKernelWorkflow → ControlKernel
```

- bridge 不是 MCP，不向 Planner 暴露状态修改工具；
- bridge 只接受当前 Planner turn 的用户输入与结构化 plan，并调用现有会话/Kernel 提交流程；
- bridge 自身不得写数据库、调度 Executor 或实现恢复策略；
- Task panel 通过同一 bridge 订阅只读 Session/Task 投影，不直接读取 SQLite；
- fork TUI 仅在 Planner 模式下注入 PlanningAgentPlan v6 output schema，并将内部 JSON 渲染为用户可见回复；
- Executor 继续使用 stock Codex，不加载该 bridge、schema 或 Planner CODEX_HOME。

## Codex 源码策略

### 采用浅 fork

需要 fork Codex 源码，因为 Plugin、MCP、Skills 和 Hooks 不能直接替换终端布局或增加常驻
Task 面板。fork 仅用于维护 AnyFusion TUI downstream build。

推荐方式：

- 建立独立的 Codex downstream 仓库或长期分支；
- 设置 `openai/codex` 为 upstream；
- 固定明确的 Codex tag/commit，不跟随浮动 `main`；
- AnyFusion 修改主要集中在 `codex-rs/tui/src/anyfusion/`；
- CLI 只做启动名、产品名和必要的 composition wiring；
- 不把完整 Codex 源码复制进 MetaClaw 仓库；
- MetaClaw 仓库只保存版本 pin、构建脚本、补丁说明和集成测试。

建议下游提交保持为独立 patch series：

1. `feat(tui): add AnyFusion branding and theme`
2. `feat(tui): add AnyFusion panel composition seam`
3. `feat(tui): add read-only MetaClaw status client`
4. `build: package AnyFusion Codex TUI distribution`

禁止在同一提交中混入 Codex core、protocol、sandbox 或 agent loop 修改。

## AnyFusion TUI 改动范围

### 1. 品牌和基础布局

- TUI 标题、欢迎页、状态栏和帮助信息展示 AnyFusion；
- 保留 Codex 原生 composer、transcript、tool call、approval 和 slash command 行为；
- 保留原生 keyboard handling、history、resume、fork 和 compaction；
- 支持较窄终端下隐藏、折叠或 overlay 任务面板；
- 不复刻现有 Ink TUI 的每一个像素和动画。

### 2. Task 面板

首期争取展示：

- 当前 Task ID、标题和状态；
- ready/running/blocked/parked Task 数量；
- 当前 Subtask 和 active attempt；
- 当前 Executor/AgentClass；
- blocked reason 和 pending authorization；
- 最近 Kernel/Task event；
- 最近 Executor diagnostics；
- 完成、失败和 publication 状态。

面板是只读 projection：

- 不直接写 SQLite；
- 不直接调用 Repository；
- 不直接发 Kernel event；
- 不直接启动、停止或切换 Executor；
- 不从 transcript、tool 文案或自然语言回答推断状态。

用户需要控制 Task 时，继续通过 Codex 对话、现有 MCP tool 或现有确定性命令完成。

### 3. 数据来源

本计划优先复用当前 Planner MCP 已有只读工具：

- `search_tasks`；
- `get_task_context`；
- `get_current_session_context`；
- `get_runtime_state`；
- `list_executor_status`；
- `get_executor_diagnostics`。

TUI 可通过 bounded polling 刷新面板。刷新失败只显示 unavailable/stale 状态，不影响
Codex conversation，也不改变任何 Task/Executor 状态。

如果上述现有只读工具不足，首期应缩小面板字段，而不是修改 Kernel 或 Executor。本计划不
新增 storage schema、Kernel event、Executor status semantics 或运行策略。

## 原有 Ink TUI 的备用模块定位

现有模块继续位于：

- `src/tui/`；
- `src/session/` 中仅为该 TUI 服务的展示与输入逻辑；
- 对应 `tests/tui/`、session/TUI tests 和 smoke。

新 TUI 默认切换后：

- Ink TUI 标记为 `standby / backup`；
- 默认启动命令不再进入 Ink；
- 不新增 `--classic-tui` 维护承诺；如未来恢复使用，另立计划补齐入口与兼容；
- 新旧 TUI 不同时运行，不共享前台输入；
- 备用 TUI 不承担新 TUI 的兼容 shim；
- 任何未来删除提议必须单独提出、单独批准，不得作为本计划的后续清理自动执行。

## 分阶段实施

### Phase 0：fork 与可维护性 spike

目标是先证明“浅 fork”成立，不改 MetaClaw 核心代码。

验证：

1. 从固定 Codex tag/commit 构建原生 TUI；
2. 修改产品名、欢迎页、主题和 binary 名称；
3. 新增一个静态 AnyFusion 面板插槽；
4. 保证原生 slash commands、history、resume、fork、compact、MCP 和 approval 正常；
5. 将 upstream 前进至少一个可用版本并执行一次真实 rebase；
6. 确认冲突主要限制在 TUI composition、branding 和 packaging 文件；
7. 记录 upstream commit、构建命令、patch series 和已知冲突。

退出条件：无需修改 Codex core、App Server protocol、agent loop 或 sandbox 即可完成。

### Phase 1：AnyFusion 品牌 TUI

- 建立 AnyFusion Codex downstream fork；
- 完成品牌、主题、标题、帮助和启动名；
- 保留原生 Codex TUI 行为；
- 添加空的 AnyFusion panel composition seam；
- 添加 fork-specific TUI tests；
- 不接入真实 Task 数据，不修改 MetaClaw Kernel/Execution/Executor。

### Phase 2：只读任务面板

- 在 forked TUI 中增加 Planner MCP read-only client；
- 调用现有查询工具构建 panel state；
- 实现 loading、stale、unavailable 和 reconnect 状态；
- 实现 Task、Subtask、Executor 和 diagnostics 展示；
- 不提供直接 mutation button；
- 确认面板不可用时 Codex conversation 仍完整可用。

### Phase 3：打包与启动入口

- `anyfusion` 默认启动 AnyFusion Codex TUI build；
- `metaclaw` compatibility alias 使用同一默认入口；
- 保留现有 Ink TUI 源码、测试源码和依赖，但不新增专用备用入口；
- launcher 记录所使用的 Codex upstream version；
- Docker/server shell 对齐新 binary，但不修改业务运行时架构；
- 不新增或维护当前 Ink TUI 的独立 smoke。

### Phase 4：默认切换与观察期

- AnyFusion Codex TUI 成为默认入口；
- 现有 Ink TUI 转为显式备用模块；
- 运行一段有边界的使用与升级验证；
- 修复 TUI 展示和 fork rebase 问题；
- 不删除旧 TUI，不删除 Ink/React 依赖，不清理相关测试；
- 不以“迁移完成”为理由修改 Kernel、Execution 或 Executor。

本计划没有 Hard cut 删除阶段。

## 上游 Codex 更新策略

每次升级按照固定顺序：

1. 更新并记录 upstream Codex commit/version；
2. 构建、测试未应用 AnyFusion patch 的 upstream；
3. 依次应用 branding patch；
4. 应用 panel composition patch；
5. 应用 MetaClaw read-only client patch；
6. 运行 Codex 原生 TUI/command/MCP/approval smoke；
7. 运行 AnyFusion branding、panel、原生 Codex commands/history/approval smoke；
8. 只有全部通过才更新 AnyFusion 默认版本。

升级过程中不得为了减少冲突而把 AnyFusion Task 状态写入 Codex core protocol。若 fork delta
持续扩散到 core、app-server、sandbox 或 agent loop，应暂停升级并重新缩小改动，而不是继续
扩大 fork。

## 测试计划

### Codex 原生行为回归

- 新建、resume、fork 和 archive conversation；
- 手动与自动 compaction；
- slash commands 与 completion；
- MCP tool call、failure 和 timeout；
- approval、interrupt 和 tool rendering；
- 不同终端尺寸和 Windows/Linux shell。

### AnyFusion TUI

- 品牌和帮助信息正确；
- 面板可显示、隐藏和折叠；
- Planner MCP unavailable 时不影响 Codex 对话；
- stale data 有明确提示；
- Task/Executor 状态只来自只读查询结果；
- 面板不会发 mutation、不会修改数据库；
- 上游 rebase 后 UI tests 仍通过。

### 备用 Ink TUI

- `src/tui/`、相关测试源码、fixture 与 Ink/React 依赖不得删除；
- 本计划不新增功能、不修复兼容、不要求持续构建或 smoke；
- 未来重新启用时，另立恢复计划并重新确认入口、依赖与回归范围。

### 核心回归保护

由于本计划明确不修改 Kernel/Execution/Executor：

- 现有核心测试必须无行为变化；
- Git diff 不应包含 `src/kernel/`、`src/execution/`、`src/executor/` 的逻辑修改；
- 若确需修改这些目录，必须停止本计划并提交独立设计/ADR；
- Docker 核心测试用于证明 TUI 改动没有改变执行语义，而不是引入新的核心行为。

## 明确不做

- 不迁移到 Pi；
- 不引入通用 AgentHarness；
- 不替换或 fork Codex App Server；
- 不修改 Codex thread/turn/item protocol；
- 不修改 Codex agent loop、history 或 compaction；
- 不修改 MetaClaw Kernel、Work Graph、Execution 或 Executor 逻辑；
- 不修改 SQLite schema；
- 不新增第二套 semantic router；
- 不让任务面板直接操作 Kernel/Executor；
- 不删除或归档现有 Ink TUI；
- 不删除 Ink/React 依赖和测试；
- 不承诺在本计划内重现现有 Ink TUI 的全部视觉细节。

## 文档影响

本计划不修改 ADR-0015、ADR-0020、ADR-0023 或 Kernel/Execution ownership。它只改变默认
TUI Adapter 和产品展示。

实施时需要同步：

- `CONTEXT.md`：仅更新默认本地 TUI 与备用 TUI 的事实；
- `docs/current/technical-overview.md`：记录 Codex downstream TUI、版本 pin 和启动方式；
- `AGENTS.md`：明确现有 Ink TUI 是保留的备用模块；
- `docs/README.md`：登记计划状态与完成信息；
- 构建、Docker 和服务器运行说明；
- Codex fork/upstream 同步说明。

不得借文档同步修改 Kernel/Executor contract。

## 验证记录与服务器交接

本机已通过：

- `npm run lint`；
- `npm run build`；
- `docker build -f Dockerfile.test -t metaclaw-test .`；
- `docker run --rm metaclaw-test`：182 个测试文件通过、707 项测试通过，4 个文件/15 项测试按既有条件跳过；
- 迁移定向 Docker 测试：4 个测试文件、24 项测试全部通过；
- 测试镜像内 `npm run build`；
- Stop Hook 的 Node 语法检查与 Docker shell 脚本语法检查。

当前服务器交接基线已锁定为 `MetaAny/anyfusion-codex@bd607f067f1c4f12ed1c61122ca89f18c23a756c`。服务器仍需确认的行为由 `MetaAny/anyfusion-codex` 根 `AGENTS.md` 定义，包括原生 Codex 会话/历史/命令/压缩回归、AnyFusion 品牌、响应式只读任务面板、bridge 降级、Stop Hook 端到端提交、Planner/Executor 二进制隔离以及可追溯 Linux 发布产物。服务器验收完成后再补写完成日期、两个最终 commit SHA、产物 digest 和交互 smoke 结果。

## 完成标准

- `anyfusion` 默认打开 AnyFusion 品牌的 Codex TUI downstream build；
- Codex 原生 conversation、commands、history、resume、fork、compaction、MCP 和 approval 保持可用；
- AnyFusion Task 面板可读取并展示现有只读状态；
- 面板故障不会影响 Codex conversation 或 Task 执行；
- Kernel、Work Graph、Execution、Executor、sandbox 和 publication 没有设计或行为变化；
- 现有 `src/tui/` Ink TUI 源码完整保留，并显式标记为暂时弃用的备用模块；
- Ink/React 依赖、测试和 smoke 未删除；
- Codex fork 修改集中在 TUI、branding、panel adapter 和 packaging；
- 至少完成一次真实 upstream rebase 验证；
- 不存在以本计划名义执行的核心重构或旧 TUI 删除。
