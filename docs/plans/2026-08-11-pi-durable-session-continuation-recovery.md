# Pi 持久 Session Continuation 与中断恢复计划

- Status: Proposed
- Plan date: 2026-08-11
- Completion date: not completed
- Scope: Pi Executor、Execution Runtime、Control Kernel 恢复事实、持久化 Adapter、Completion Protocol 入口判定
- Governing ADRs: ADR-0020、ADR-0021、ADR-0022、ADR-0023、ADR-0024、ADR-0026
- Related debt: `docs/tech-debt/pi-executor-completion-submission-and-terminal-event-debt.md`

## 1. Goal

让一次因 provider/network error、空末轮、`aborted`、进程退出或显式暂停而未形成可信
completion 的 Pi attempt，能够由 Kernel 授权一个新的 `continuation` attempt。新 Executor
进程复用封存的 Pi 对话历史和同一个 Subtask worktree，只接收一段短小、权威的继续指令，
完成剩余工作并正常提交 Completion Protocol v4。

该方案用持久 session 恢复模型语义连续性，但不让 session 取代 Task、Kernel、worktree、
权限、工具副作用或 publication 的权威事实。

## 2. Problem Statement And Evidence

当前 Pi 执行链已经具备部分 continuation 形状：

- `KernelAttemptKind` 已包含 `continuation`；
- Kernel snapshot 已投影 `nativeContinuationAgentClasses`；
- Attempt Runtime 已保存 `continuationToken`；
- Pi Adapter 在 `recovery.mode === "native_session"` 时传入 `--session <token>`；
- 一个 Subtask 的所有 attempt 已复用同一 branch/worktree。

但当前 Pi native continuation 不能形成可靠恢复：

- 每次 attempt 都在临时 Pi Home 下创建 session 目录；
- Adapter `finally` 会递归删除该临时目录；
- 持久化的 token 可能指向已经不存在的 session；
- Runtime 只能退回 `recovery_packet` 和重新构造的大段执行上下文；
- Pi JSONL 提取器未按 `stopReason`/`agent_end` 判定 terminal，可能把上一轮
  `toolUse` 状态文本当作最终回答；
- 当前 response-only correction 使用新临时目录、`--no-session`、`--no-tools`，只能
  重写格式，不能继续被中断的任务。

2026-08-11 的真实模型 smoke 进一步证明：

- 完整答案仅缺 trailer 时，no-tool correction 可以稳定输出 marker；
- 输入是中间过程时，当前 correction 也能稳定输出 marker，但经常把
  “接下来继续核验”包装成 `{ "resultFilePaths": [] }` 的结构化假成功；
- 因此“能输出 marker”不能证明中断恢复成功。

## 3. Product And Architecture Decisions

### 3.1 Session 与 Runtime 事实采用混合恢复

持久 Pi session 负责恢复：

- 原始任务和执行指令；
- 已完成的 assistant/tool 轮次；
- 已返回的工具结果；
- 中断前的模型判断和剩余步骤。

Runtime 继续负责并重新绑定：

- Task/Subtask/attempt/WorkUnit identity；
- AgentClass Runtime binding 与 config digest；
- 同一个 Subtask worktree、branch、HEAD 和 workspace delta；
- 当前资源 lease、权限、capability/evidence tool binding；
- Completion Contract、handoff 和 publication gate；
- 不确定工具副作用及是否允许自动 continuation。

Session 不是事件账本、工作区快照或完成事实，不得成为 Kernel decision 的隐藏输入。

### 3.2 拆分 format correction 与 execution continuation

保留两个不同语义：

| 路径 | 适用条件 | Session/worktree/tools | 结果 |
| --- | --- | --- | --- |
| `contract_correction` | 已确认 `agent_end + stop`，完整最终正文存在，但 trailer 不合法 | 新临时 session；无 Task worktree；无工具 | 只允许修正格式 |
| `continuation` | `error`、`aborted`、缺失 `agent_end`、terminal `toolUse`、provider/transport interruption 或安全暂停 | fork 持久 session；同一 worktree；正常受控工具 | 继续执行并提交 completion |

不得再把 terminal error 先降格为“最后一段非空文本”，然后进入 format correction。

本计划不修改 correction 次数额度；先保证第一次授权路径的语义正确。

### 3.3 新进程 fork checkpoint，不共享可变 session

- 原 attempt 的 session checkpoint 一经封存即不可变；
- 新 continuation attempt 把 checkpoint materialize/fork 到自己的 attempt-private Home；
- 新进程只写自己的 session 文件；
- 每个 checkpoint 记录 source attempt、父 checkpoint 和内容 hash；
- 不允许两个进程同时写同一个 Pi session 文件；
- source checkpoint 缺失、损坏或 binding 不兼容时，不伪造 native resume。

### 3.4 继续指令保持短小，Runtime 仍做最终校验

Native continuation 不重新向模型发送完整 recovery packet。它在既有 session 历史后追加
一段 Runtime 生成的最小控制说明，至少包含：

```text
上一次执行因 <normalized reason> 在完成提交前中断。
继续使用现有工作区和已完成的工具结果，不要从头重复任务。
先核对最后已完成的工具调用以及当前工作区；对状态不确定的副作用不得盲目重放。
完成剩余工作，只有确认完成后才能输出 Completion Protocol v4 trailer。
```

动态 identity、acceptance、handoff 和 workspace delta 仍由 Runtime 注入或验证，模型不能
通过旧 session 覆盖这些事实。

### 3.5 只有安全事实允许自动 continuation

Pi terminal parser 必须区分：

- `model_response_interrupted`：模型响应中断，没有未完成工具；可 continuation；
- `tool_result_recorded`：工具结束事件和结果均已写入 session；可 continuation；
- `tool_effect_uncertain`：观察到 tool start 但没有可信 tool end；按工具类别处理；
- `session_checkpoint_missing_or_invalid`：不能 native continuation；
- `completed_stop`：进入普通 completion 校验，不是 recovery；
- `length`：视为截断；可由 Kernel 按现有 budget 决定 continuation；
- `cancelled_by_user`：除非用户明确 recover，否则不自动 continuation。

对只读搜索/读取操作可以重新核验；对文件写入和 Git 操作先检查同一 worktree；对外部不可逆
副作用必须依赖已有幂等键/执行账本，否则 block 并请求用户处理。模型对话历史不能消除副作用
不确定性。

## 4. Ownership And Interfaces

### 4.1 Control Kernel

拥有：

- 是否授权 `continuation`；
- continuation/retry/fallback budget；
- 根据规范化 failure、checkpoint availability 和 recovery safety 决定下一动作。

不拥有：

- Pi session 文件；
- JSONL 原始解析；
- checkpoint 拷贝、校验和清理；
- worktree 或 Executor 进程操作。

Kernel 继续只消费显式 event/snapshot facts，保持
`decide(event, snapshot) -> decision` interface 不变。

### 4.2 Execution Runtime

拥有：

- session checkpoint 生命周期和 source/child attempt 关联；
- 在 attempt 启动前请求 materialize；
- 将 checkpoint availability、terminal classification 和不确定副作用规范化为 Kernel facts；
- 复用同一 Subtask worktree、重新绑定 lease/permission/tool endpoints；
- Task terminal、publication 和 purge 时的 session payload 清理。

目标 seam 是一个深 Session Checkpoint 模块，建议的最小 interface：

```ts
interface ExecutorSessionCheckpointStore {
  seal(input: SealExecutorSessionInput): Promise<ExecutorSessionCheckpoint>;
  materialize(input: MaterializeExecutorSessionInput): Promise<MaterializedExecutorSession>;
  purgeTask(taskId: string): Promise<void>;
}
```

调用方不需要知道 Pi session 目录布局、JSONL 尾部修复、文件权限、hash 或 fork 方式。

### 4.3 Executor Port / Pi Adapter

拥有：

- 为当前 attempt 创建 Pi config Home；
- 使用 Runtime 提供的 durable session directory；
- 捕获 session header 和 terminal event；
- continuation 时使用 materialized session path 调用 `pi --session <path>`；
- 在删除临时 config Home 前完成 session seal；
- 把 Pi JSONL 规范化为 terminal summary，不向 Kernel 暴露原始日志。

建议扩展现有 recovery input，而不是增加 Pi 专用 Runtime 调用入口：

```ts
recovery: {
  mode: 'fresh' | 'native_session' | 'recovery_packet';
  sourceAttemptId: string | null;
  sessionCheckpoint: {
    id: string;
    materializedPath: string;
    sessionId: string;
  } | null;
  instruction: string | null;
}
```

### 4.4 Storage Adapter

SQLite 只保存 checkpoint metadata 和引用；session payload 使用 Runtime 管理的私有文件目录。
Storage 表结构不是跨模块 interface。

## 5. Durable Session Data Contract

实施时将 fresh-only schema 从当前 v35 升到下一个可用版本，并增加
`executor_session_checkpoints`（最终字段名在实现前由 schema 测试固定）：

- checkpoint ID；
- Task/generation/Subtask/source attempt identity；
- parent checkpoint ID；
- AgentClass、driver、Runtime binding ID 和 config digest；
- Pi session ID、payload URI、hash、size、最后有效 JSONL offset；
- terminal observed、last stop reason、bounded terminal error；
- last tool name/state 和 uncertain-effect flag；
- `open | sealed | materialized | purged` 状态；
- created/sealed/purged timestamps。

Attempt Runtime 增加 source/result checkpoint 引用。旧的 `continuationToken` 在迁移期仅作为
opaque driver token；Pi native continuation 的权威来源改为 durable checkpoint。

### 5.1 Filesystem Layout And Security

- Host 默认位于 AnyFusion Runtime data root 下的私有 executor-session 子目录；
- Container 位于 `/data/anyfusion/runtime` 对应子目录；
- 目录 mode `0700`，文件 mode `0600`；
- 路径只能由 Runtime 生成，Planner/模型不能提供；
- session payload 不包含 provider credential 或完整环境变量；
- metadata 只保存 bounded、脱敏 terminal error；
- session 大小设置硬上限，超限 fail closed 并退回非-native recovery decision；
- Task purge 必须删除 metadata 和 payload，并通过 foreign-key/file residue 测试。

### 5.2 Retention

- Task/Subtask 仍可 recover、blocked 或 paused 时保留 checkpoint；
- continuation 成功后保留父子 metadata，旧 payload 可在 publication 集成后清理；
- Task `done/cancelled/archived` 后删除 session payload，不把完整模型历史当长期审计事实；
- 显式 Task purge 删除全部 metadata、payload 和 materialized fork；
- bounded terminal summary 和 immutable attempt receipt 按现有保留策略继续存在。

## 6. Runtime Flows

### 6.1 Fresh Primary Attempt

1. Kernel 授权 primary。
2. Runtime 创建/复用 Subtask worktree。
3. Runtime 为 attempt 分配 durable session directory，Pi config 仍保持 attempt-private。
4. Pi Adapter 启动新进程并记录 session header。
5. JSONL parser 持续记录完整 message/tool terminal facts。
6. 正常 `agent_end + stop` 进入 Completion Protocol 校验。
7. 异常退出先 seal checkpoint，再上报规范化 failure。

### 6.2 Interrupted Continuation

1. Kernel 根据 failure、checkpoint availability、recovery safety 和 budget 授权
   `attemptKind: continuation, recoveryMode: native_session`。
2. Runtime 验证 source checkpoint 与同一 AgentClass/driver/config digest 兼容。
3. Runtime 把不可变 checkpoint materialize 到新 attempt-private session directory。
4. Runtime 复用同一 Subtask worktree，并重新创建 lease、permission 和 tool bindings。
5. Pi Adapter 使用 `--session <materialized-path>` 启动新进程，工具保持正常开放。
6. Runtime 只追加最小 continuation instruction。
7. 新 attempt 产生独立 receipt、checkpoint 和 sourceAttemptId，不覆写旧 attempt。
8. 完成结果继续经过 candidate validation、用户 publication approval 和下游解锁。

### 6.3 Graceful Pause

1. Runtime 标记 pause intent，不把它解释为完成或普通失败。
2. 能等待安全事件边界时，在当前 model/tool turn 完成后停止；否则执行受控终止。
3. Adapter seal 当前 session 并报告最后完整事件和 uncertain tool fact。
4. Subtask/worktree/checkpoint 保留。
5. 用户 resume 后由 Kernel 授权 continuation，而不是 Application Shell 直接启动进程。

### 6.4 Format Correction

1. Parser 已确认正常 terminal `stop`。
2. Completion validator 证明唯一问题属于 trailer/JSON 格式。
3. Kernel 可授权现有 `contract_correction`。
4. Response-only 进程不读取 session/worktree，也不执行任务。
5. 输入不是完整最终正文时不得进入该路径。

## 7. Delivery Stages

### Stage 0: Fault-Injection Feedback Loop

- 保留真实 provider response-only smoke，用于证明 format correction 能力；
- 新增多轮 Pi primary smoke：第一次模型轮次产生工具调用，网关在后续模型响应注入
  connection reset/502/stream truncation；
- 验证当前基线会错误提取中间文本或无法 native resume；
- 形成一条数秒级 fake-provider 测试和一条真实 provider Docker smoke。

Exit gate：能够稳定区分“格式错误”和“执行中断”，并在修复前稳定变红。

### Stage 1: Pi Terminal Event Parser

- 用一个 parser 返回 session ID、agent terminal、last assistant stop reason、bounded error、
  tool start/end 和 final text；
- 只有 `agent_end + stop` 可进入普通 completion；
- `error/aborted/length/toolUse/missing agent_end` 不得回退上一条非空文本；
- process exit code 只作为补充事实。

Exit gate：tech-debt 文档列出的 terminal parser 测试全部通过。

### Stage 2: Durable Session Checkpoint Module And Schema

- 增加 checkpoint port、filesystem Adapter、SQLite metadata Repository；
- 增加 fresh schema 与 Task purge；
- 实现 immutable seal、hash、size bound、尾部完整 JSONL 校验和 materialized fork；
- 让 Pi session directory 从临时 config Home 中独立出来。

Exit gate：Runtime 重启后仍能 materialize 同一 checkpoint；临时 Home 清理不再删除它。

### Stage 3: Pi Native Continuation Adapter

- 将 materialized session path 传入新 Pi 进程；
- 工具和 extension 与 primary 一致；
- 使用新的 attempt-private config/session Home；
- 追加最小 continuation instruction；
- 捕获 child checkpoint 和 source relationship。

Exit gate：新 PID/attempt 能读取旧工具结果、复用同一 worktree，并从中断位置继续。

### Stage 4: Kernel And Runtime Recovery Integration

- snapshot 投影 checkpoint availability、terminal class、uncertain tool effect 和 compatibility；
- Kernel 仅对安全且 budget 允许的 failure 授权 native continuation；
- checkpoint 不可用时按现有 policy 选择 recovery packet、fallback 或 block；
- Runtime 不自行重试；
- 不修改本计划范围外的 correction quota。

Exit gate：Decision 测试证明同一事件/snapshot 产生确定动作，重放不会重复创建 attempt。

### Stage 5: Lifecycle, Security And Documentation

- 完成 pause/resume、Runtime restart、Task terminal 和 purge 清理；
- 限制 session size、权限和错误持久化；
- 更新 ADR/CONTEXT/current docs 和运维说明；
- 删除 Pi token 指向临时目录的旧路径假设，不保留并行恢复分支。

Exit gate：SQLite foreign-key、文件 residue、权限和敏感信息扫描通过。

### Stage 6: Real Acceptance

- 在真实 `deepseek-v4-flash` 配置下运行长工具循环；
- 在模型第二轮或末轮注入 provider interruption；
- Runtime/容器进程可在 source attempt 与 continuation 之间重启；
- continuation 使用同一 session 历史和 worktree 完成 marker；
- 最终 publication 经用户批准后合入 Project `main`；
- 无重复外部副作用、无中间文本假成功、无残留 session/worktree。

## 8. Validation Matrix

### Session Checkpoint

- session header 后进程异常退出仍能 seal；
- JSONL 尾部半行不会污染 immutable checkpoint；
- hash/size/offset 不匹配时拒绝 materialize；
- parent checkpoint 不被 child 修改；
- Runtime restart 后可恢复；
- config digest/driver/AgentClass 不兼容时拒绝 native resume；
- terminal/purge 清理 metadata 和文件 payload。

### Pi Adapter

- fresh attempt 使用 durable session directory；
- continuation 新 PID 使用 fork 后的 `--session`；
- config Home 仍是 attempt-private；
- continuation 工具集与 primary 相同；
- response-only format correction 仍是 no-session/no-tools；
- source session 丢失时不静默创建空会话。

### Terminal And Recovery Semantics

- `toolUse -> tool result -> stop` 只接受最终 stop 文本；
- `toolUse -> empty error -> agent_end` 不返回 toolUse 状态文本；
- provider stream reset 形成 execution failure + checkpoint；
- continuation 看到旧工具结果并完成；
- tool start 无 tool end 形成 uncertain effect；
- user cancel 不自动 continuation；
- normal stop + malformed trailer 只走 format correction；
- incomplete intermediate text 永远不能被 format correction 包装为 success。

### Kernel/Runtime

- Kernel 决定 continuation，Runtime 只 apply；
- source attempt 和 child attempt 均有独立 immutable receipt；
- 重放同一 dispatch 不产生第二个 child；
- 同一 worktree/branch 跨 attempt 保留；
- continuation completion 仍经过 candidate validation 和 publication approval；
- fallback AgentClass 不错误复用不兼容 Pi session。

### Commands

- `npm run lint`
- `npm run build`
- focused Vitest：Executor session output、Pi Adapter、Attempt Runtime、Kernel recovery、Storage purge；
- Docker test：schema、POSIX path、mode `0700/0600`、Runtime restart；
- real smoke：多轮工具调用 + 注入 provider interruption + continuation + publication。

## 9. Rollout And Failure Handling

- 首先只为已验证的 Pi Runtime binding 启用 durable native continuation；
- feature readiness 来自 Registry binding 能力和 checkpoint store probe，不按 Executor 名称猜测；
- checkpoint module 不健康时保留现有 recovery packet/fallback/block 决策，不把空 session 当成功恢复；
- 不双写两套 session 历史，不增加 legacy database migration；
- fresh schema 继续 hard-cut，实施前备份本地预发布数据库；
- 若真实 interruption smoke 不能证明无重复副作用，则 native continuation 保持 disabled。

## 10. Non-Goals

- 本计划不立即实现 Pi `submit_completion` MCP 工具；
- 不移除 Completion Protocol v4 或 publication approval；
- 不让 session 成为 Task/Kernel/storage 的权威状态；
- 不把完整 session 历史塞入 Kernel event、receipt 或 Planner context；
- 不允许 Planner、TUI 或 Executor 直接授权 continuation；
- 不自动恢复用户明确取消的任务；
- 不在本计划中修改 correction 次数额度；
- 不保证跨 AgentClass、跨 driver 或跨不兼容模型恢复同一个 native session；
- 不用 conversation history 替代 worktree 检查、工具幂等性或不确定副作用处理。

## 11. Required Authority Updates

实施时至少更新：

- ADR-0023：native continuation 的 session checkpoint 和 Kernel 授权语义；
- ADR-0024：session payload 的 Runtime 私有存储、权限和清理；
- ADR-0021 amendment：format correction 与 interrupted continuation 的完成边界；
- `CONTEXT.md`：attempt-private config Home 与 durable session directory 的分离；
- `docs/current/technical-overview.md`；
- `docs/current/technical-overview.zh-CN.md`；
- `docs/current/phase-5-runtime-security.md`；
- `docs/tech-debt/pi-executor-completion-submission-and-terminal-event-debt.md`；
- `AGENTS.md`，仅在入口或导航发生变化时更新。

## 12. Completion Record

Not completed. 完成时记录：

- delivered stages and final interface；
- schema version and cleanup behavior；
- fault-injection and real-provider evidence；
- full validation commands/results；
- closing commit。
