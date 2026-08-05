# Phase 6 后首次发布冗余与兼容层清理

> 状态：进行中（第 2 批已完成 / 共 5 批）
> 创建日期：2026-07-28  
> 代码基线：`474f6d4`（`feat: close single-task phase 6 reliability`）  
> 关联 ADR：ADR-0011、ADR-0015、ADR-0018、ADR-0020  
> 关联技术债：`docs/archive/tech-debt/nl-keyword-semantic-inference-debt.md`
> 用途：移交 Phase 1–6 完成后仍存在的冗余、兼容和旧实现清理，不新增功能或模块。  
> 产品前提：MetaClaw 尚未发布，不需要兼容历史用户配置、历史数据库或旧输出协议。

## 落地批次记录

### 第 1 批：第 3 节 P0 自然语言语义影子栈（已完成）

- 完成日期：2026-07-28
- 覆盖范围：本文档第 3 节全部子项（3.1 Recall Review、3.2 Hybrid retrieval 与第二套 LLM 语义桥、3.3 ContextRecaller 收紧、3.4 自动自然语言记忆捕获、3.5 偏好场景与交付意图词表）

实际交付的行为变化：

- 删除 recall review 全链路：`RecallReviewApplicationService`、`RecallReviewBuilder`、`RecallPolicyService`、`RecallReviewPolicyRepo`、`RecallFeedbackRepo`、`MemoryRecallEventRepo`，以及 `/memory review-policy list|revoke` 两个命令。
- 删除 hybrid retrieval 与第二套 LLM 语义桥：`HybridTaskRetriever`、`TaskRelevanceRanker`、`TaskEmbeddingService`、`HybridMemoryRecaller`、`PreferenceEmbeddingService`、`LlmBridge`、`EmbeddingProvider`，及其专用 repo（`TaskRelationRepo`、`TaskMemoryEmbeddingRepo`、`PreferenceEmbeddingRepo`）。`TaskSearchIndexRepo`/FTS 保留，继续作为 Planner MCP 的确定性搜索实现。
- `ContextRecaller` 收紧为纯确定性两层读取（显式 `taskId` 历史 + 当前 session 最近对话），删除 `isTimelineRecallRequest`、`detectTimelineRange`、`recallByLlm`、`extractKeywords`、`recallByKeywords`。
- 删除自动自然语言记忆捕获：`MemoryCaptureService` 整体删除，连带 `session-helpers.ts` 中的 `extractPatterns`、`extractHighConfidencePreferenceCandidates`、`isHighRiskMemoryCandidate`。长期记忆写入现在只经由显式 `/memory` 命令。
- 删除偏好场景与交付意图词表：`MemoryEngine.recall`/`recallForReview` 及其 `isGlobalPreferenceSceneCompatible`、`classifyPersonalityTonePreference`、`detectRequestedPersonalityTones`、`isPersonalityToneSceneCompatible`、`isStructuredWorkScene`、`inferType` 的自然语言猜测；`ResumeContextBuilder` 整体删除；`VerificationAndDeliveryService.ensureFeishuDocumentArtifact` 的飞书文档交付关键词删除。
- 删除 `src/core/types.ts` 中 11 个已无消费者的 V2 记忆召回类型与 `ExecutionContextBundleV2.taskMemoryContext`，以及 `SessionPresentationService.formatRecallReviewBlock`。
- 删除 6 张已无消费者的 SQLite 表及其 8 个索引：`task_relations`、`task_memory_embeddings`、`preference_embeddings`、`memory_recall_events`、`recall_review_policies`、`recall_feedback`。
- 删除只保活上述实现的测试文件，并把原先断言旧语义的用例改写为反向覆盖（断言代码侧不再猜测语义）。

后续审查收尾：

- 删除没有生产调用者、仅由测试保活的 `TaskMemoryCardRepo.searchRelevant` 自然语言评分、通用词表和 resume/reference 推断。
- 删除失去生产写入入口的 observation 候选链、`/memory candidates|confirm|reject`、候选通知与 delivery 接口，以及 `observations` 表。
- 删除失去生产写入入口的 memory audit 链、`/memory recent|auto-captured|applied|undo|explain|evidence|timeline|relations`，以及 `memory_audit_events` 表；Vault 继续导出显式确认偏好。
- 删除只服务于旧召回的 `ConversationTurn` source、ContextRecaller helper、presentation block 和 reflection source 残留。
- 同步 `AGENTS.md`、README 和中英文技术总览，使现行文档只描述 Planner MCP 确定性搜索、显式偏好和结构化 Executor evidence。

后续收尾验证：

- `npm run lint` 通过。
- `npm run build` 通过。
- Docker 全量测试通过：185 files / 726 tests passed，4 files / 15 tests skipped，0 failed。
- Docker 真实 smoke 通过：Codex Planner → Kernel → Codex attempt → Git publication，产出并验证 `smoke-result.md`。

验证：

- `npm run lint`（`tsc --noEmit`）通过。
- `npm run build` 通过。
- Docker 全量测试：`docker build -f Dockerfile.test -t metaclaw-test . && docker run --rm metaclaw-test` → 187 files / 742 tests passed，4 files / 15 tests skipped，0 failed。
- Docker smoke：`npm run smoke:metaclaw` → `MetaClaw real task smoke passed.`（executor codex，scenario artifact）。

实施提交：见本节标题对应的 `refactor: remove natural-language semantic shadow stack` 提交。

### 第 2 批：第 4 节 P1 生产路径兼容架构（已完成）

- 完成日期：2026-07-29
- 覆盖范围：本文档第 4 节全部子项（4.1 命令双契约、4.2 Host Executor 测试旁路、4.3 Feishu 旧配置迁移、4.4 Feishu 旧文本输出协议）

实际交付的行为变化：

- 4.1：删除 `src/commands/router.ts` 与旧 `CommandHandler`/`CommandContext`，`command-tree.ts` 不再把结构化参数回拼成 `string[]`，`legacyContext`/`convertLegacyResult`/`invokeLegacy`/`legacyAction` 全部删除；`/task`、`/executor`、`/memory`、`/learning`、`/profile` 直接绑定 `CommandAction.execute`。命令集合与外部行为不变。
- 4.2：`ExecutorRegistry` 只解析 AgentClass → `SandboxedExecutorAdapter`，删除 `allowHostTestAdapters`、`defaultExecutor`/`defaultExecutorFactory`、`executorFactory`、`ExecutorAdapterRegistry` 与 `createDefaultExecutorAdapterRegistry`；删除 `custom-cli.ts`、`claude-code.ts`、`codex-cli.ts`、`hermes-agent.ts`、`deepseek-tui.ts`、`openclaw.ts`、`command-line-adapter.ts`、`response-only-cli.ts`；`ExecutorAdapter` 接口收紧为 `name`/`supportsContinuation?`/`execute`/`executeResponseOnly?`/`isAvailable`/`abort`。`MetaclawSessionDeps.executor` 与 `CommandContext.executor` 一并删除。
- 4.3：删除 `Config.integrations.feishu` 类型、`resolveFeishuGatewayConfig` 的 legacy fallback、`migrateLegacyFeishuConfigFileToGateway` 及 `src/index.ts` 中两次迁移调用；保留 `integrations.markdown_preview`。
- 4.4：`parseFeishuTaskOutputLine` 删除旧 `+ #task...` 分支，只接受当前带 Executor identity 的格式。
- Session 现在消费已有的 `MetaclawSessionDeps.attemptSandbox` seam；41 个 session/TUI 测试迁移到共享 fake `AttemptSandboxPort`，不再注入 host `ExecutorAdapter`。
- 删除失效的 `availableExecutorCommands`/`availableCommands` command-probe seam，以及 command context 中残留的 `executor` 和 `bindingSource: default` 测试 fixture。
- `SandboxedExecutorAdapter` 对非零 sandbox 退出日志调用统一的 adapter-boundary failure normalizer，使 network、timeout、permission 和 unknown failure 继续进入对应的 Kernel retry/recovery 策略。

行为影响（供后续批次注意）：因 4.2 删除了 Executor 侧 skill 安装/更新/停用/废弃能力，`/learning promote` 对 `skill`、`skill_patch`、`skill_disable`、`skill_deprecation` 候选现在一律写入 `unsupported` 审计（`executorName: 'sandboxed'`）并返回“当前 executor 不支持 …”，不再存在成功安装路径。`task_memory_card` 候选的沉淀行为不变。

验证：

- `npm run lint`（`tsc --noEmit`）通过。
- `npm run build` 通过。
- Docker 全量测试：`docker build -f Dockerfile.test -t metaclaw-test . && docker run --rm metaclaw-test` → 179 files / 687 tests passed，4 files / 15 tests skipped，0 failed。
- Docker shell 启动验证：SSH/TUI 持久数据卷按当前 pre-release schema 隔离为 `metaclaw-shell-data-v27`；旧数据卷保留。CLI 实际启动通过，新数据库确认 `schema_version = 27`。
- Docker smoke：`npm run smoke:metaclaw` → `MetaClaw real task smoke passed.`（executor codex，scenario artifact），产出并验证 `smoke-result.md`。

实施提交：本次提交（`refactor: remove production compatibility architecture`）。

## 1. 目标与边界

本债务只处理以下问题：

1. 已被 Planner、ControlKernel、Sandboxed Executor 或 Git workspace 新路径取代，但仍被生产代码引用的旧实现；
2. 只为旧配置、旧协议、旧数据库或旧测试架构保留的兼容分支；
3. 由测试单独保活、生产路径没有调用的模块；
4. 仍在代码侧解释自然语言语义，和 ADR-0015 的 Planner-owned semantics 重叠的逻辑。

明确不在本债务范围内：

- 不增加新的调度、记忆、检索、Executor 或 Gateway 能力；
- 不实现多顶层 Task 并发；
- 不重写 Phase 6 的并发、取消、恢复、publication 或 merge repair 模型；
- 不删除 Kernel durable ledger、attempt receipt、outbox、merge audit 等运行时可靠性事实；
- 不删除 Phase 5 checkpoint 对 Git 无法覆盖材料的补充能力；
- 不删除 Planner MCP 的确定性任务搜索、显式 ID/path/URL/attachment 解析或安全脱敏；
- 不删除 canonical Codex/Pi AgentClass、镜像和 sandbox 执行路径。

## 2. 基线补丁已经完成的清理

下列项目已在 `474f6d4` 完成，不应在后续工作中重复实施：

| 已完成项 | 当前结论 |
| --- | --- |
| `src/executor/factory.ts` | 已删除 deprecated Executor factory |
| `src/session/session-execution-coordinator.ts` | 已删除 Session → Execution 兼容转发 barrel |
| `src/storage/planning-decision-repo.ts` | 已删除旧 Planning Decision repository |
| SQLite v1–v29 顺序升级链 | 已压平为首次发布基线 schema；不要重新引入版本升级兼容 |
| Phase 6 attempt terminal/recovery 收束 | 已抽出 `AttemptTerminalService` 并补齐恢复测试，不属于本轮瘦身范围 |

## 3. P0：自然语言语义影子栈（已完成，2026-07-28）

> 本节已在第 1 批全部落地，详见开头「落地批次记录」。以下内容保留为实施依据，不再作为待办。

这是优先级最高、收益最大的清理。当前系统已经由 PlanningAgent 负责自然语言语义，但 memory/task/session 中仍保留一套“规则 + 第二 LLM + fallback”的平行语义系统。

### 3.1 Recall Review 结果未进入执行

当前链路：

1. `SessionTaskExecutionApplicationService.prepareTaskExecution` 调用 `RecallReviewApplicationService.apply`；
2. 结果写入临时 `approvedRecallSelections` Map；
3. 以 `approvedRecallSelection` 传给 `KernelExecutionRuntime.execute`；
4. `KernelExecutionRuntimeInput` 只把该字段声明为 `unknown`，Runtime 没有继续消费；
5. `MemoryContextService.prepareExecutionContext` 虽能消费该选择，但生产执行路径没有调用该方法。

因此该链路会执行召回、审计和 UI 输出，却不会改变实际 attempt 上下文，属于“有副作用但无交付效果”的旧路径。

建议删除：

- `SessionTaskExecutionApplicationService` 中的 `approvedRecallSelections` Map 和 recall review 调用；
- `KernelExecutionRuntimeInput.approvedRecallSelection`；
- `RecallReviewApplicationService` 和默认工厂；
- `MemoryContextService.prepareRecallReviewContext`、`buildAcceptedRecallSelection`、`prepareExecutionContext`；
- `RecallReviewBuilder`、`RecallPolicyService` 中只服务于该路径的部分；
- 对应 recall review policy、audit 展示及只验证旧行为的测试。

保留：

- `MemoryContextService.preparePlanningInitialContext`，但按 3.3 进一步收紧；
- `normalizeInlineResourcesFromInput` 等显式资源解析；
- Planner MCP 可读取的结构化任务、记忆和 runtime facts。

### 3.2 删除 Hybrid retrieval 与第二套 LLM 语义桥

生产启动仍构造并串联：

- `src/task/hybrid-task-retriever.ts`
- `src/task/task-relevance-ranker.ts`
- `src/memory/hybrid-memory-recaller.ts`
- `src/core/llm-bridge.ts`
- `TaskRelationRepo`、`TaskMemoryEmbeddingRepo`、`RecallFeedbackRepo` 中只服务于该语义链的部分

该链包含实体推断、连续性词加权、历史引用猜测、embedding/FTS 混排、反馈调权和 PlanningAgent 之外的 LLM 排序。Planner 已可通过 `search_tasks`、`get_task_context` 和 session/runtime MCP 工具自行选择上下文，因此无需保留另一套语义决策器。

建议：

1. 删除 `HybridTaskRetriever`、`HybridMemoryRecaller`、`TaskRelevanceRanker`；
2. 删除 `LlmBridge` 及其 `config.executor.command` 语义调用用途；
3. 从 `src/index.ts`、Gateway、Session/TUI 依赖中移除这些对象；
4. 删除仅为上述类存在的 repo、schema、测试和配置；
5. 保留 `TaskSearchIndexRepo`/FTS，作为 Planner MCP 的确定性搜索实现，不在代码侧决定“用户指的是哪个 Task”。

### 3.3 收紧 ContextRecaller 和 Planner 初始上下文

`ContextRecaller` 当前仍包含：

- `isTimelineRecallRequest` / `detectTimelineRange` 的自然语言意图与时间窗推断；
- `recallByLlm` 的第二 LLM 排序；
- LLM 失败后的 `extractKeywords` / `recallByKeywords` fallback。

`MemoryContextService.preparePlanningInitialContext` 又把上述结果直接作为 Planner 初始上下文，导致 Planner 调用工具前已经被代码侧语义过滤。

建议将其收紧为确定性上下文读取：

- 当前 session 最近固定数量的对话；
- 显式 `taskId` 对应的历史；
- 已确认、结构化的长期偏好；
- 明确的 interaction/resource ID。

“用户想召回哪段历史、某个时间表达代表什么、是否需要关联旧 Task”全部由 Planner 通过工具决定。

### 3.4 删除自动自然语言记忆捕获

`KernelExecutionRuntime.completeTask` 仍调用 `MemoryCaptureService.captureCompletionPatterns`，从用户输入和 Executor 输出中：

- 正则抽取重复工作模式；
- 推断“高置信偏好”；
- 自动写入全局记忆或观察候选；
- 发送记忆候选通知。

建议删除：

- `captureCompletionPatterns`
- `captureHighConfidencePreferences`
- `captureHighConfidenceCandidate`
- `captureExplicitPreference` 死代码
- `session-helpers.ts` 中只服务于自动捕获的 `extractPatterns`、`extractHighConfidencePreferenceCandidates`
- 自动捕获专用 audit、delivery 和测试

长期记忆写入只保留显式 `/memory` 命令或未来已有契约明确授权的 Planner 操作。本债务不新增新的记忆写入通道。

### 3.5 删除偏好场景和交付意图词表

在删除 Hybrid/Recall Review 后继续检查并删除：

- `MemoryEngine.isGlobalPreferenceSceneCompatible`
- `classifyPersonalityTonePreference`
- `detectRequestedPersonalityTones`
- `isPersonalityToneSceneCompatible`
- `isStructuredWorkScene`
- `inferType` 中的自然语言类型猜测
- `ResumeContextBuilder.isFileGenerationRequest`
- `ResumeContextBuilder.needsFeishuDocumentDelivery`
- `VerificationAndDeliveryService` 中同类 Feishu 文档交付关键词

允许保留安全黑名单、路径/URL 解析和展示文案映射；这些不得用于 action、Task 绑定、资源授权或交付意图选择。

## 4. P1：仍在生产路径中的兼容架构

### 4.1 命令系统双契约

`src/commands/command-tree.ts` 已将输入解析成结构化参数，但随后通过：

- `legacyContext`
- `convertLegacyResult`
- `invokeLegacy`
- `legacyAction`

把参数重新拼成 `string[]` 调用旧 `CommandHandler`，再将旧结果转换回新 `CommandResult`。几乎全部 `/task`、`/executor`、`/memory`、`/learning` 和 `/profile` 命令仍经过该桥。

建议：

1. 将现有 handler 直接迁到 `CommandAction` 的结构化参数和结果；
2. 删除 `src/commands/router.ts`、旧 `CommandHandler`/`CommandContext`；
3. 删除 command tree 中的参数回拼和结果转换；
4. 保持命令集合和外部行为不变，不新增命令。

### 4.2 Host Executor 测试旁路

虽然 deprecated factory 已删除，`ExecutorRegistry` 仍保留：

- `allowHostTestAdapters`
- `defaultExecutor` / `defaultExecutorFactory`
- `executorFactory`
- `CustomCliExecutorAdapter`
- Claude/Hermes/DeepSeek/OpenClaw host adapters
- `NODE_ENV === 'test'` 时绕过 sandbox 的执行路径

生产 attempt 在具备 `attemptSandbox + agentClassLookup` 时使用 `SandboxedExecutorAdapter`，上述逻辑主要由测试保活。

建议：

1. `ExecutorRegistry` 只解析 AgentClass → `SandboxedExecutorAdapter`；
2. 测试通过窄 fake port 注入结果，不再启动旧 host adapters；
3. 删除 `src/executor/custom-cli.ts`、`claude-code.ts`、`hermes-agent.ts`、`deepseek-tui.ts`、`openclaw.ts`；
4. 删除 `createDefaultExecutorAdapterRegistry` 中非 canonical 注册；
5. 保留 canonical Codex/Pi AgentClass 与镜像定义，不把 host CLI 路径当成其替代。

### 4.3 Feishu 旧配置迁移

当前仍同时支持：

- 新配置：`gateway.platforms.feishu`
- 旧配置：`integrations.feishu`
- `legacy-integration` source
- 启动和 doctor 时的 `migrateLegacyFeishuConfigFileToGateway`

建议删除：

- `Config.integrations.feishu` 类型；
- `resolveFeishuGatewayConfig` 中 legacy fallback；
- `migrateLegacyFeishuConfigFileToGateway` 和辅助转换函数；
- `src/index.ts` 中两次迁移调用；
- 旧配置迁移测试。

`integrations.markdown_preview` 若仍是当前正式配置，不应因字段同属 `integrations` 而一并删除。

### 4.4 Feishu 旧文本输出协议

`parseFeishuTaskOutputLine` 同时接受当前带 Executor identity 的格式和旧 `+ #task...` 格式。

处理前先确认所有生产 producer 只生成当前格式；确认后删除 legacy 分支和对应测试。不要在本债务中引入新的结构化投影协议。

## 5. P1：测试保活的生产模块

当前源码中以下模块没有生产实例化或生产调用，仅被专门测试引用：

| 模块 | 建议 |
| --- | --- |
| `src/storage/memory-recall-event-repo.ts` | 随 Recall Review/Hybrid recall 删除 |
| `src/storage/preference-embedding-repo.ts` | 随 Hybrid memory 删除 |
| `src/storage/guidance-repo.ts` | 若无当前持久 Guidance 消费者则删除 |
| `src/task/task-embedding-service.ts` | 随 Hybrid task retrieval 删除 |
| `src/memory/recall-review-builder.ts` | 随 Recall Review 删除 |
| `src/commands/router.ts` 的 `CommandRouter` | 随命令双契约删除 |

删除模块时同步删除：

- 只验证该模块自身的测试；
- 首次发布 schema 中只服务于已删除模块的表和索引；
- `src/index.ts`、Session/Gateway 构造参数和测试 fixture 中的空壳依赖。

不要为了让旧测试继续通过而保留无生产调用的实现。

## 6. P2：单 Task 产品边界下的旧主动调度语义

`OrchestrationEngine` 仍包含：

- `getPrioritizedTasks`
- `calculatePriorityScore`
- `generateSuggestions` / `generateProposals`
- `suggestNext` / `suggestNextProposal`
- urgency、readiness、continuity、staleness、preemption 等多 Task 评分

`KernelExecutionRuntime.completeTask` 仍在 Task 完成后自动生成下一个 Task 的 suggestion/proposal。当前产品边界是单顶层 Task，且 Task 语义规划由 Planner 负责，因此这套规则评分不再承担调度权威。

建议：

1. 删除自动优先级评分、自动 next-task suggestion/proposal 和 preemption 语义；
2. 保留 Dashboard 所需的纯 Task 状态读取，或直接使用现有 read service；
3. 不新增替代 Guidance 模块；
4. 同步删除 idle timer、TUI panel 和 acceptance tests 中只验证旧主动建议的部分。

该项会移除现有 UI 主动建议行为，应作为独立提交，便于产品检查。

## 7. P2：Git workspace 类型残留

首次发布 schema 和类型仍允许 `workspace_kind IN ('git', 'directory')`，但新 Task 已统一使用 Git workspace，当前源码也没有完整的 directory-only 执行通道。

建议：

- `WorkspaceKind` 收紧为 `'git'`；
- schema 收紧为只允许 `git`；
- 删除 repository/test 中的 directory workspace case。

不得删除 checkpoint manifest 中 `entry.type === 'directory'` 的目录条目；它表示 Git workspace 内的文件夹，不是非 Git workspace fallback。

## 8. 推荐实施顺序

1. **无争议死代码**：测试保活 repo/service、旧 Feishu 输出分支、workspace kind 类型残留；
2. **语义主清理**：Recall Review 无效传递、Hybrid retrieval、LlmBridge、ContextRecaller fallback、自动记忆捕获；
3. **兼容架构**：Feishu 配置迁移、命令双契约、Host Executor 测试旁路；
4. **产品行为收束**：Orchestration/Guidance 自动评分和 next-task 建议；
5. **schema 收尾**：从首次发布基线删除已无消费者的表、索引和配置字段。

每一批都应以“删除生产实现 + 删除保活测试 + 删除 composition/schema 残留”为一个原子提交，避免留下新的兼容壳。

## 9. 验收标准

- 自然语言 action、Task 绑定、历史选择、偏好适用性和交付意图只由 PlanningAgent 决定；
- `src/core/` 不再存在第二套通用语义 LLM bridge；
- 生产启动不再构造 Hybrid retrieval、Recall Review 或 host Executor compatibility graph；
- `KernelExecutionRuntimeInput` 不再携带未消费的 recall selection；
- Task 完成不会通过正则静默写入偏好或模式；
- 命令树不再把结构化参数回拼为旧 `string[]`；
- Feishu 只接受首次发布配置和输出协议；
- Executor 生产与测试都围绕 AgentClass/sandbox seam，不保留 host CLI 产品路径；
- 首次发布 schema 不包含无消费者的 recall embedding/guidance/legacy workspace 表；
- 删除一个模块时不存在“只为旧测试继续存在”的生产文件；
- 不影响 Phase 6 的 DAG 并发、attempt 隔离、Git publication、取消、恢复和完成门。

建议验证：

```text
宿主机：npm run lint
宿主机：npm run build
Docker：docker build -f Dockerfile.test -t metaclaw-test .
Docker：docker run --rm metaclaw-test
Docker：现有 canonical Codex/Pi image 与单 Task 并发 smoke
```

SQLite、完整测试和 smoke 不在 Windows 宿主机运行。

## 10. 移交注意事项

- 本清单以 `474f6d4` 当前源码为准；代码图谱建立早于该补丁，图谱只用于结构定位，是否仍存在已经用当前源码复核。
- 清理目标是减少模块和行为，不要用新的 service、adapter 或 compatibility facade 替换旧代码。
- 如果删除某条旧路径会暴露当前功能实际上依赖它，应先确认该功能是否属于首次发布目标；只有属于目标时才保留最小实现。
- 历史归档文档可以保留作为决策记录，但 current overview、CONTEXT、ISSUES 和 docs map 必须只描述清理后的现行架构。

## 11. 2026-07-30 真实 Docker 调试暴露的运行态闭环缺陷

> 状态：已确认，待逐项解决
> 记录范围：只记录现场现象、持久化事实、直接原因和暴露出的架构缺口；本节暂不确定修改方案。
> 现场环境：Windows 宿主机通过 `docker/shell.ps1` 启动持久 SSH/TUI 容器，由容器内 Runtime 通过 Docker socket 创建 attempt sandbox。

### 11.1 事故现场与已确认事实

用户提交“生成 Hello World Python 文件”任务后，TUI 和 `/tasks` 长时间将 Task 显示为 `RUNNING`，原因显示为“等待调度”，并持续显示 `Executor: codex 执行中...`。但 Planner 通过只读运行时信息查询后确认，Executor 实际没有开始执行用户要求的 Python 文件创建命令。

现场容器和 SQLite 持久化事实表明：

1. `metaclaw-shell` 已挂载 Docker socket，但只连接默认 `bridge` 网络；
2. Runtime 默认要求名为 `metaclaw-control` 的 control network，现场 Docker 中不存在该网络；
3. AgentClass/WorkUnit probe 先记录了 `probe_succeeded`；
4. Kernel 随后授权并派发 `codex-cli` attempt；
5. attempt 依次记录 `claimed`、`attempt_started`、`running`，之后在创建 sandbox 时因 `docker network inspect ... metaclaw-control` 失败；
6. Executor attempt receipt 已正确、不可变地落为 `executor_failed`，错误码为 `sandbox_configuration_failure`，详细原因是 `network metaclaw-control not found`；
7. 失败后 Kernel 先产生 `queue_generation_replan`，在 generation quiescence 后又产生 `request_replan`；
8. Planner 确实执行了自动重规划并提交新计划；
9. 因原子任务唯一候选 `codex-cli` 已被投影为不健康，Kernel 在新计划准入时产生 `reject_request`，原因为 `no healthy canonical AgentClass remains`；
10. 从该次 `reject_request` 到用户手动取消任务之间，没有任何 `block_work`、`park_for_replan`、`complete_task` 或 `cancel_task` 决策，原 Task 一直保留为 `running`；
11. generation replan request 同样一直停留在 `submitted`，直到用户手动取消 Task 时才被改为 `cancelled`。

因此，本次“命令执行中途被打断”的用户观感并不准确：用户命令本身尚未进入 sandbox 执行，失败发生在 sandbox 启动前的 control network 检查阶段。attempt 层已经知道失败，悬空的是 Task 聚合状态和用户可见运行态。

### 11.2 缺陷一：attempt 已终结，Task 仍可永久保持 `running`

当前 attempt terminal 机制正确保存了失败回执，Kernel 也消费了失败 outcome 并发起自动重规划。但自动重规划产生的 `plan_proposed` 仍复用通用 plan admission；当该计划不满足准入条件时，Kernel 返回普通 `reject_request`。

Session 对 `reject_request` 的应用只执行两件事：

- 输出 Kernel 拒绝原因；
- 刷新当前 runtime state。

该分支不会处理已有 Task，不会改变 Task 状态，也不会终结或失败对应的 generation replan request。`reject_request` 因此同时承担了两种语义不同的场景：

- 拒绝尚未创建 Task 的初始用户请求；
- 拒绝一个已经处于 `running` 状态的 Task 的内部自动重规划结果。

第一种场景不需要 Task 状态迁移；第二种场景必须使已有执行闭环。当前实现没有表达这一区别，导致 durable attempt 事实已经终结、Kernel 自动恢复预算已经消耗、系统也不存在可继续执行的工作时，Task 仍可以永久保持 `running`。

这不是单纯的展示错误。Task 聚合本身已经与 attempt receipt、dispatch item、AgentClass health 和 generation replan request 等持久化事实不一致。

### 11.3 缺陷二：AgentClass 可用性探针没有覆盖实际派发前置条件

当前 Executor/AgentClass 可用性检查主要验证：

- AgentClass 是否存在；
- execution image、resolved image ID 和 permission profile 是否齐全；
- Docker 中能否解析到预期镜像；
- adapter 是否可构造。

它不验证实际 sandbox 创建所需的 control network 是否存在、属性是否符合要求，也不验证承载 Runtime 控制服务的容器能否以约定主机名被 attempt sandbox 访问。

因此，系统可以先把 WorkUnit 标记为 `probe_succeeded` 和 `running`，再在第一次真正使用 control network 时立即失败。当前的“AgentClass 可用”事实只代表镜像和 adapter 表面可用，不代表该 AgentClass 在当前部署拓扑中具备一次完整 attempt 的启动条件。

`docker/shell.ps1` 与 Runtime 默认值之间也存在启动契约漂移：

- Runtime 默认使用 `METACLAW_CONTROL_NETWORK ?? 'metaclaw-control'`；
- evidence、capability 和 model gateway 默认公布主机名 `metaclaw-control`；
- `docker/shell.ps1` 当前挂载了 Docker socket，但没有建立上述 network，也没有为 shell/control 容器注册上述网络身份。

真实 smoke 使用的启动拓扑和日常 SSH/TUI 调试入口因而不是同一条部署链路，smoke 通过不能证明 `docker/shell.ps1` 启动的系统具备相同前置条件。

### 11.4 缺陷三：Kernel fallback 与自动重规划均发生过，但最终失败没有收口

本次子任务的 `preferredAgentClassList` 只有 `codex-cli`。Kernel fallback 只会在该列表中选择尚未尝试且当前可用的候选，不会把未被计划授权、能力不匹配的 `pi-agent` 临时当成替代 Executor。

因此本次没有切换 Executor 是当前授权模型的直接结果，不是 fallback 分支没有运行。唯一候选耗尽后，Kernel 按设计使用了一次 automatic generation replan；Planner 也确实完成了该次重规划。

真正未闭环的阶段发生在“重规划结果再次无法准入”之后：

- Kernel 知道原候选已经耗尽；
- Kernel 知道 automatic replan budget 已经使用；
- plan admission 知道新图中没有健康 canonical AgentClass；
- generation replan request 知道 Planner 已提交结果；
- 但没有一个分支负责把这些事实收束为原 Task 的非运行状态。

这表明 execution failure recovery 和 plan admission 虽然各自有局部决策，但跨越两者的 generation replan 生命周期没有完整的终态模型。

### 11.5 缺陷四：任务查询只解释 Task 行，没有验证运行事实

`/tasks` 和相关 Task 展示以 Task 表的 `status` 为主要事实来源。对于 `ready` 或 `running` Task，如果没有 `lastSchedulingReason`，当前展示会回退为“等待调度”。

该查询没有验证：

- 是否仍存在 active dispatch item；
- 是否仍存在 claimed/running WorkUnit；
- 是否仍存在未终结 attempt；
- 最新 attempt receipt 是否已经失败；
- 是否存在 pending/planning generation replan；
- 是否还有可运行的 work graph frontier。

所以一旦 Task 聚合未被正确迁移，查询层会继续给出形式上合理、实际错误的解释。本次 Planner 后续能够通过 MCP 查询到真实失败原因，说明底层诊断事实已经存在；但普通 Task 状态投影没有把这些事实组合成一致的用户可见状态。

### 11.6 缺陷五：TUI 把 Task `running` 误当成 Executor 正在运行

TUI 的等待动画由 `runtimeState.runningTaskId` 驱动，而不是由真实 active attempt 或 `runningExecutorName` 驱动。只要 Task 仍标记为 `running`，动画计时器就会每 350ms 更新一次。

当 `runningExecutorName` 已经清空时，TUI 又回退显示配置中的默认 Executor 命令名，因此产生了 `Executor: codex 执行中...` 的假象。该文本不是 Executor progress event，也不是新的派发记录，只是 UI 根据粗粒度 Task 状态生成的动画。

在当前 Windows PowerShell → SSH PTY → Ink TUI 的组合下，该动态行没有稳定地原位重绘，而是反复出现在终端历史中，形成大量：

```text
Executor: codex 执行中.
Executor: codex 执行中..
Executor: codex 执行中...
```

状态悬空使动画永不停止，终端重绘行为又把一个错误状态放大成持续刷屏。这里同时存在运行态语义错误和终端展示问题，不能把刷屏简单视为 Executor 重复执行。

### 11.7 本次事故暴露出的架构层债务

Phase 6 已建立 durable workflow、attempt receipt、Kernel decision ledger、WorkUnit、dispatch item 和 generation replan 等可靠性事实。本次事故说明这些事实“能够分别持久化”不等于系统已经具备端到端的一致状态模型。

当前缺口集中在以下边界：

1. **部署前置条件与 AgentClass health 的边界**：镜像存在被当成可执行，但 control plane 拓扑并未纳入可用性事实；
2. **attempt terminal 与 Task aggregate 的边界**：attempt 能正确终结，但 Task 不保证随恢复流程最终进入可解释状态；
3. **execution recovery 与 plan admission 的边界**：自动重规划可发起、可提交、可拒绝，但拒绝后的已有 Task 没有终态责任方；
4. **durable facts 与 read projection 的边界**：诊断事实完整存在，普通任务查询却只读取单一聚合字段；
5. **Task lifecycle 与 UI liveness 的边界**：Task 的业务状态被直接解释为 Executor 活动状态。

因此不能仅通过补一条 Docker network 创建命令或修改一段展示文案宣布问题解决。即使基础设施启动成功，现有状态模型仍允许其他失败路径再次制造“attempt 已终结但 Task 永久 running”的同类事故。后续处理应逐项建立和验证这些边界的不变量，再决定具体实现；本节暂不记录修改方案。

### 11.8 2026-07-30：Executor `error` 永久自锁与 availability replan 生命周期已收口

本批次针对 11.2、11.3、11.4 暴露出的共同根因完成了结构性修复：

- `error` 改为可重新验证的观测状态；只有 `disabled` 是管理锁。恢复刷新只检查 enabled + error，并且只允许 `error → healthy`；
- boolean `isAvailable()` 被结构化 `probe()` 取代，恢复证据与真实 attempt 历史分开保存；control network、镜像和 provider 配置进入实际启动前置检查；
- planning 与 error refresh 并行，Kernel 准入前汇合；相关 Executor 恢复时，同一原生 Codex Planner thread 最多修订一次；
- 已有 Task 的 availability-exhausted replan 不再走普通 `reject_request`，而是持久化为 `waiting_for_availability` 和 deferred proposal，并由 Kernel 将 Task 阻塞为 `kernel_availability`；
- Executor 恢复后提交 durable `executor_recovered` 事实。Kernel 对最新 Task/generation/revision/frontier 重新准入，合法时只激活 revision 并把 Task 转为 `ready`，不立即派发；
- Planner MCP 可读取 bounded、脱敏的 recent recovery checks，用户询问时 Planner 有足够事实解释失败原因；
- SQLite 首次发布基线升级到 v29，Kernel wire/ledger 保持 v5，Docker shell 数据卷同步到 v29；v29 增加 Planner proposal turn/submission 幂等与 accepted-turn lock。

11.5 的跨事实查询一致性与 11.6 的 TUI liveness 展示仍是独立技术债，本批次没有用恢复机制掩盖或顺带重写它们。
