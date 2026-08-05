# Planner、Kernel 与并发调度收敛路线图

## 计划状态

- **计划日期**：2026-07-16
- **当前状态**：已完成；Phase 1～6 全部退出条件均已满足
- **当前激活阶段**：无
- **最近交付阶段**：Phase 6 [最终可靠性收口计划](../archive/plans/2026-07-28-phase-6-single-task-reliability-closure.md)；单 Task DAG 并发、持久取消、generation replan、Git publication 和严格完成门已交付
- **已完成前置**：Codex/Pi canonical capability definitions、Planner-safe catalog、Seeder 与 Adapter binding 已统一
- **架构指引**：[ADR-0020：核心模块归属与依赖方向](../adr/0020-core-module-ownership-and-dependency-direction.md)；所有后续阶段实施计划和代码改动必须遵守
- **实施方式**：各阶段已按单一 schema、单一 Kernel 路径完成 hard cut
- **完成日期**：2026-07-28
- **实现提交**：见 Phase 6 最终可靠性收口计划的完成记录

## 一、路线图目标

本路线图接管以下尚未完成的目标：

1. 让 Planner 按能力交接边界设计 Subtask，而不是按操作步骤拆分。
2. 让依赖图成为 Subtask 合并、串行和未来并行的唯一结构依据。
3. 保证一个 Subtask execution attempt 在同一时刻只对应一个具体 WorkUnit。
4. 将调度、失败恢复和资源授权决策收敛到 Kernel 控制面，Runtime 只执行决策和副作用。
5. 建立 workspace/resource partition、持久租约和崩溃恢复后，再启用真正并发。

本路线图不要求一次完成全部目标。每个阶段都必须形成可独立验收的最终形态，不保留为了下一阶段而存在的临时兼容路径。

本路线图只规定跨阶段能力收敛顺序；模块职责、公开 seam、依赖方向和 Application Shell/Storage 的外围定位由 [ADR-0020](../adr/0020-core-module-ownership-and-dependency-direction.md) 规范。若阶段实施细节与该 ADR 冲突，必须先修订 ADR，不能以现有目录布局或历史调用路径作为例外依据。

## 二、当前基线与问题拆分

### 2.1 已完成的能力底座

Canonical definitions 已经是 Codex/Pi 静态路由能力、Planner catalog、Seeder AgentClass 投影与 Adapter binding 的唯一来源。动态健康与近期执行状态继续由 `list_executor_status` 提供。

能力事实源、Planner required capabilities、Kernel canonical coverage 和完整有序 AgentClass 授权已经统一。Phase 2 没有扩大 routing 语义；Attempt Runner 只使用 Kernel 已授权的当前 AgentClass。

### 2.2 Work Graph v4 与 dependency handoff 已落地

`dependencies` 已完全替换 `dependsOn`，同时作为 DAG 拓扑与 keyed `text`/`artifact` delivery contract 的唯一事实源。独立 `src/work-graph/` 提供 Planning、Kernel 和 Execution 共享的类型与纯校验；Runtime 只注入已完成直接入边的不可变 handoff，不继承祖先结果。

当前生产图为严格 v5，Executor 通过 Completion Protocol v2 只提交 identity-free evidence/artifacts report，Runtime 根据已绑定的 acceptance 与 outgoing handoff contract 生成权威内部结果。Phase 6 在 2026-07-28 以 SQLite v27 / Kernel v4 完成；2026-07-30 的 Executor recovery amendment 将 Kernel 升级到 v5，2026-08-02 的结构化 Planner proposal 工具迁移将全新安装 SQLite 基线升级到 v29。系统仍不保留旧 completion envelope/图双读或旧数据库升级路径。

### 2.3 Kernel 控制面已统一

Phase 3 已用 `ControlKernel.decide(event, snapshot)` 和持久 decision ledger 统一 Planning admission、串行 dispatch、capacity、execution outcome、timer 与 completion correction。Phase 4 将继续在同一 seam 上增加 durable recovery、failure taxonomy、retry/fallback/backoff 与 circuit breaker，不再建立第二条控制链。

### 2.4 并发的前置条件不是线程池，而是资源模型

在 partition key、读写冲突、持久租约、崩溃恢复、工作树隔离和确定性合并完成前，不允许把“同层节点”直接解释为可以生产并发执行。

## 三、全局不变量

所有阶段都必须维护以下不变量：

1. **Planner 提案，Kernel 决策，Runtime 执行副作用。**
2. **Canonical definitions 是 Codex/Pi 静态 Routing Capability 的唯一事实源。**
3. **工作图是 Subtask 依赖和执行次序的唯一事实源，不保存显式 execution layer。**
4. **每个 Subtask 只有一个有序 AgentClass 偏好清单；首位 preferred，其余为 fallback。**
5. **一个 Subtask 同一时刻最多有一个 active attempt；一个 attempt 只绑定一个 WorkUnit。**
6. **Fallback 是前一 attempt 结束并释放资源后的下一次 attempt，不允许并行双重所有权。**
7. **Runtime 不自行作战略判断；策略迁入 Kernel 时必须同步删除旧分支。**
8. **未建立 partition 授权和租约前，Runtime 保持串行。**
9. **Work Graph 与 Routing Catalog 是独立共享语义；不得把规则复制到 Planner、Kernel 或 Runtime。**
10. **Session/Commands/TUI/Gateway 是 Application Shell，Storage 是 Adapter；二者不拥有控制策略。**
11. **新增跨模块依赖必须符合 ADR-0020；现有违规 seam 只能收敛，不能扩大。**

## 四、阶段依赖

```text
Canonical capability definitions（已完成）
  → Phase 1 工作图语义收敛
  → Phase 2 Executor 执行范围隔离
  → Phase 3 Kernel 控制面收敛
  → Phase 4 Recovery / fallback / 熔断
  → Phase 5 Partition 串行落地
  → Phase 6 异步并发调度
```

Phase 1～2 关闭最初的错误拆分与重复执行问题；Phase 3～4 建立完整控制面；Phase 5～6 才进入资源隔离和并发。

## 五、分阶段执行方向

### Phase 1：工作图语义收敛

目标：让 Planner 输出的工作图在串行 Runtime 中已经具备最终、可靠的结构语义。

执行方向：

- PlanningAgentPlan 硬升级到新 schema，不维持新旧执行协议并行。
- 每个 Subtask 声明受控 `requiredCapabilities`。
- 每个 Subtask 只保留一个有序 `preferredAgentClassList`；首项是 preferred，其余是 fallback。
- 删除或由工作图派生现有重复的 hint、candidate 和顶层 executor summary 字段，避免多份路由事实。
- 建立纯工作图规则模块，由 Planner validator 和 Kernel 共同消费。
- 规则至少覆盖：唯一 ID、依赖存在、DAG、起始节点、派生拓扑、同 AgentClass 无分叉单链合并，以及能力覆盖。Phase 6 上完成 Adapter attempt 可重入后，同一 frontier 可以由同一 AgentClass 的不同 WorkUnit 并行承接。
- Kernel 使用 canonical capability definitions 校验候选，不把数据库自由文本 capability 视为内置类认证依据。
- Runtime 继续串行消费通过授权的 DAG，不在本阶段启用并发。

退出条件：Planner 不再把同一 AgentClass 可一次完成的步骤拆成无意义单链；跨能力交接才产生多个 Subtask；结构违规可由 Planner repair，并由 Kernel 防止绕过。

完成记录（2026-07-16）：PlanningAgentPlan 已升级为严格 v3，纯工作图规则、catalog-aware Planner/Kernel 双重认证、动态健康 rewrite 复检、v21 只读审计迁移及无 fallback Runtime cutover 已交付。Docker/Linux 全套测试通过（176 个文件、776 个测试），真实 Planner→Kernel→Runtime artifact smoke 通过。Phase 1 实施计划已归档并随本次收尾提交落库。

### Phase 2：Executor 执行范围与 dependency handoff

目标：Executor 每次只完成当前 Subtask，不重复完成 sibling 或整个顶层任务。

执行方向：

- 建立唯一 Subtask execution context builder。
- 顶层目标只作为背景，当前 Subtask 是唯一执行范围。
- 注入 acceptance、expected output、必要 dependency handoff 和 sibling out-of-scope。
- dependency 只传递必要交付物，不重复注入全部历史输出。
- claim、execute、release 全程维持一个 attempt 对一个 WorkUnit。
- 用端到端场景验证单能力任务只产生一次执行和一套产物。

退出条件：原始“一个 Executor 可完成的任务被拆成多个调用并重复执行”的问题关闭，且不依赖未来并发实现。

完成记录（2026-07-17）：Work Graph v4、SQLite v22、唯一 Subtask context、Execution Evidence、Completion Protocol v1、最小 attempt receipt、原子 handoff 和串行 Attempt Runner 已交付。`npm run lint`、`npm run build`、聚焦回归和 Docker/Linux 全量回归通过（182 个文件、769 个测试；另有 2 个文件、4 个测试跳过）。Planner MCP 六工具 smoke、真实 Codex Planner API-key smoke 与 Planner→Kernel→Runtime→Codex Executor artifact smoke 均通过。实现提交为 `9783518`、`1472a3c`；Phase 2 计划已归档，Phase 3 激活。

残余加固记录（2026-07-20）：contract/stale 终态统一回到 Task domain 与 attempt-bound WorkUnit，恢复 Phase 1 的可合并单链和同层 preferred 冲突校验，并以 coordinator/attempt 行为测试替换读源码断言。修复提交为 `11c8e27`；Phase 3 的事件和纠正策略范围不变。

### Phase 3：Kernel 控制面收敛

目标：建立一个小而稳定的 Kernel 决策 seam，将战略决策从 Session/Runtime 收回。

执行方向：

- 建立统一的纯决策入口，方向为 `decide(event, snapshot) -> decision`。
- event 和 decision 使用判别联合表达 Plan admission、dispatch、execution outcome、capacity signal 和 timer tick。
- Kernel 内部可以由多个 policy 模块组成，但对调用者只暴露一个决策接口。
- Runtime 保留写库、claim/release、Adapter 执行、heartbeat 和 delivery 等副作用。
- 逐条迁入现有 admission、容量不足、失败落态和定时恢复策略；每迁入一条，同时删除原 Runtime 分支。
- 新增 `handoff_contract_failed` Kernel event，携带 attemptId、Subtask、WorkUnit、授权 completion contract 和全部 violations。
- 对该事件最多授权一次同 AgentClass 纠正 attempt，并把精确缺失 key、错误类型与完整 trailer 格式反馈给 Executor；第二次失败即 blocked，不做 fallback 或 backoff。
- `SessionExecutionCoordinator` 最终只驱动 decide/apply/observe 循环。

退出条件：当前已有战略行为均能通过 Kernel 决策测试，Session/Runtime 不再维护并行策略表。

完成记录（2026-07-20）：统一 Kernel event/snapshot/decision、ledger-first 同步控制循环、SQLite v23 decision ledger、只读 legacy Planning audit、`awaiting_decision`、确定性 capacity candidate switching、timer capacity recovery、outcome landing 与一次 response-only contract correction 已交付。旧 `PolicyKernel`、`TaskAdmissionGate`、多 Task Scheduler policy、`TaskResumePlanner` 和 Session 错误文本恢复策略已删除。`npm run lint`、`npm run build` 与 Docker/Linux 全量回归通过（176 个文件、715 个测试；另有 4 个文件、15 个 Phase 4/6 历史测试跳过）；真实 Linux Codex Planner→Kernel→Runtime→Codex Executor artifact smoke 通过。实现提交为 `bfca74a`；Phase 3 两份计划已归档，Phase 4 激活。

### Phase 4：持久恢复、fallback、retry、replan 与 Kernel 派生可用性

目标：把统一 Kernel seam 升级为跨进程可恢复、可测试、可审计的串行工作流；所有恢复策略继续由纯 Kernel 决定。

执行方向：

- 建立 durable event inbox、Decision application、effect outbox 和启动恢复顺序，保持授权 ledger 不可变。
- 建立结构化 failure taxonomy，区分容量、基础设施、权限、能力不足、任务失败和质量失败。
- 增加 attempt continuation、retry cap 和持久 backoff；旧 attempt ID 永不原地重放。
- 按 `preferredAgentClassList` 实现顺序 fallback；candidate 切换只发生在前一 attempt 终止并释放后。
- 将 circuit breaker 收敛为 Kernel 对 bounded recent-attempt projection 的纯派生可用性规则，不新增状态机或事实源。
- 候选耗尽后每个 user generation 最多自动 replan 一次，并通过 Work Graph v5 revision 保留已完成证据、替换剩余工作。
- timer 只产生 Kernel event，不自行恢复任务。
- 对进程恢复、重复事件、Decision apply 和外部 delivery 建立幂等或 explicit uncertain 保证。
- 领域契约与 fault matrix 冻结后执行 LangGraph Functional API 门控 spike；只允许替换 workflow cursor/replay implementation。

退出条件：失败、恢复、fallback、候选耗尽、replan 和可用性均由单一控制面决定；主数据库可独立从全部 crash window 恢复；Runtime 不再通过正则、隐藏 retry 或 if-else 私自拍板；生产只保留一条 workflow 路径。

完成记录（2026-07-21）：Kernel contracts v2、Planning/Work Graph v5、SQLite v24 durable inbox/application/outbox、结构化 failure、持久 backoff、Codex continuation、recovery packet、顺序 fallback、一次自动 replan revision、派生 AgentClass availability、人工 uncertain recovery 与 startup reconcile 已交付。旧同步 `KernelControlLoop` 已删除；LangGraph 门控评估未达到 30% 净删除门槛，项目保留单一自研 `DurableKernelWorkflow` 且不引入 LangGraph/checkpointer。`npm run lint`、`npm run build` 和 Docker/Linux 全量回归通过（184 个文件、747 个测试；另有 4 个文件、15 个历史测试跳过），包含持久 retry continuation 集成场景。真实 Linux runtime smoke 通过：Codex Planner 经统一 Kernel workflow 驱动 Codex Executor，在授权 workspace 创建并验证 `smoke-result.md`。实现提交为 `f3b3e66`～`be47bd2` 及 closing commit；Phase 4 计划与 LangGraph 结论已归档，Phase 5 激活。

### Phase 5：Partition 模型在串行 Runtime 中落地

目标：先建立最终资源模型和执行防线，在仍然串行的环境中验证，再允许并发。

执行方向：

- 通过 ADR 固定 repository/worktree/path/logical resource/external object 的 partition identity。
- 定义 read/write access、父子路径覆盖、通配资源和外部对象冲突规则。
- Planner 只提出交付能力，不枚举资源 claim；Runtime 根据 AgentClass permission profile、Task 资源绑定和 workspace identity 构造默认资源事实，Executor 对越界操作发起结构化请求，Kernel 唯一决定 grant、deny 或 escalate。
- 建立持久租约：owner、Task/Subtask/attempt、lease、heartbeat、等待关系和幂等 claim/release。
- 建立进程退出、WorkUnit 丢失、租约过期、取消和残留工作树的恢复清理规则。
- 每个 attempt 创建独立短命 Docker sandbox；每个 Task generation + Subtask 保存持久 workspace、关键 checkpoint 和产物/CAS 清单。Git 成果只提交到 MetaClaw 托管分支。
- 本阶段仍然串行执行，但 partition 字段必须真实参与授权和范围限制，不得只是未来占位符。

退出条件：partition key、冲突检测、持久租约、崩溃恢复和隔离机制均有 ADR、迁移和容器测试；并发尚未开启。

完成记录（2026-07-22；2026-07-28 收缩承诺）：ADR-0024、Resource Model、AgentClass immutable image/profile、持久 workspace/checkpoint/CAS、受管 Git workspace、resource lease/wait、每 attempt 短命 Docker sandbox、attempt-scoped model gateway、结构化 capability request/grant/use 审计预算和 sandbox recovery 已交付。Planner 不承担资源 claim；Runtime 构造默认资源事实，Kernel 唯一决定 grant/deny/escalate。Phase 5 产品保证明确收缩为 sandbox profile + 审计预算，不宣称所有文件、网络或外部动作均有细粒度 Runtime broker enforcement。宿主 Executor fallback、bypass-sandbox、旧 workspace/worktree lease 入口和既有违规 seam 已删除；生产仍保持一个 active Task 和一个 active Subtask attempt。实现提交为 `aae3d64`；Phase 5 计划已归档，Phase 6 激活。

### Phase 6：单 Task 异步并发与可靠性收口

目标：在已验证的 DAG、Kernel 和 partition 模型上，为一个已接纳的顶层 Task 启用安全并发，并关闭取消、故障恢复和完成门。ADR-0026 将本阶段最终边界固定为单顶层 Task；多 Task admission、优先级、公平性和饥饿保护不属于本路线图。

#### Phase 6 上：单 Task 并发与 Git publication

执行方向：

- 从 DAG 动态推导 runnable frontier，不增加 Planner 输出的 execution layer。
- Kernel v4 根据依赖、AgentClass 健康、capacity、资源事实和空闲 slot 一次授权确定性的 `dispatch_batch`。
- Runtime 持久化 child dispatch item，并发 claim/run；同一 Subtask 仍最多一个 pending/active attempt。
- Executor Adapter 以 attempt ID 可重入，精确取消一个 attempt；Task 取消枚举其 active attempts。
- 所有新文件任务统一导入内部 Git；Subtask 拥有持久 worktree，attempt/WorkUnit/容器保持短命。
- candidate 经稳定 publication gate 才发布 completion facts；依赖合成使用完整 Git ancestry。
- 文本允许三方合并，二进制路径独占且不自动合并；冲突返回原 AgentClass 最多 repair 三次，再独立 conflict replan 一次，仍失败则 park。
- 覆盖 batch、sandbox、candidate、publication、conflict 和 repair crash window。

完成记录（2026-07-27）：ADR-0025、纯 `deriveRunnableFrontier`、Kernel v4、SQLite v26、durable dispatch supervisor、attempt-reentrant Adapter、内部 Git generation/worktree、完整 dependency ancestry、`awaiting_integration` publication gate、文本/二进制策略和 bounded conflict repair 已交付。真实 Session 回归验证两个同 AgentClass sibling attempt 重叠运行，并在故意反转完成顺序后仍按首次授权顺序发布；显式 Docker 集成验证两个隔离容器真实重叠；generation Git 初始化和每个 Subtask resource grant 已收敛为并发安全。`npm run lint`、`npm run build`、canonical Codex/Pi image build、Docker/Linux 全量回归（199 个文件、806 个测试通过；5 个文件、17 个测试按环境门控跳过）与 Docker 内真实 Codex Planner→Kernel→Runtime→Executor artifact smoke 均通过。

#### Phase 6 最终可靠性收口

执行方向：

- Kernel v4 统一授权整 Task 取消、原子 Subtask 下游闭包取消和显式部分结果接受。
- SQLite v27 为 dispatch/publication 增加 `cancelling/cancelled`，为 resource lease 增加 revocation request，并保存 generation replan request 与 revision completion kind。
- 取消栅栏先提交，Runtime cancellation supervisor 再精确中止 attempt、确认 sandbox 退出并释放 WorkUnit、lease 和 capacity；启动时幂等续做。
- publication 最终事务重查取消栅栏；取消后已经生成的 integration commit 只保留审计，不发布 result、handoff 或 workspace completion。
- 多个耗尽恢复预算的 Subtask 合并为同一 generation ordinary replan；旧图静止后 Planner 只调用一次，取消或失效的 quiescence token 拒绝晚到 plan。
- `complete_task` 在 dispatch、publication、sandbox、WorkUnit、lease、receipt、replan 和 Kernel application 残留全部清零前不得将 Task 置为 `done`。

完成记录（2026-07-28）：ADR-0026、纯 `deriveCancellationClosure`、SQLite v27、durable cancellation coordinator、显式 Subtask cancellation/partial acceptance、publication cancellation fence、generation replan coalescing/token CAS 和严格完成门已交付。最终可靠性复核又把 attempt receipt、Subtask 状态、dispatch terminal 与 Kernel outcome/inbox 封入同一 SQLite 事务，外部 cleanup 改为可重放 supervisor；Docker/Git/持久状态无法证明安全时进入 recovery-blocked，并保留 claim/lease。未发布版本同时 hard cut 到新安装 v27 + Kernel v4，删除旧 schema 双读、旧 dispatch API 和纯 compatibility factory/re-export。Phase 6 的最终能力定义为“单顶层 Task 内按 DAG 并发执行、隔离 attempt、Git 成果集成、可恢复的异步执行”。ADR-0011 保持有效，不归档。完整验证与提交记录见 [Phase 6 最终可靠性收口计划](../archive/plans/2026-07-28-phase-6-single-task-reliability-closure.md)。

Phase 6 总退出条件已满足。未来若需要多顶层 Task，必须从 [多顶层 Task 调度未来路线图](future-multi-task-scheduling-roadmap.md) 单独启动，不重新解释本路线图的完成状态。

## 六、无临时兼容层策略

- 每个阶段只保留一个当前 schema 和一条运行路径。
- Plan schema 升级时，历史已完成决策只作为审计记录，不重新授权执行。
- 未完成的旧工作图在升级点重新规划，不通过 optional defaults 或双 validator 继续运行。
- 不保留旧 routing 字段与新字段双写；阶段内一次性更新 Planner、Kernel、Runtime、存储和测试调用方。
- 不使用 feature flag 长期维持新旧 Kernel 决策链。
- 策略迁入 Kernel 的同一批修改必须删除 Runtime 中对应的旧策略分支和 fixture。
- 迁移只服务于持久领域数据；不得用数据库兼容字段代替明确的领域升级决策。

## 七、文档与计划管理

- 本文件是跨阶段总路线图，只记录依赖、全局不变量和阶段退出条件。
- 每次只为当前激活阶段建立详细实施计划。
- 每份阶段实施计划必须以 ADR-0020 为设计门，列明受影响模块与 owner、公开 Interface 及消费者、禁止依赖、要删除的旧跨模块入口、临时例外的最迟删除阶段，以及边界测试证据。
- 若阶段触及 `TaskRuntimeService`、`SessionExecutionCoordinator`、Planning 内部工作图规则、带 Repository 的 Kernel projector 或其他已知违规 seam，必须在同阶段收敛，或记录有明确删除阶段的例外；不得新增调用方。
- 阶段完成后更新本文件状态、验证和提交，再归档该阶段实施计划。
- 技术债文档只记录未被计划接管的问题；一旦被本路线图完整覆盖，转入 `docs/archive/tech-debt/` 作为历史问题记录。
- 旧的 [Planner 执行器能力边界与双执行器目录改造计划](../archive/plans/2026-07-15-planner-executor-capability-boundaries-and-demo-catalog-zh.md) 已由本路线图接管并归档。

## 八、Workspace partition 技术债覆盖确认

本路线图完整接管已归档的 [Planner 工作区分区与并发调度技术债](../archive/tech-debt/planner-workspace-partition-and-concurrency-debt.md)，对应关系如下：

| 原技术债事项 | 本路线图阶段 |
| --- | --- |
| Partition identity、覆盖与冲突 | Phase 5 |
| 持久租约、owner、heartbeat、幂等 claim | Phase 5 |
| 崩溃恢复与残留清理 | Phase 5、Phase 6 |
| Worktree/临时目录隔离 | Phase 5 |
| 并行结果合并 | Phase 6 |
| 单 Task 内并发取消传播 | Phase 6 |
| 跨 Task 调度、公平性和取消传播 | [未来独立路线图](future-multi-task-scheduling-roadmap.md) |
| Planner / Kernel / Scheduler / Runtime 授权职责 | Phase 3、Phase 5 |
| ADR、数据迁移与容器级竞争测试 | Phase 5、Phase 6 退出条件 |

因此单 Task partition 与并发可靠性债务已由本路线图 Phase 5～6 关闭；跨 Task 策略不再计入本路线图完成条件。

## 八之二、Kernel 决策权技术债覆盖确认

本路线图完整接管已归档的 [Kernel 决策权散落 Runtime 技术债](../archive/tech-debt/kernel-decision-authority-scattered-in-runtime-debt.md)，对应关系如下：

| 原技术债事项 | 本路线图阶段 | 关闭情况 |
| --- | --- | --- |
| 单一决策入口 `decide(event, snapshot)` | Phase 3 | 已关闭（ADR-0022） |
| 执行失败事实规范化与策略分离 | Phase 3、Phase 4 | 已关闭（`KernelFailure` taxonomy） |
| 定时恢复策略上收 | Phase 3、Phase 4 | 已关闭（timer 只发事件） |
| 失败后按候选清单顺序 fallback | Phase 4 | 已关闭（ADR-0023） |
| replan / 回传 Planner 触发条件与上限 | Phase 4 | 已关闭（每 generation 一次 revision） |
| retry cap 与熔断 | Phase 4 | 已关闭（attempt cap + 派生可用性） |
| 应急细分（写库、容量、heartbeat_lost 等） | Phase 4、Phase 5 | 已关闭（结构化 failure + 资源/沙箱事件） |
| 目录与命名收敛 | Phase 3、Phase 5 | 已关闭（`ControlKernel`；admission gate / decision applier 已删除） |

该技术债于 2026-07-27 复核后归档，退出条件 1～5 全部满足；Phase 6 已在单 Task 边界完成并发可靠性收口。

## 九、总体完成条件

只有同时满足以下条件，才能将本路线图标记完成：

1. Planner 按 capability handoff 形成最小工作图，并遵守依赖和合并规则。
2. Executor 只执行当前 Subtask，一个 attempt 只绑定一个 WorkUnit。
3. Plan admission、dispatch、failure、timer recovery、fallback 和熔断均由 Kernel 控制面决定。
4. Partition claim、持久租约、隔离和崩溃恢复已经落地。
5. Runtime 可安全并发执行无依赖、无 partition 冲突的 Subtask。
6. 不存在新旧 Plan schema、路由字段或 Kernel 策略的并行兼容路径。
7. 所有阶段均完成文档回填、迁移验证、聚焦测试和完整 Docker 测试。

完成判定（2026-07-28）：以上七项均已满足。多顶层 Task 并发从未作为这些产品级完成条件的隐含前提；ADR-0026 已把它明确移至未来独立路线图。
