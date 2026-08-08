# ADR-0020: Core Module Ownership And Dependency Direction

- Status: Accepted
- Date: 2026-07-17
- Scope: Planner、工作图、路由事实、Kernel、Task、Execution Runtime、Executor、资源模型及其外围适配层
- Governs: [Planner、Kernel 与并发调度收敛路线图](../plans/2026-07-16-planner-kernel-concurrency-convergence-roadmap.md) 及其后续阶段实施计划

## Context

MetaClaw 已经按职责把源代码放入 `planning/`、`kernel/`、`task/`、`execution/`、`executor/`、`session/` 和 `storage/` 等目录，但目录分类尚未形成稳定模块架构。当前实现仍存在以下问题：

- `TaskRuntimeService` 同时暴露 Task CRUD、状态迁移、会话焦点、优先级、抢占、自动恢复和调度入口；
- `SessionExecutionCoordinator` 同时承担执行编排、失败判断、Task 落态、恢复、验收、交付和界面输出；
- 工作图规则在 `planning/` 下，却同时被 Planner 和 Kernel 当作共同结构事实；
- Execution Runtime 仍接收 Planner plan 类型，而不是只接收 Kernel 已授权的命令；
- `KernelExecutorStatusProjector` 位于 Kernel 子系统并直接写 Repository，使“Kernel 子系统”和“纯 Kernel 决策模块”两个层级混在一起；
- commands、TUI、Session 和 Storage 之间仍存在绕过应用接口的直接依赖。

如果直接把现有目录职责写成最终架构，后续路线图会把当前耦合固化。反过来，一次性搬迁所有文件又会扩大正在实施的并发收敛路线图。需要先固定逻辑模块、职责归属和依赖方向，再由各阶段在触及相关代码时逐步迁移。

## Decision

### 1. 固定控制主轴

MetaClaw 的控制主轴固定为：

```text
Planner proposes
  -> Kernel decides
  -> Runtime applies side effects
  -> Runtime reports normalized facts
  -> Kernel decides the next strategic action
```

Planner 输出提案，不产生执行授权。Kernel 是战略决策的唯一最终解释者。Runtime 执行 Decision、维护副作用状态并上报事实，不自行决定 retry、fallback、park、replan、preempt、circuit 或 partition admission。

### 2. 模块不是目录同义词

“模块”指拥有稳定职责和小型公开 Interface 的逻辑单元；`src/` 目录只是当前物理布局。一个物理目录可以在迁移期包含多个逻辑模块，但不得把这种临时共存解释为允许循环依赖或混合职责。

后续解耦计划可以调整目录、文件和模块 README，但不得改变本 ADR 规定的职责归属，除非先用新的 ADR 明确修订。

### 3. 核心模块及职责

| 模块 | 拥有 | 不拥有 | 目标公开 seam |
| --- | --- | --- | --- |
| Planning | 自然语言语义理解、Task 绑定提案、工作图生成与 repair、Planner 上下文和审计安全边界 | 授权、Task 落态、Executor 调用、工作图持久化 | `plan(context) -> plan` |
| Work Graph | 工作图提案/拓扑契约、纯结构验证、DAG 派生、runnable frontier、依赖关系和 handoff 引用规则 | Subtask 运行状态、AgentClass 健康策略、claim、执行、存储 | 纯验证与派生函数 |
| Executor Registry | `executors.yaml` 配置校验、Capability/Profile/Executor 定义、digest、验证绑定、四类受控 snapshot projection、健康投影词汇 | dispatch、fallback、Task 状态、进程生命周期 | 加载/注册应用服务、不可变 snapshot 与投影类型 |
| Control Kernel | Plan admission、dispatch、冲突、失败恢复、fallback、retry cap、熔断、抢占、capacity 和 partition 授权策略 | Repository、claim、heartbeat、Adapter 调用、原始日志解析、消息投递 | 单一 `decide(event, snapshot) -> decision` |
| Task Domain | 持久 Task/Subtask 的运行生命周期、状态迁移不变量、当前事实和领域命令 | 工作图提案结构、下一战略动作、Executor 路由、重试/恢复政策 | 小型领域命令与查询接口 |
| Execution Runtime | Kernel Decision 应用、工作图物化/恢复、execution context、attempt、WorkUnit、claim/release、heartbeat、调用 Executor、产生 Runtime facts | retry/fallback/replan/park 等战略判断 | Decision apply 与事实上报接口 |
| Executor Port / Adapters | 单次执行、进程生命周期、probe/abort、把退出码和原始错误规范化为稳定执行事实 | Task 状态、AgentClass 选择、候选切换、恢复政策 | `probe`、`execute`、`abort` 等外部适配 seam |
| Resource Model | Phase 5 引入的 partition identity、访问模式、冲突判断、lease 不变量 | 调度政策和实际文件操作 | 纯冲突/授权事实与 Runtime lease 操作契约 |

`memory/`、`guidance/`、`learning/`、`delivery/` 和 integrations 保持各自领域归属，不因本路线图被吸收到 Kernel 或 Execution Runtime。它们与核心执行链的具体 seam 留给独立解耦计划。

### 4. Application Shell 与 Persistence 是外围层

`session/`、`commands/`、`tui/`、`gateway/` 是 Application Shell。它们负责入口、依赖组装、事件触发、调用核心模块和界面投影，不拥有业务策略。目标 Session 循环只做：

```text
observe -> build event/snapshot -> decide -> apply -> observe
```

`storage/` 是持久化 Adapter 集合，不是全局领域模块。Repository 接口应由使用它的领域或应用模块拥有，SQLite 实现位于 Storage。核心领域模块不得依赖具体 SQLite Repository；Commands、TUI 和 Gateway 也不得绕过应用 facade 直接操作 Repository。

只有最外层 composition root 可以导入具体 Storage/Executor Adapter 来完成依赖装配；装配完成后，应用服务和核心模块只能持有其公开 port。

### 5. 固定依赖方向

允许的主要依赖方向为：

```text
Application Shell -> Planning / Control Kernel / Execution Runtime / Task queries
Planning          -> Work Graph / Executor Registry Planner projection
Control Kernel    -> Work Graph / Executor Registry projections / Task facts / Resource facts
Execution Runtime -> Work Graph / Task Domain / Resource Model / Executor ports / persistence ports
Adapters          -> their owned contracts and external systems
Storage           -> domain value types and persistence ports
```

禁止：

- Kernel 依赖 Session、Execution Runtime、具体 Executor Adapter 或 Storage；
- Planning 依赖 Kernel、Runtime Repository 或 Executor 进程实现；
- Execution Runtime 依赖 PlanningAgent 实现，或解释未经 Kernel 授权的 Plan；
- Executor Adapter 反向调用 Session、决定 Task 落态或选择 fallback；
- UI/Commands/Gateway 直接依赖具体 Repository；
- 核心模块之间出现循环依赖；
- 为测试方便而给生产 Interface 增加仅测试使用的入口。

跨模块值类型由语义 owner 定义。消费者只能依赖 owner 的公开契约，不得复制一份近似类型或从 Storage 表结构反推领域契约。

### 6. Kernel 只解释事实，不提取原始事实

Executor Adapter 或 Runtime 负责把退出码、超时、原始异常和外部响应规范化为稳定的 `ExecutionOutcome`、`CapacitySignal` 等事实。Kernel 根据这些事实决定下一步动作。

因此，原始错误文本正则、CLI stderr 解析、Repository 查询和时钟读取不得成为 Kernel policy 的隐藏副作用。时间、容量、健康和历史 attempt 等决策输入必须通过 event/snapshot 显式提供。Kernel 内部可以拆成多个 policy 模块，但对调用者只暴露统一决策 Interface。

### 7. 统一工作图与状态投影归属

`validateWorkGraphStructure` 的逻辑 owner 是 Work Graph 模块，而不是 Planning。Planner 和 Kernel 都是消费者；Execution Runtime 只能消费已授权图及其纯派生结果。当前文件位于 `src/planning/` 是迁移期物理布局，后续第一次扩展 handoff/frontier 时应迁入独立 Work Graph 入口，不能继续增加对 Planning 内部路径的依赖。

Executor Registry Snapshot 及其 TUI、Planner、Kernel、Runtime 投影契约属于 Executor Registry 模块。Planning 只能消费 Planner projection；Control Kernel 只能消费候选、Capability 覆盖、digest 和健康事实；Execution Runtime 只能消费 Kernel 已授权 Executor 对应的 Runtime binding。任何消费者都不得重新读取 YAML、复制静态目录或按 Executor 名称推导命令、home、环境、worktree、evidence、结果收集和 continuation 行为。

Kernel Executor Status Projection 的稳定词汇和数据契约属于 Executor Registry 控制面契约；系统性健康转换、熔断和恢复解释属于 Control Kernel；读取 Runtime facts、应用投影并写 Storage 属于 Runtime/持久化 Adapter。ADR-0017 中“Kernel subsystem owns projection semantics”指逻辑控制面所有权，不授权纯 Kernel 模块直接写 Repository。当前带 Repo 的 `KernelExecutorStatusProjector` 是迁移期应用服务，不是未来 Kernel public Interface。

Executor 注册、发现、验证、启停和 reload 是 Application Service。CLI、slash command 和 AnyFusion-Pi 只能调用该服务；Pi 不得直接写 `executors.yaml`、verification 表或 Kernel 状态。配置加载失败时由 Registry Service 保留上一份有效 snapshot。Task purge 同样是 `task/` 拥有的受控 Application Service；UI/Commands 不能绕过它建立删除授权或直接删除 immutable Task facts。

### 8. 路线图阶段设计门

总路线图的每个阶段实施计划必须在动工前记录：

1. 受影响模块及每项行为的唯一 owner；
2. 新增或修改的公开 Interface 及其消费者；
3. 允许与禁止的依赖方向；
4. 将删除或迁移的旧跨模块入口和并行策略分支；
5. 临时例外、原因、最迟删除阶段；
6. 对应的模块边界测试、Decision 测试和容器验收证据。

新增代码必须立即遵守本 ADR。旧代码可以按路线图分阶段迁移，但不得新增调用方、扩大公开 surface 或把现有违规作为新设计范例。若一个阶段触及现有违规 seam，应在同阶段完成收敛，或在实施计划中记录有明确删除阶段的例外。

## Consequences

- PlanningAgent 和 Control Kernel 形成小而稳定的高杠杆 Interface；复杂策略可以在模块内部增长，而不会散到 Session/Runtime。
- Work Graph 与 Executor Registry projection 成为独立共享语义，避免 Kernel 依赖提案方内部实现，也避免 Planner/Kernel/Runtime 各自复制规则。
- Task Domain 只保留生命周期不变量；当前 `TaskRuntimeService` 中的调度、抢占和自动恢复策略必须在相关阶段迁入 Kernel，应用编排迁入 Runtime/Application Shell。
- `SessionExecutionCoordinator` 的目标不是成为更大的统一服务，而是逐步变薄为 decide/apply/observe 协调器。
- Storage schema 不再充当跨模块 Interface；持久化替换和纯模块测试更容易。
- Resource Model 在 Phase 5 才固定具体数据结构，但其职责位置和依赖方向现在已经确定，不会再把 partition policy 写入 Session 或 Executor。
- 模块 README 的范围、模板和物理目录在专门解耦计划中决定；本 ADR 先提供 README 必须描述的权威职责。

## Existing ADR Alignment

- 已归档的 ADR-0001～ADR-0010 描述 `ExecutionPolicy`、`CapabilityClass`、Semantic Router 和 LLM 三信号 dispatch 等历史架构，统一由 ADR-0015、ADR-0018、ADR-0021、ADR-0023 和本 ADR 取代。
- ADR-0011 的单活跃顶层 Task 产品约束继续有效；Session `TaskAdmissionGate` 已在 Phase 3 删除，admission 决策已归 Control Kernel。
- 已归档 ADR-0012 的持久 Task/Subtask/WorkUnit 事实和 Session-as-projection 规则已吸收到 ADR-0021/ADR-0023；工作图验证归 Work Graph/Kernel，资源授权归 Kernel，副作用归 Runtime。
- 已归档 ADR-0013 的 Task/Subtask/AgentClass/WorkUnit 词汇由 ADR-0020/ADR-0021/ADR-0023 接管；“Planner 是 dispatch owner”被“Planner 提案、Kernel 决策”取代。
- 已归档 ADR-0014 的 PlanningAgent/Kernel/Runtime 主链由 ADR-0015、ADR-0020 和 ADR-0022 吸收；`direct_reply` 专用 Kernel 入口已在 Phase 3 删除，统一 `decide` seam 已落地。
- ADR-0015 的 Planner 语义所有权、隔离 runner 和只读上下文继续有效；v2 schema、WorkUnit-only health、Runtime 战略 fallback 和 direct-reply 特例由后续 ADR 取代。
- 已归档 ADR-0016 的静态 catalog 注入与版本规则已吸收到 ADR-0018；当前图契约由 ADR-0021/ADR-0023 定义，共享图规则的逻辑 owner 由本 ADR 明确为 Work Graph。
- ADR-0017 的状态投影词汇和 Planner-safe 读取继续有效；`unverified` 不可路由，持久化写入不属于纯 Kernel，当前偏好列表与 fallback 行为以 ADR-0023 和本路线图为准。
- ADR-0018 的受控 Routing Capability 与 host-level Executor Registry authority 继续有效；`executors.yaml` 及其 digest-bound snapshot 取代 canonical built-in definitions 和 `agent_classes` 静态来源。
- 已归档 ADR-0019 记录 v3 工作图与审计迁移；当前 Planner/Kernel 认证和 Runtime 不得合成 fallback 图的规则由 ADR-0021/ADR-0023 及本 ADR 共同约束。

## Not Decided Here

- 最终目录树、文件搬迁顺序和哪些模块需要专属 README；
- Task Domain 与 Execution Runtime 的内部类拆分；
- Repository port 的具体数量和命名；
- Resource Model 的最终字段、lease API 和 worktree 策略；
- Memory、Guidance、Learning、Delivery 等非本路线图领域的完整解耦方案。
