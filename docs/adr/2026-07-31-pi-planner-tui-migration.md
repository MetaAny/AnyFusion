# AnyFusion Pi Planner 与原生 TUI 迁移计划

> 状态：已完成；结构化 proposal 工具、提交生命周期清理及 Linux Docker 最终验收全部通过
> 计划日期：2026-07-31
> 完成日期：2026-08-03（结构化提交链路与最终 Linux Docker 验收完成）
> 目标产品名：AnyFusion；`MetaClaw` / `metaclaw` 继续作为内部运行时名称与兼容 CLI alias
> Pi fork 本地路径：`D:\Internships\AnyInt\AnyFusion-Pi`，与 `MetaClaw` 平级
> 固定上游基线：`earendil-works/pi@ec6311beb5b24fc918e5031173608447582d7262` / `0.80.2`
> 前序失败方案：[AnyFusion Codex 原生 TUI 定制迁移计划](../archive/plans/2026-07-30-codex-native-tui-migration.md)
> 核心边界：Pi 是 Planner 对话、查询和智能规划载体；MetaClaw Kernel 仍是唯一决策者，Execution/Executor 仍是唯一执行方

## 实施进度（截至 2026-08-03）

已落地：

- 建立 `D:\Internships\AnyInt\AnyFusion-Pi` 完整 fork，固定上游基线 `ec6311beb5b24fc918e5031173608447582d7262` / `0.80.2`；
- 新增 deterministic `npm run build:offline`，直接使用锁定的 model catalogs；本机源码构建约 7–9 秒，不涉及 Codex/Rust 大型编译；
- 交付自包含 Node 22 Linux Planner image `anyfusion-pi-planner:dev`；缓存重建约 12 秒；
- 用户可见 CLI、帮助、配置目录和 binary 已切换为 AnyFusion Planner / `.anyfusion` / `anyfusion-planner`，并固定 system prompt、Provider/Model 和 Planner policy；
- interactive 与 RPC 入口仅保留对话及有界只读能力，禁止 shell、edit/write、任意 Provider/Model 切换、登录、自更新、扩展和包管理绕过路径；
- AnyFusion-Pi 已实现受限原生 `submit_planning_proposal({ plan })` 工具、interactive/RPC 共用提交、accepted/rejected/conflict/transport-uncertain 展示，以及 AnyFusion Planner Host Protocol v2 client；assistant 文本 envelope、尾括号修复和外层 validation repair 已删除；
- MetaClaw 已交付 `PlannerProcessRunner`：使用真实 Pi `--mode rpc`、stdin/stdout JSONL、每 turn 受控 child lifecycle、同 session writer 串行化、1 MiB 单行上限、只读 tool trace、credential redaction 与 fail-closed timeout/exit/protocol handling；
- MetaClaw host bridge 已支持 mode-`0600` Unix socket、snapshot projection 和 proposal handoff，并修复初次 `snapshot_subscribe` 重复发送初始 snapshot 的 race；snapshot 现包含 bounded Task pool、focused Task、Subtask preferred AgentClass、blocking reason 与 Executor health；
- 已恢复 Pi TUI 中的 MetaClaw 确定性 slash commands：`command_submit/command_result` 仅透传用户原始命令，执行仍唯一经过 `MetaclawSession → InputController → CommandCatalog`；Pi 不持有命令语义或 mutation API；
- 已恢复旧 Ink TUI 的完整命令补全契约：`command_complete` / `command_completion` 直接复用 `MetaclawSession.completeCommand()`，Pi 薄适配器复用原生异步请求、`AbortSignal`、候选列表、Tab、上下键和 stale-request 丢弃，并按 MetaClaw 返回的 replacement range 应用根命令、子命令及动态 Task/Executor 候选；Enter 提交前再次拒绝 `incomplete` / `invalid`；
- 已增加轻量 AnyFusion 欢迎组件：像素风品牌字、Planner 版本、MetaClaw 连接状态、模型/工作区、focused Task/任务数摘要；quiet startup 仍保留品牌和状态，不引入动画或第二套布局系统；
- AnyFusion-Pi 已接入响应式只读 dashboard：宽/中终端与 transcript 并排显示，窄终端自动隐藏；展示 focused Task、Subtask、Executor、blocking/last-event 和 Task pool，并提供 loading、unavailable、malformed/stale snapshot 降级；
- MetaClaw runtime 默认入口已切换到 AnyFusion-Pi；Node 20 control process 与 Planner 自带 Node 22 runtime 仅通过 JSON/JSONL、Unix socket、环境变量和文件边界通信；
- Docker 已隔离 Planner、Executor Codex、Executor Pi 的 env/config/base URL；API key 不写入 SSH `/etc/environment`，Planner control container 不再使用 Codex Planner 所需的 `seccomp=unconfined`；
- 已移除 active source/Docker/smoke 中的旧 Codex Planner runner、Stop Hook、lock/config 和 fallback 资产；Executor Codex、Executor Pi、Ink standby TUI 及兼容 re-export 保留；
- `CONTEXT.md`、ADR-0015、当前中英文技术总览、runtime security、`AGENTS.md` 与文档索引已同步到 AnyFusion-Pi 边界。

本轮最终验证证据（全部测试和行为验证均在 Linux Docker 内执行；Windows 宿主只发起 Docker 命令和读取结果）：

- AnyFusion-Pi 使用 Node 22 / Debian trixie CI 镜像通过 `npm run check`：Biome 检查 742 个文件且无自动修复，pinned dependencies、TS relative imports、shrinkwrap、`tsgo --noEmit` 与 browser smoke 全部通过；
- AnyFusion-Pi `./test.sh` 全量无密钥测试通过：agent 168 项、AI 412 项通过/727 项 Provider E2E 跳过、coding-agent 1283 项通过/44 项按既有环境规则跳过、TUI 690 项通过；随后 `npm run build:offline` 通过；
- AnyFusion-Pi 对 standalone Pi package lifecycle、project resources、custom themes/skills 与 project trust 的上游测试套件做了显式 fork exclusion；Planner policy、CLI 拒绝、固定 `.anyfusion` namespace 和只读资源测试覆盖产品边界，没有增加兼容模式或恢复这些能力；
- `fd` 使用 Linux `fd 10.2.0`；find/tool regressions 共 79 项通过，确认此前 bookworm `fd 8.x` 失败属于测试镜像版本问题；
- MetaClaw Linux Docker 内 `npm run lint`、全量测试和 Node 20 target build 全部通过：184 个测试文件通过、4 个文件按既有条件跳过，717 项通过、15 项跳过；
- `npm run smoke:metaclaw` 的容器内等价执行通过原生 Planner 双轮会话：同一 AnyFusion-Pi persisted session 正确记住并返回测试短语；
- artifact smoke 通过真实 Planner → authoritative validation → Kernel → Codex Executor 链路，在受管 workspace 创建并验证 `smoke-result.md`；
- 最终私网 SSH PTY 验证使用无宿主端口、禁用密码登录、无 Docker socket 的临时拓扑：欢迎页显示 AnyFusion 像素品牌、`Planner v0.80.2`、MetaClaw connecting/connected 与 `Tasks 0`；输入 `/ta` 后按 Tab，编辑器直接应用 `/task ` 并立即显示 `dashboard/list/clear/show/pause`；
- 一次性真实 `python-hello` 行为验证通过：Planner 在一个 turn 内提交有效 v6 proposal，Kernel 接受并持久化 Task/Work Graph，后台 Codex Executor 在受管 workspace 创建 `hello_world.py`；文件内容精确为 `print("hello world")`，独立执行输出 `hello world`；
- Planner MCP smoke 通过，8 个只读工具均可发现；proposal 提交仍唯一经过结构化 Host Protocol v2 与 `MetaclawSession.submitPlannerProposal()`；
- 最终镜像边界确认：AnyFusion Planner Node `v22.23.2`，MetaClaw control Node `v20.20.2`；镜像 ID 分别为 `anyfusion-pi-planner:local@sha256:eda1044d278d8742612802f51a9846f374e64023977c6129a147cc89c22dd392`、`metaclaw-runtime:latest@sha256:8736b5cf141dd0ac3e4eadbd7f5adf927f380649d8375fc5097baef8294659d8`、`metaclaw-tui-ssh:latest@sha256:8a526ed3a22250611cc581ca4a4097d2dc79f1578db14381cca2fa489a1f1668`。

首期提交后的发布跟踪项（不回退本次实现完成状态）：

1. dashboard live disconnect detection、自动 reconnect/backoff 与 snapshot age；
2. Gateway/Feishu 各自 surface 的真实 Provider 观察性 smoke；核心 RPC Planner session 已由双轮 smoke 覆盖；
3. 至少一次真实 upstream 前进/rebase rehearsal；
4. 远端 Linux 服务器部署后的观察期、视觉抽检和 artifact registry digest；当前记录的是本机 Docker content ID；
5. 依赖安全分流：当前 Planner install 报告 4 项 audit finding，MetaClaw builder 报告 9 项（含 1 项 critical）；不得在未评估 upstream/lockfile 影响时直接执行自动 `npm audit fix`。
## 计划目的

以一个完整 fork 的 Pi 仓库替换已经终止的 AnyFusion-Codex Planner TUI 路线，交付：

1. 完全 AnyFusion 品牌、无用户可见 Pi 文案的原生终端界面；
2. 由 AnyFusion 固定管理模型、Provider、权限和发布版本的 Planner runtime；
3. 统一服务本地 TUI、Gateway、Feishu 和其他非交互入口的唯一 Planner 实现；
4. 只读 AnyFusion Task/Subtask/Executor 看板；
5. 经 Pi 原生结构化工具和版本化 JSON 协议向 MetaClaw 提交 PlanningAgentPlan proposal；
6. 保持既有 Kernel、Work Graph、Storage、Execution、Executor、sandbox 和 Git publication 语义不变；
7. 保留 MetaClaw 现有 Ink TUI 源码、测试与依赖作为 standby 模块。

本计划只定义迁移、回滚、fork、接口、测试和发布工作。计划审核通过前不创建 fork、不回滚当前代码、不切换默认入口。

## 结论与已确认产品决定

本计划采用以下已经确认的产品决定，不在实施中重新讨论：

1. **统一 Planner runtime**：本地 TUI、Gateway、Feishu 和非交互入口全部使用 AnyFusion-Pi；不得保留 Codex Planner 作为并行 semantic router。
2. **只替换用户可见品牌**：所有用户和运维人员可见的 Pi 品牌、文案、路径、帮助、更新提示与产品链接替换为 AnyFusion；上游内部 package、import path、目录和 symbol 名可保留，以控制 fork 冲突。
3. **Planner 严格不执行用户工作**：Planner 只负责对话、只读查询、上下文获取和任务智能规划；不得编辑/写入用户项目，不得成为隐式 Executor。
4. **模型由 AnyFusion 固定管理**：用户不能自由登录 Provider、安装任意模型、切换账号或改变 Planner 权限；TUI 可以显示当前模型，但模型集合和凭证由 AnyFusion 配置决定。
5. **只保证 Linux runtime**：首期只交付 Linux 容器和 Linux 服务器；Windows 用户通过 Docker 使用，不设计原生 Windows Planner 进程或 named-pipe transport。
6. **仅作为 MetaClaw 自用 Planner 组件**：AnyFusion-Pi 不交付为独立用户产品，不维护 Pi 官方登录、账号 onboarding、OAuth/MFA 与多 Provider 用户体验等周边能力；只保留 MetaClaw 需要的对话、只读查询、规划与 proposal 能力。login/账号/onboarding 入口从 interactive 与 headless 两模式中入口级移除并加负向测试，代码保留以控制 upstream rebase 成本。完整 AnyFusion 品牌重做仍按 Phase 1/2 执行；Linux Planner artifact 仅服务 MetaClaw Docker，无公共发布渠道。

## 迁移依据与 Codex 路线终止

前序 Codex 方案的所有权和安全边界是正确的，但实现载体不可接受：

- Codex 是大型 Rust workspace；
- 本地无法在合理时间内完成编译；
- Linux 服务器经过数小时依赖下载和编译后仍未完成并出现资源饥饿；
- 为一项 Planner TUI 迁移承担该构建、发布和持续 rebase 成本不具备经济性；
- 继续投入不会改善 AnyFusion 的 Kernel 或 Executor 能力，只会扩大 presentation fork 的运维负担。

因此旧计划于 2026-07-31 标记为失败并归档。失败不推翻以下设计：

- Planner 提案、Kernel 决策、Executor 执行；
- Task 看板只读；
- Planner 与 MetaClaw 进程隔离；
- proposal 必须重新进入既有 validation 和 KernelWorkflow；
- Ink TUI 保留；
- Executor runtime 不随 Planner TUI 一同迁移。

Pi `0.80.2` 已在本机 Docker 完成源码级可行性验证：TypeScript 编译为秒级，底层 TUI 672 项测试通过，重点 interactive 测试 149 项通过，2 CPU/2 GB 限制下的构建与重点测试可在一分钟内完成。Pi 的主要风险是 TUI 耦合、默认在线模型目录生成和 fork 范围，而不是大规模原生编译。

## 权威文档与所有权

实施必须遵守：

- [ADR-0015：Planner-Owned Semantics And Tool-Mediated Context](../adr/0015-planner-owned-semantics-and-tool-mediated-context.md)
- [ADR-0020：Core Module Ownership And Dependency Direction](../adr/0020-core-module-ownership-and-dependency-direction.md)
- [ADR-0021：Work Graph v4 Subtask Execution Contract](../adr/0021-work-graph-v4-subtask-execution-contract.md)
- [ADR-0022：Unified Kernel Control Plane And Decision Ledger](../adr/0022-unified-kernel-control-plane-and-decision-ledger.md)
- [ADR-0023：Durable Kernel Workflow, Recovery And Availability](../adr/0023-durable-kernel-workflow-recovery-and-availability.md)
- [ADR-0024：Resource Partition, Sandbox And Runtime Elevation](../adr/0024-resource-partition-sandbox-and-runtime-elevation.md)
- [ADR-0025：Single-Task Concurrency And Git Publication](../adr/0025-single-task-concurrency-and-git-publication.md)
- [ADR-0026：Phase 6 Single-Task Reliability Closure](../adr/0026-phase-6-single-task-reliability-closure.md)
- [`CONTEXT.md`](../../CONTEXT.md)
- [当前技术总览](../current/technical-overview.md)

本计划不修改上述 ADR 的职责分配，只替换 Planner runtime adapter 和默认本地 presentation adapter。

## 不可突破的边界

### 1. Planner 只拥有语义理解和 proposal

AnyFusion-Pi 可以：

- 与用户自然语言对话；
- 维护 Planner conversation history；
- resume、fork、archive 和 compact Planner conversation；
- 查询受控的只读 Planner MCP；
- 读取显式提供的 repo/context 文件；
- 在只读 sandbox 中搜索和分析；
- 生成 `direct_reply`、`clarification`、`task_control`、`no_action` 或 `plan_work_graph` proposal；
- 通过 Application Shell adapter 提交 proposal。

AnyFusion-Pi 不可以：

- 直接写 MetaClaw SQLite；
- 直接调用 Repository；
- 直接发 Kernel event；
- 直接创建、更新或取消 Task/Subtask；
- 直接调度、切换、暂停或恢复 Executor；
- 直接处理 retry、fallback、replan、permission、availability 或 recovery policy；
- 直接编辑或写入用户项目；
- 直接提交 Git commit、发布 artifact 或完成 Subtask；
- 从 transcript、工具文案或自然语言回答推断权威 Task 状态；
- 通过 extension、MCP、slash command 或 shell 绕过 proposal validation。

### 2. Kernel 完全不变

不得修改：

- `ControlKernel.decide(event, snapshot)` Interface；
- Kernel event/snapshot/decision v5 语义；
- `DurableKernelWorkflow` 的 inbox、ledger、application、apply、replay 和幂等语义；
- Task admission、dispatch、retry、fallback、replan、availability、permission 和 cancellation policy；
- Work Graph v5 状态机、图规则、handoff、completion 和 publication contract。

TUI、Pi extension、Pi RPC adapter 和 Planner runner 均不得成为第二个 policy owner。

### 3. Execution 与 Executor 完全不变

不得修改：

- `src/execution/` 的 attempt、sandbox、lease、recovery、publication 和 Git 逻辑；
- `src/executor/` 的 AgentClass、registry、image、permission profile 和 probe 逻辑；
- Codex/Pi Executor 的执行协议；
- Docker sandbox、workspace、resource partition 和 capability security contract；
- Executor 使用的 stock Codex 或 Pi attempt runtime。

Planner fork 和 Planner Node 22 runtime 不得进入 Executor attempt image。

### 4. Storage contract 完全不变

本计划不新增：

- SQLite schema；
- Planner 专属 Task 状态；
- TUI 专属 durable state；
- Pi session 到 Task 的重复权威映射表；
- 为看板服务的第二套状态存储。

Pi conversation 文件属于 Planner runtime；Task/Kernel/Executor facts 仍属于 MetaClaw storage。

### 5. Ink TUI 必须保留

`src/tui/` 继续作为显式 standby 模块：

- 保留源码、fixture、测试源码和 Ink/React 依赖；
- 不归档、不删除、不改造成 Pi compatibility shim；
- 不要求与新 TUI 同步新增功能；
- 不承诺本计划内持续可运行或提供即时 hard rollback；
- 未来删除或恢复必须另立计划并单独批准。

## 仓库结构

### AnyFusion / MetaClaw

路径：

```text
D:\Internships\AnyInt\MetaClaw
```

负责：

- PlanningAgent Interface；
- AnyFusion-Pi process lifecycle adapter；
- Linux Unix-socket JSONL bridge；
- headless Pi RPC client adapter；
- Session 到 Pi session identity 的映射与单 writer 协调；
- Planner-safe snapshot projection；
- PlanningAgentPlan v6 authoritative validation；
- `plan_proposed -> DurableKernelWorkflow -> ControlKernel`；
- Docker runtime 装配、版本 pin 和集成测试。

MetaClaw 不保存 Pi 源码，不 import Pi package，不依赖 Pi 的 TypeScript 类型作为内部编译依赖。

### AnyFusion-Pi

计划路径：

```text
D:\Internships\AnyInt\AnyFusion-Pi
```

负责：

- 完整 Pi upstream fork；
- AnyFusion 品牌和 binary；
- AnyFusion 原生 Planner TUI；
- Planner conversation/session/history/compaction；
- 固定模型和 Provider 配置；
- Planner-only tool catalog；
- read-only dashboard client；
- 受限原生 `submit_planning_proposal` 工具；
- interactive 和 RPC 两种运行模式；
- Linux build、test、package；Linux Planner artifact 仅服务 MetaClaw Docker（无公共发布渠道）；
- upstream pin、patch series 和按需升级说明。

建议远端仓库名为 `MetaAny/anyfusion-pi`；创建远端属于实施阶段，不在本计划编写阶段执行。

### AnyFusion-Codex

`D:\Internships\AnyInt\AnyFusion-Codex` 和远端 `MetaAny/anyfusion-codex` 进入停止开发状态：

- 不继续编译或增加功能；
- 在 Pi 替代路线通过验收前不删除；
- 保留作为失败路线和已有 patch 的历史证据；
- Pi 默认切换并完成观察期后，再单独确认是否 archive/delete 远端。

## 目标运行结构

```text
Local terminal / Docker PTY
        |
        v
AnyFusion-Pi interactive process (Node 22, Linux)
  - AnyFusion TUI
  - conversation/session/history/compact
  - Planner-only read/query tools
  - read-only Task dashboard
  - runtime-bound proposal tool
        |
        | mode-0600 Unix socket, versioned JSONL
        v
MetaClaw Application Shell (Node 20)
  - process lifecycle
  - Session projection
  - authoritative proposal validation
  - single-writer/session coordination
        |
        v
plan_proposed -> DurableKernelWorkflow -> ControlKernel
        |
        v
Execution -> Executor attempts -> publication
```

非交互入口：

```text
Gateway / Feishu / backend client
        |
        v
MetaClaw Application Shell
        |
        | stdin/stdout JSONL RPC
        v
AnyFusion-Pi headless process (same fork, same policy/config)
        |
        | raw proposal returned to Application Shell
        v
same validation -> same Kernel path
```

本地 interactive 和 backend RPC 使用相同的：

- AnyFusion-Pi upstream pin；
- system prompt；
- PlanningAgentPlan v6 contract；
- tool policy；
- Provider/model 配置；
- rejection/revision/clarification 规则；
- session format；
- audit vocabulary。

它们是同一 Planner module 的两个 adapter，不是两套 semantic router。

## 进程与 Session contract

### 进程隔离

- MetaClaw 使用 Node 20；AnyFusion-Pi 使用 Node 22.19+；
- 两个仓库独立安装、构建、测试和发布；
- 不共享 `node_modules`；
- 不通过源码 import 或 workspace link 集成；
- 只通过版本化 JSON、环境变量、只读 schema/artifact 文件和进程退出码通信；
- Planner crash 不得导致 Kernel ledger、Task state 或 Executor attempt 损坏。

### PTY 与 transport

Pi interactive TUI 必须独占终端 stdin/stdout，因此：

- interactive 模式使用 Unix domain socket 作为控制/状态 side channel；
- socket 默认权限必须是 `0600`；
- headless RPC 模式使用 stdin/stdout JSONL；
- stderr 仅用于可诊断日志，不承载协议；
- 协议数据不得混入 TUI render stream；
- 首期不实现 Windows named pipe。

### Session identity

- 一个 live MetaClaw `sessionId` 映射到一个 Pi Planner session identity；
- Pi 拥有 conversation entries、history、fork、archive 和 compaction；
- MetaClaw 不把 SQLite interaction history 重放成 prompt；
- MetaClaw 只记录必要的 Planner run audit、continuation/session identity 和 redacted tool summary；
- 同一 Pi session 同一时刻只能有一个写进程；
- interactive 和 RPC process 不得并发写同一个 Pi session 文件；
- Application Shell 负责 serialize、attach、shutdown 和异常恢复；
- surface takeover 必须先关闭或释放原 writer，再由新 adapter attach；
- session 文件损坏或不可恢复时 fail closed，不静默创建第二个 conversation 并继续原 Task。

## Planner Host Protocol

协议必须有独立版本，不直接复用 Pi 内部 event type 作为 MetaClaw contract。

当前版本：

```text
AnyFusionPlannerHostProtocol v2
```

最小消息：

- `hello`：协议版本、runtime version、session identity、mode；
- `ping` / `pong`；
- `snapshot_get`；
- `snapshot_subscribe`；
- `snapshot`：只读 Planner-safe projection；
- `proposal_submit`：runtime identity、purpose 和 raw v6 plan；
- `proposal_result`：accepted/rejected/conflict/transport_uncertain 与 Kernel 权威结果；
- `shutdown`。

协议要求：

- JSONL framing；
- 最大单行 1 MiB；
- request id 和 turn id correlation；
- schema version 拒绝而不是猜测兼容；
- malformed/oversized message fail closed；
- proposal 顺序串行；
- snapshot 可以丢弃中间帧，但 proposal response 不可丢失；
- 不传输数据库 handle、Repository 对象、Kernel object 或 Executor control capability；
- 协议 fixture 同时在两个仓库验证，防止 silent drift。

## 原生 Proposal 工具

### 目标

Pi native conversation 必须保留用户友好的自然语言显示，同时每个语义 turn 通过受限原生工具提交严格的 PlanningAgentPlan v6 proposal。

### 建议实现

在 AnyFusion-Pi fork 内通过现有 custom tool composition seam 固定注入：

```ts
submit_planning_proposal({ plan: PlanningAgentPlanV6 })
```

1. 模型只能提供 `plan`；`sessionId`、`turnId`、`userInput` 和 deterministic `submissionId` 由 Pi runtime 注入；
2. native TUI 和 RPC 使用同一 tool、host protocol 和 MetaClaw submission path；
3. MetaClaw 使用现有 catalog、pending authorization、`PlanningAgentPlanSchema` 和 KernelWorkflow 重新校验并授权；
4. rejected 作为当前 ReAct turn 的结构化 tool result 返回，Agent 自然修正后可再次调用；
5. 第一个 accepted proposal 锁定 turn，工具 `terminate: true`，直接渲染 MetaClaw 权威结果；
6. identical submission 幂等重放；accepted 后 different submission 返回 conflict；
7. 不读取最终 assistant text，不解析 envelope，不修复 JSON 尾括号，不增加 proposal 专用 retry、repair prompt 或外层协调循环。

该实现不修改 Pi agent loop、message persistence protocol 或 MetaClaw Kernel contract，只使用 Pi 原生 tool 注册、执行和 terminate 机制。

### 失败语义

- schema/semantic validation 拒绝：返回结构化 issues，不产生 Kernel event；Agent 可在同 turn 自然修订；
- Kernel `reject_request`：返回结构化 Kernel reason，不锁定 turn；
- bridge/Kernel acknowledgement 不确定：返回 `transport_uncertain`，不得映射为 rejection，不得假装 Task 已创建或控制已执行；
- identical proposal：返回持久化的同一结果；accepted 后 different proposal：返回 conflict；
- Planner timeout/crash：保留 conversation recovery 信息，不合成 fallback plan；
- 不恢复旧 schema，不增加 keyword fallback、第二个 natural-language parser 或 assistant-text proposal parser。

## Planner 工具与权限

### 允许

- 现有只读 Planner MCP；
- `search_tasks`；
- `get_task_context`；
- `get_current_session_context`；
- `get_runtime_state`；
- `list_executor_status`；
- `get_executor_diagnostics`；
- 受控的文件读取、目录枚举、文本搜索；
- 在只读 workspace/sandbox 中执行经过 allowlist 的诊断命令；
- 读取明确传入的附件和上下文。

### 禁止

- Pi 原生 `edit` 和 `write`；
- 不受限 `bash`；
- `git commit`、`git push`、branch mutation；
- package/extension install、remove、update；
- 任意网络下载作为默认 Planner 行为；
- 修改 MetaClaw、用户仓库或 Planner config；
- write-capable MCP；
- Task/Executor mutation tool；
- 通过 shell 访问 Docker socket、MetaClaw database 或 Executor workspace；
- 把 approval UI 当作越过 Kernel permission contract 的授权入口。

Planner read-only shell 的具体 allowlist 和只读 mount 必须沿用 ADR-0015/ADR-0020 的 tool-mediated context 原则。不能因为 Pi 原生提供 coding tools 就保留它们。

## Provider、模型与配置

AnyFusion 管理所有 Planner runtime 配置：

- 固定 Provider base URL、模型 catalog 和默认模型；
- 凭证通过独立 Planner env/config 注入；
- 用户可查看当前模型，但不能登录任意 Provider 或切换账号；
- login、onboarding、账号管理和多 Provider 用户体验入口从 interactive 与 headless 两模式中入口级移除，并配负向测试；代码保留以控制 upstream rebase 成本；
- `/model` 若保留，只能在 AnyFusion allowlist 中选择；首期默认隐藏交互式切换；
- 禁用 self-update、version check、telemetry 和 upstream announcement；
- 禁用 Pi package manager 和任意 extension 安装入口；
- Planner config home 使用 AnyFusion 路径，不暴露 `.pi` 产品路径；
- Pi 内部 package/import 名可以保留；
- Executor 的 Provider/model 配置与 Planner 配置继续隔离。

默认源码构建不得联网刷新模型 catalog。生成的模型数据必须随 upstream pin 锁定；模型 catalog 更新是显式、可审核的独立操作。

## AnyFusion 原生 TUI

### 完整替换原则

本计划不是“保留 Pi TUI 加一个 extension”。AnyFusion-Pi 维护完整的 Planner presentation：

- AnyFusion 欢迎页、标题、状态栏、帮助和错误信息；
- AnyFusion conversation transcript；
- AnyFusion composer、completion 和快捷键提示；
- AnyFusion tool/approval rendering；
- AnyFusion session/history/resume/fork/archive/compaction UI；
- AnyFusion Task dashboard；
- AnyFusion provider/model 状态展示；
- AnyFusion branding assets、主题和 terminal title。

保留 Pi 原生 agent/session 能力，但不保留任何用户可见 Pi、Earendil、Mario、Dax、Clank 或 upstream promotion 文案。

### 基础布局

默认采用响应式双栏：

```text
┌──────────────────────────────────────────────────────────────────┐
│ AnyFusion header / Planner session / current model               │
├──────────────────────────────────────┬───────────────────────────┤
│ Conversation transcript              │ Read-only Task dashboard  │
│ tool/query rendering                 │ Task/Subtask/Executor      │
│ clarification/proposal feedback      │ progress/blocked/diagnostic│
├──────────────────────────────────────┴───────────────────────────┤
│ Composer / completion / status / key hints                       │
└──────────────────────────────────────────────────────────────────┘
```

响应式规则：

- 宽终端默认显示右侧 dashboard；
- 中等宽度允许折叠和手动 toggle；
- 窄终端使用 overlay 或独立 panel view；
- dashboard 不得挤压 composer 到不可用；
- dashboard render failure 不得中断 conversation；
- 不要求复刻现有 Ink TUI 的每个动画或像素。

### 看板首期字段

首期争取展示：

- 当前 Task ID、标题、目标和状态；
- ready/running/blocked/parked 数量；
- 当前 Subtask、依赖和 active attempt；
- 当前 Executor/AgentClass；
- blocked reason；
- pending authorization；
- 最近 Kernel/Task event；
- 最近 Executor diagnostic；
- completion、artifact 和 publication 状态；
- stale/unavailable/reconnecting 指示。

数据不足时缩小字段，不新增 Kernel event、Storage schema 或 Executor semantics。

### 看板只读要求

- 只消费 Session 提供的 Planner-safe projection；
- 不直接读取 SQLite；
- 不从 Pi conversation 推断状态；
- 不提供 start/stop/retry/switch executor mutation button；
- 用户的 Task 控制意图仍通过自然语言 Planner proposal 或现有确定性命令进入 MetaClaw；显式 slash command 只由 Pi TUI 原样传输，并由 MetaClaw `CommandCatalog` 解释和执行；
- dashboard polling/subscription 必须 bounded；
- stale snapshot 必须显示时间/状态，不伪装为实时事实。

## 品牌替换范围

必须建立用户可见字符串 inventory 和 allowlist 测试。

应替换：

- binary 和启动帮助中的 `pi`；
- welcome、help、footer、error、notification、announcement；
- terminal title；
- docs/support/update/privacy/telemetry 链接；
- theme schema title/description；
- session/config/cache 路径中用户可见部分；
- User-Agent 和可观测 runtime 名；
- package artifact 和 Docker image 展示名；
- upstream mascot、ASCII art 和图片；
- 模型可能读取并复述的 Pi 自我说明；
- command examples 和 shell completion 文案。

可以保留：

- `@earendil-works/pi-*` 内部依赖名；
- upstream package 目录；
- 不进入日志、帮助、UI 或用户文件的内部 symbol；
- 为 upstream rebase 必须保留的非产品注释。

若内部名字通过 stack trace、session 文件、config path、telemetry、HTTP header 或错误信息暴露给用户，则视为用户可见，必须替换或过滤。

## 源码与构建策略

### Fork 策略

- fork 整个 Pi monorepo；
- 保留 `upstream` remote；
- 固定 commit/tag，不使用浮动 `main`；
- 初始候选 pin 为已实测的 `0.80.2/ec6311b...`；
- Phase 0 最终确认 pin 后写入两个仓库；
- 不把完整源码 vendor 到 MetaClaw；
- 不依赖 Pi self-update；
- AnyFusion 发布只来自受控 CI/server build。

### Patch series

建议保持以下独立提交序列：

1. `chore: establish AnyFusion Planner fork baseline`
2. `build: add deterministic offline Planner build`
3. `feat(branding): replace user-visible Pi product identity`
4. `feat(planner): enforce AnyFusion model and tool policy`
5. `feat(tui): add AnyFusion Planner layout`
6. `feat(tui): add read-only Task dashboard`
7. `feat(planner): add native proposal submission tool`
8. `feat(protocol): add AnyFusion Planner host adapter`
9. `test: add branding, protocol and Planner boundary coverage`
10. `build: package pinned Linux Planner artifact`

禁止在 branding/TUI commit 中混入 agent loop、session storage、provider core 或 sandbox 语义修改。

### 可复现构建

必须新增 AnyFusion 专用离线构建命令：

```text
build:anyfusion-planner
  -> build pi-tui
  -> compile pinned pi-ai generated sources，不访问外部 model catalog
  -> build pi-agent-core
  -> build pi-coding-agent
  -> copy AnyFusion assets/config/schema
  -> produce Linux Planner artifact
```

不得在普通构建中调用 models.dev、OpenRouter、NVIDIA、Vercel 或其他动态 catalog API。

### Docker 缓存

- package manifests 在源码前 COPY；
- `npm ci` 使用 BuildKit cache；
- UI 源码变化不得破坏 dependency layer；
- build/test stage 与 runtime stage 分离；
- runtime artifact 不携带完整源码和 dev dependencies；
- Node 22 runtime 不进入 MetaClaw Node 20 dependency graph。

### 构建预算门

Phase 0 基线目标：

- 冷构建在本机 Docker 10 分钟内完成；
- 有依赖缓存的 UI 增量 build + focused tests 在 60 秒内完成；
- 2 CPU / 2 GB 内存下 focused gate 可以通过；
- 不需要 Rust、Cargo 或大型 native workspace 编译；
- 若连续两次正常网络冷构建超过 15 分钟，停止扩大 fork 并调查依赖闭包。

## MetaClaw 现有 Codex 迁移回滚与替换

不得 reset `QC` 或改写已推送历史。实施使用正常 revert/refactor commit，并保留无关工作。

### 删除的 Codex 专属内容

预计删除或恢复：

- `docker/anyfusion-codex.lock.json`；
- `docker/codex-config/planner/config.toml` 中 downstream TUI 专属配置；
- `scripts/anyfusion-planner-stop-hook.mjs`；
- `METACLAW_PLANNER_CODEX_HOME` 和 AnyFusion-Codex launcher 配置；
- AnyFusion-Codex binary/image pin；
- Codex Stop Hook 装配；
- Codex fork server handoff 文档；
- 只服务 Codex bridge/hook 的测试。

### 保留并泛化的内容

当前 `8413583` 中以下设计可以保留但必须去 Codex 命名：

- mode-`0600` Unix JSONL local bridge；
- `PlannerTuiSnapshot` 的只读 Session projection 思路；
- `submitPlannerProposal` 中重新执行 v6 schema/semantic validation；
- proposal submission serialization；
- default native Planner process + standby Ink mode selection；
- planning-to-kernel path regression tests。

建议重命名为 vendor-neutral interface，例如：

- `PlannerSurfaceBridge`；
- `PlannerSurfaceSnapshot`；
- `submitPlannerProposal`；
- `PlannerProcessAdapter`；
- `AnyFusionPlannerHostProtocol`。

这些 adapter 仍属于 Application Shell/presentation seam，不进入 Planning policy、Kernel 或 Storage owner。

### 替换的 Planner runtime

- `CodexPlanningAgent` 替换为基于 AnyFusion-Pi RPC 的唯一 PlanningAgent implementation；
- `planner-codex-runner.ts` 替换为 Pi headless RPC runner；
- native Codex thread/session identity 替换为 Pi Planner session identity；
- Planner `CODEX_HOME` 替换为隔离的 AnyFusion Planner home；
- Planner MCP 保持只读；
- Executor Codex 配置、attempt image 和 runtime 不变。

## 分阶段实施

### Phase 0：冻结 Codex 路线与 Pi fork 可维护性 spike

目标：在修改 MetaClaw 默认路径前证明 fork、build、TUI composition 和 Planner restriction 可成立。

工作：

1. 标记并归档 Codex 计划；
2. 冻结 AnyFusion-Codex 开发；
3. 创建 `D:\Internships\AnyInt\AnyFusion-Pi`；
4. 设置 origin/upstream 并记录 pin；
5. 建立 Node 22 Linux Docker build；
6. 增加离线 deterministic build；
7. 修改一处品牌和一个静态 dashboard slot；
8. 禁用 edit/write/package install/provider login；
9. 证明 interactive 与 RPC 使用相同 Planner配置；
10. 执行一次小范围 upstream 前进/rebase 演练并记录冲突。

退出条件：

- 不修改 Pi agent loop、session persistence protocol 或 provider core 即可完成；
- build/test 满足预算；
- 用户可见品牌替换可通过 inventory test；
- read-only tool policy 可强制执行；
- fork 冲突主要集中在 branding、interactive composition、Planner adapter 和 packaging。

### Phase 1：AnyFusion 品牌与受控 Planner runtime

- 替换用户可见产品身份；
- 建立 AnyFusion binary/config/cache/session 路径；
- 入口级移除 login、onboarding、账号管理和多 Provider 用户体验（代码保留以控制 rebase 成本）；禁用 self-update、telemetry、announcement 和 package manager；
- 固定 Provider/model；
- 建立 Planner-only tool catalog；
- 保留 conversation/history/resume/fork/archive/compaction；
- 添加品牌和权限负向测试；
- 尚不接入真实 Task dashboard 或 MetaClaw proposal。

### Phase 2：AnyFusion 原生 TUI

- 建立完整 header/transcript/composer/footer layout；
- 保留必要的 native conversation、tool rendering、interrupt、completion 和 session behavior；
- 增加响应式 dashboard composition seam；
- 实现宽/中/窄终端布局；
- 增加 snapshot/render tests；
- 不读取 MetaClaw，不修改业务状态。

### Phase 3：Planner Host Protocol 与只读看板

- 在 MetaClaw 泛化现有 Unix bridge；
- 在 AnyFusion-Pi 增加 protocol client；
- 接入 snapshot_get/subscribe；
- 展示 Task/Subtask/Executor/diagnostics；
- 接入 `command_complete/command_completion` 与 `command_submit/command_result`：前者只读取 MetaClaw CommandCatalog 补全状态，后者只透传用户明确输入的现有 MetaClaw 命令；
- 实现 loading、stale、unavailable、reconnect；
- 验证 dashboard failure 不影响 conversation；
- 不增加 Planner-authored 或通用 mutation message；命令 mutation 仍只发生在 MetaClaw 既有 CommandCatalog/Application-Shell 路径。

### Phase 4：原生 Proposal 工具与统一 PlanningAgent

- 实现 runtime-bound `submit_planning_proposal`；
- MetaClaw authoritative validation；
- rejection 在同一 ReAct turn 自然反馈和修订，无 proposal 专用 retry；
- 替换 Codex PlanningAgent/runner；
- Gateway/Feishu 使用 Pi RPC；
- local TUI 使用同一 system prompt、schema、tool policy 和 model；
- 确认不存在第二个 Planner implementation；
- 保留既有 `plan_proposed -> KernelWorkflow` 路径。

### Phase 5：Codex TUI 回滚与默认入口切换

- 选择性撤销 `8413583` 的 Codex-only 内容；
- 保留并泛化 vendor-neutral bridge/validation；
- 删除 Codex Stop Hook 和 downstream lock；
- MetaClaw 默认启动 AnyFusion-Pi Planner artifact；
- `anyfusion` 与 `metaclaw` compatibility alias 使用同一默认入口；
- Ink TUI 继续 standby；
- Executor runtime 无变化。

### Phase 6：Linux 发布与观察期

- 生成带 upstream commit、AnyFusion commit 和 digest 的 Linux artifact（仅服务 MetaClaw Docker，无公共发布渠道）；
- 在服务器运行真实 PTY smoke；
- 验证 Gateway/Feishu RPC；
- 验证 session resume/fork/archive/compaction；
- 验证 dashboard degradation；
- 验证 proposal reject/revision/conflict/transport-uncertain/timeout/crash；
- 运行 bounded 观察期；
- 不删除 AnyFusion-Codex 或 Ink TUI；
- 观察期后再单独决定废弃仓库清理。

本计划没有自动删除旧仓库或旧 Ink TUI 的 Hard Cut 阶段。

## Upstream 更新策略

AnyFusion-Pi 是 MetaClaw 自用组件，不设定期升级、不建立公共 release 渠道；升级按需触发（上游安全修复、关键缺陷或 MetaClaw 需求），并按固定顺序执行：

1. 记录当前 upstream pin、AnyFusion patch series 和 artifact digest；
2. checkout 新 upstream 候选，构建并测试未应用 AnyFusion patch 的 upstream；
3. 验证 deterministic offline build；
4. 依次应用 branding、Planner policy、TUI/dashboard、proposal/protocol patches；
5. 运行 upstream session/RPC/interactive tests 与 AnyFusion branding/tool-denial/dashboard/proposal tests；
6. 运行 MetaClaw bridge 和 Kernel regression；
7. 全部通过才更新默认 pin。

升级范围以冲突预算为界：若 fork delta 扩散到 agent loop、session storage、provider core、sandbox 或 MetaClaw Kernel，应暂停升级并缩小需求，而不是扩大长期 fork。无升级需求时不主动跟进上游。

## 测试计划

### AnyFusion-Pi build gate

- `npm ci --ignore-scripts` 可复现；
- offline build 不访问动态 model catalog；
- Node 22 Linux build；
- 2 CPU/2 GB focused build/test；
- dependency cache 命中后的增量预算；
- artifact 可输出版本、upstream commit 和 AnyFusion commit。

### Pi 原生能力回归

- conversation 新建、resume、fork、archive；
- manual/automatic compaction；
- completion、interrupt、tool rendering；
- session recovery；
- RPC prompt/event/idle/shutdown；
- 不同终端尺寸；
- Linux PTY input、resize、signal 和 exit。

### 品牌回归

- 欢迎页、标题、帮助、错误、状态栏、链接和 assets；
- `pi`、Earendil、upstream mascot/announcement 的用户可见字符串扫描；
- binary/config/session/cache/user-agent 名；
- stack trace 和错误输出过滤；
- 仅允许内部 dependency/import allowlist 出现 upstream 名。

### Planner 权限负向测试

必须证明：

- edit/write 不注册；
- unrestricted bash 不可用；
- package/extension install/update 不可用；
- provider login/account switch 不可用；interactive 与 headless 均无法触达 login/onboarding/账号入口；
- Task/Executor mutation 不可用；
- Planner 无法访问 SQLite、Docker socket 或 Executor workspace；
- dashboard 不产生 mutation；
- proposal bridge 不能直接生成 Kernel decision；
- 模型诱导和 prompt injection 不能恢复被禁工具。

### TUI 与 dashboard

- 宽/中/窄布局；
- show/hide/collapse/overlay；
- loading/stale/unavailable/reconnect；
- snapshot burst/coalescing；
- conversation 在 dashboard failure 下继续；
- stale data 不显示为实时；
- Task/Subtask/Executor 字段只来自 projection；
- 无 mutation button 或隐藏快捷键。

### Proposal 与 protocol

- valid proposal accepted；
- invalid schema rejected；
- catalog/authorization semantic failure rejected；
- validation/Kernel rejection 后同 turn 修订；
- accepted replay、accepted turn lock 和 different-submission conflict；
- transport uncertain 与 validation rejection 严格区分；
- oversized/malformed JSONL rejected；
- socket permission `0600`；
- protocol version mismatch rejected；
- Planner crash/restart；
- Session writer takeover；
- bridge unavailable；
- proposal accepted 后仍只通过既有 KernelWorkflow。

### Unified Planner surfaces

- local TUI、Gateway、Feishu 产生同一 v6 contract；
- 三个入口使用相同 Provider/model、system prompt 和 tool policy；
- 同 session 不并发写 Pi session file；
- Gateway/Feishu 不回退 Codex Planner；
- local TUI unavailable 不引入关键词或旧 schema fallback；
- 两轮 conversation 在同一 Pi session 上保持上下文。

### MetaClaw 核心回归

- `npm run lint`；
- focused Planner/Session/bridge tests；
- Docker full Vitest；
- container build；
- Planner-to-Kernel path；
- Kernel/Execution/Executor/storage regression；
- smoke:anyfusion conversation；
- artifact smoke；
- Git diff 不包含未经独立批准的 Kernel/Execution/Executor 逻辑修改。

## 安全与故障降级

- Planner socket `0600`；
- Planner env/config 不复用 Executor secrets；
- protocol 日志 redacted；
- proposal 和 snapshot 有大小上限；
- dashboard client 断开只影响展示；
- Planner process crash 不取消已运行 Task；
- MetaClaw shutdown 负责终止/回收 Planner child；
- orphan Pi writer 必须在 attach 前检测；
- session corruption fail closed；
- 不自动下载 extension、model、binary 或 update；
- Planner artifact 必须 pin digest；
- 不把 Planner tool approval 映射成 Kernel permission approval。

## 明确不做

- 不保留 Codex Planner 作为 fallback semantic router；
- 不修改 Kernel、Work Graph、Storage、Execution 或 Executor contract；
- 不修改 SQLite schema；
- 不让 Planner 编辑用户项目；
- 不让 Planner直接完成 Subtask；
- 不新增 write-capable Planner MCP；
- 不在首期支持原生 Windows Planner；
- 不实现 Windows named pipe；
- 不开放用户 Provider 登录和任意模型切换；
- 不开放 Pi package/extension marketplace；
- 不维护 Pi 官方登录、账号 onboarding、OAuth/MFA 与多 Provider 用户体验；
- 不建立独立公共发布渠道（Linux Planner artifact 仅服务 MetaClaw Docker）；
- 不把完整 Pi 源码复制进 MetaClaw；
- 不删除 Ink TUI；
- 不立即删除 AnyFusion-Codex 仓库；
- 不要求复刻 Ink TUI 的全部视觉细节；
- 不在本计划中升级 MetaClaw Node 20 runtime。

## 文档影响

实施时需要同步：

- `CONTEXT.md`：Codex PlanningAgent/thread 改为 AnyFusion-Pi Planner session/runtime；
- `AGENTS.md`：默认本地表面、进程隔离、fork build 和验证规则；
- `docs/current/technical-overview.md`；
- `docs/current/technical-overview.zh-CN.md`；
- `docs/README.md`；
- Planner/Executor 配置说明；
- Docker/server deployment；
- AnyFusion-Pi 按需升级说明（无公共 release 渠道）；
- AnyFusion-Pi 自身 `AGENTS.md`、README 和 architecture notes。

不得借文档同步改变 Kernel/Executor ownership。

## 停止条件

出现以下任一情况必须停止当前 phase 并重新评审：

- 需要修改 Pi agent loop 才能提交 proposal；
- 需要修改 Pi session persistence protocol 才能显示 AnyFusion TUI；
- 需要让 Planner 获得 edit/write/unrestricted shell；
- 需要让 dashboard 直接读 SQLite 或控制 Executor；
- 需要修改 MetaClaw Kernel、Execution 或 Executor 才能接入；
- interactive 和 RPC 无法共享同一 Planner semantic implementation；
- 同一 Pi session 无法建立可靠 single-writer contract；
- fork delta 持续扩散到 provider core、sandbox 或无关 package；
- 有缓存增量 build/test 不能控制在合理分钟级；
- 用户可见 Pi 品牌无法通过 bounded patch 隐藏；
- upstream 更新一次即要求大面积重写 agent core。

## 完成标准

- `AnyFusion-Pi` 完整 fork 存在于 MetaClaw 平级目录并记录 upstream pin；
- 用户界面、帮助、路径、链接和 artifact 无用户可见 Pi 品牌；
- 本地 TUI、Gateway、Feishu 使用唯一 AnyFusion-Pi Planner runtime；
- Planner 模型和 Provider 由 AnyFusion 固定管理；
- Planner 无 edit/write、unrestricted shell、package install 或 Task mutation 能力；
- conversation、history、resume、fork、archive 和 compaction 可用；
- AnyFusion 响应式 TUI 和只读 dashboard 可用；
- dashboard failure 不影响 conversation 或 Task 执行；
- proposal 经 MetaClaw authoritative validation 后进入既有 KernelWorkflow；
- Kernel、Work Graph、Storage、Execution、Executor 和 sandbox 设计无变化；
- MetaClaw Node 20 与 Planner Node 22 进程隔离；
- Linux Docker/server build、test、PTY smoke 通过；
- offline deterministic build 不访问动态 model catalog；
- Ink TUI 完整保留；
- AnyFusion-Codex 不再是默认路径且未被未经批准删除；
- 至少完成一次真实 upstream rebase 演练；
- 两个仓库记录最终 commit、artifact digest、验证证据和观察期结果。

## 完成记录

- 完成日期：2026-08-03（结构化提交链路与本机 Linux Docker 最终验收）；
- 最终 Pi upstream：`earendil-works/pi@ec6311beb5b24fc918e5031173608447582d7262` / `0.80.2`；
- AnyFusion-Pi TUI 基线提交：`d9e22904 feat(planner): complete native TUI integration`；
- AnyFusion-Pi structured proposal closing commit：`b0d5ff784fab feat(planner): submit structured proposals natively`；
- MetaClaw closing commit：包含本完成记录的本地提交；
- Linux artifact content ID：
  - `anyfusion-pi-planner:local@sha256:eda1044d278d8742612802f51a9846f374e64023977c6129a147cc89c22dd392`；
  - `metaclaw-runtime:latest@sha256:8736b5cf141dd0ac3e4eadbd7f5adf927f380649d8375fc5097baef8294659d8`；
  - `metaclaw-tui-ssh:latest@sha256:8a526ed3a22250611cc581ca4a4097d2dc79f1578db14381cca2fa489a1f1668`；
- Docker build/test：AnyFusion-Pi check、`./test.sh`、offline build 全部通过；MetaClaw lint、717 项全量测试和 Node 20 build 全部通过；
- smoke：Planner 双轮 persisted-session smoke、真实 Codex artifact smoke、Planner MCP smoke、私网 SSH PTY welcome/dashboard/completion smoke及真实 `python-hello` 执行全部通过；
- upstream rebase rehearsal：未执行，列为发布跟踪项；
- 观察期与已知限制：远端服务器观察期、dashboard reconnect/age、Gateway/Feishu surface smoke 和 dependency audit 分流待后续；
- AnyFusion-Codex：失败方案已归档于 `docs/archive/plans/2026-07-30-codex-native-tui-migration.md`，本次不删除 Executor Codex 或其他兼容资产。

### 2026-08-01 文本 envelope 修复（已废弃历史）

该修复曾用于缓解 assistant 文本 JSON 尾括号缺失，但没有消除文本解析链路的脆弱性。2026-08-02 的原生 proposal 工具迁移已删除 envelope parser、尾括号恢复和外层 repair；以下内容只保留为根因与镜像验证历史，不代表当前实现。

- Root cause: the configured Planner model could return a complete `PlanningAgentPlan v6` inside `{ "displayText", "plan" }` while omitting only the envelope's final `}` at EOF. The assistant message was persisted with `stopReason: "stop"`, so this was a model formatting defect rather than token truncation; strict JSON parsing then produced `Planner response did not contain a PlanningAgentPlan v6 proposal.`
- AnyFusion-Pi correction commit: `e86f543b fix(planner): recover truncated proposal envelopes`.
- Recovery remains presentation-adapter-only: it repairs exactly one missing trailing object close when braces/arrays/strings are otherwise balanced. More extensive truncation and unterminated strings remain rejected, and every recovered plan still passes MetaClaw's authoritative v6 schema and policy validation.
- `docker/shell.ps1` now binds SSH only to `127.0.0.1:2222` and recreates a shell whose bound image ID no longer matches `metaclaw-tui-ssh`, preventing silent reuse of a stale TUI container after image rebuilds.
- Linux validation after the correction:
  - AnyFusion-Pi Node 22/fd 10.2 image: no-write Biome check (740 files), full `npm run check`, full `./test.sh`, and `npm run build:offline` passed;
  - MetaClaw Linux image: `npm run lint`, full test suite (703 passed / 15 skipped), and Node 20 `npm run build` passed;
  - isolated PTY reproduction changed from the exact warning to `REPRO_GREEN_PROPOSAL_ACCEPTED`;
  - formal `metaclaw-shell` image ID matched the current tag, SSH inspection showed only `127.0.0.1:2222`, and the same user request created an accepted v6 Task/Work Graph. The one-off smoke task was then cancelled through `/task clear all`.
- Corrected Linux artifacts:
  - `anyfusion-pi-planner:local@sha256:0e65b6ef297bbd49cc78d8004747471f9c4025010008256deee9030515a20442`;
  - `metaclaw-runtime:latest@sha256:f98e1c281841c8ec58b5fa97fb7302c6260449bab6eced3ef8bf0cb5dccdb4dc`;
  - `metaclaw-tui-ssh:latest@sha256:7519e7d522ab522a1aa8f0944487ebaff9105f449b9c6aae4914546117c71758`.
- MetaClaw correction commit: the local commit containing this completion record; not pushed.

### 2026-08-02 原生 proposal 工具迁移

- AnyFusion-Pi 固定注入 `submit_planning_proposal({ plan })`；模型只提供 v6 plan，runtime 注入 session/turn/user input/submission identity；
- native TUI 与 RPC 共用 Host Protocol v2 和 `MetaclawSession.submitPlannerProposal()`；
- validation/Kernel rejection 作为当前 ReAct turn 的结构化反馈返回，不设 proposal 专用 retry、repair prompt 或外层协调循环；
- accepted 后 terminate 并锁定 turn；相同 submission 持久化幂等重放，不同 submission 返回 conflict；
- `transport_uncertain` 与 rejection 分离，要求 identical replay；schema 29 持久化 proposal turn/submission 状态；
- assistant-text envelope parser、尾括号修复、agent-end finalizer 和 deprecated `submitPlannerTuiPlan` 兼容入口已删除；
- 所有构建、测试、smoke 与真实交互仅在 Linux Docker 中执行；最终测试数量、镜像 digest 和两仓 closing commit 已在完成记录中补录。

### 2026-08-03 提交生命周期纠正与第四步清理

- `proposal_submit` 在 MetaClaw validation、Kernel 授权及 Task/Work Graph 持久化成功后立即返回 `accepted + taskId`，不等待 Executor；Executor 在后台启动，后续进度或失败仅通过已有 snapshot/事件投影报告；
- `transport_uncertain` 只表示 Kernel 授权或持久化结果不确定；`in_flight` 有显式结构化结果，不依赖数据库 `INSERT OR IGNORE` 偶然兜底；
- PlanningAgentPlan 在 MetaClaw Session 摄入边界唯一归一化，空白 `taskId` 规范为 `null`；Kernel 存在性检查和 Task Engine 主键写入继续 fail-closed，Pi 的联合类型 coercion 则优先按 JavaScript 实际类型匹配 `anyOf` 成员；
- Bridge 删除 `sessions.get('*')` 与可选 session 兼容路径，只允许精确匹配已绑定真实 session；错误 session 有负向测试并 fail-closed；
- `PlanningAgent.submit` 改为强制接口，删除 Session 外层 `plan -> submit` fallback、外层 repair/recovery loop 和旧 Codex planning alias；Native TUI 与 RPC 只保留同一结构化提交入口；
- 删除无调用方的 `llm-json` 文本 JSON 截取器、旧 planner envelope、尾括号修复及未使用的终态判断 helper；保留 Kernel 内部重规划仍需要的 `PlannerProposalPurpose: 'validation'`；
- 最终 Linux Docker 验收：AnyFusion-Pi `npm run check` 与 `./test.sh` 全量通过；MetaClaw lint、184 个测试文件/717 项测试、Node 20 build 全部通过；Session、Artifact、Planner MCP 和真实 `python-hello` smoke 全部通过。
