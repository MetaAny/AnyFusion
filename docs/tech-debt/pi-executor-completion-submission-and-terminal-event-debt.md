# Pi Executor 完成提交与终止事件技术债

- **记录日期**：2026-08-10
- **状态**：待修复
- **优先级**：P0 可靠性
- **范围**：Pi Executor JSONL 终止判定、Completion Protocol v3 提交、响应纠错额度、attempt 诊断保留
- **关联契约**：[ADR-0021](../adr/0021-work-graph-v4-subtask-execution-contract.md)、[ADR-0022](../adr/0022-unified-kernel-control-plane-and-decision-ledger.md)、[ADR-0026](../adr/0026-phase-6-single-task-reliability-closure.md)

## 1. 摘要

2026-08-10 的世界杯国家进球数真实任务连续两次在 Pi 调研 Subtask 上进入
`contract_blocked`。两次记录的直接错误均为：

```text
completion_malformed:marker:expected exactly one final completion marker, received 0
```

这不是 Planner Host `command_submit` 超时、Runtime 中途重启或工作树被清理导致的
attempt 中断。第二次 Pi attempt 在 Runtime 重启后独立启动，持续约 12.5 分钟并以
进程退出码 `0` 结束。工作树保持干净，权威 workspace delta 为零。

当前最可能的故障链不是单纯的“Pi 不会遵循 JSON 指令”，而是：

1. Pi 长工具循环没有形成可用的最终完成提交，或末轮以 `error`、`aborted`、
   `toolUse` 等非普通完成状态结束；
2. Pi JSON 模式把终止语义放在 JSONL 事件中，进程退出码不足以证明模型成功；
3. AnyFusion 当前忽略 `stopReason` 和 `agent_end`，返回最后一条非空 assistant
   `message_end` 文本；
4. Runtime 因退出码为 `0` 且该中间文本非空，把调用当作成功 Executor 响应；
5. Completion Protocol 正确拒绝了缺少 marker 的文本；
6. 用户显式 unblock 后产生的新 primary attempt 又被 Subtask 历史 receipt 总数
   判定为“已经耗尽 correction”，因此没有获得本次 attempt 自己的一次格式纠错。

Completion Protocol 的 fail-closed 边界不应放宽。需要修复的是 Pi 终止事件适配、
attempt 诊断保留和 correction 额度归属。中期应让 Pi 通过专用
`submit_completion` 工具提交结构化完成结果，由 Runtime 构造权威 Completion
Envelope，而不是继续要求模型在自然语言末尾手写 marker 和 JSON。

## 2. 真实复现记录

目标 Task：

```text
task_plan_event_proposal_d02f4e7de4209e954ea5a14ec43744aa68d2bcc4b57d4acf1862793460830cd5
```

目标 Subtask：

```text
task_plan_event_proposal_d02f4e7de4209e954ea5a14ec43744aa68d2bcc4b57d4acf1862793460830cd5_r1_research-world-cup-goals
```

### 2.1 第一次 primary attempt

- 开始时间：2026-08-10 13:54:57，北京时间
- 结束时间：2026-08-10 14:04:18，北京时间
- Executor：`pi-agent`
- attempt kind：`primary`
- 进程退出码：`0`
- terminal state：`contract_blocked`
- workspace delta：零变更
- correction 支持快照：`[]`
- 最终记录文本：

```text
The aggregate is internally consistent: 104 completed fixtures, 48 countries,
308 match goals, and four fixtures with separate shootout fields that were not
counted. I’m performing the required branch synchronization check; this report
makes no workspace changes.
```

该文本没有 completion marker。它还在描述即将执行的检查，不是可信的最终完成边界。
当时运行中的 Registry/Runtime 快照没有把任何 AgentClass 标记为支持 response-only
correction，因此 Kernel 直接 blocked。

### 2.2 显式恢复后的第二次 primary attempt

- Runtime 重启完成：约 2026-08-10 14:50，北京时间
- attempt 开始时间：2026-08-10 14:51:01，北京时间
- attempt 结束时间：2026-08-10 15:03:35，北京时间
- Executor：`pi-agent`
- attempt kind：`primary`
- 进程退出码：`0`
- terminal state：`contract_blocked`
- workspace delta：零变更
- correction 支持快照：`["codex-cli", "pi-agent"]`
- Kernel event `receiptCount`：`2`
- 最终记录文本：

```text
聚合完成：来源的积分榜已覆盖小组赛，32 强至决赛逐日赛果补齐淘汰赛。当前结果显示第一名并非单一国家，英格兰和法国各 20 球并列；我会做总和与工作树复核，并按报告任务保持仓库无文件改动。
```

该 attempt 启动于 Runtime 重启之后，没有被中途 build、重启或 Planner Host 请求超时
终止。`command_submit` 超时只影响 TUI Host 请求等待，不会调用 Executor abort。

Kernel 虽然已经确认 `pi-agent` 支持 response-only correction，但
`receiptCount === 2` 触发了：

```text
response-only correction is unavailable or already exhausted
```

因此显式用户恢复后的新 primary attempt 没有得到一次独立的格式纠错机会。

## 3. 已证实事实

### 3.1 不是外部中断

- 两次 attempt 都拥有完整的开始和结束时间。
- 第二次 attempt 在 Runtime 重启后才启动。
- 两次 attempt sandbox 都记录为退出码 `0`、结果已收集、清理完成。
- Worktree adapter 没有普通 attempt 最大时长定时器；只有显式 `stop()` 才会发送
  `SIGTERM`/`SIGKILL`。
- Planner Host `command_submit` 超时链与 Executor abort 链无关。

### 3.2 Pi prompt 已明确要求最小完成格式

`src/executor/prompt-builder.ts` 已重复要求：

- 最终响应必须包含非空 Markdown；
- 必须恰好输出一次 literal completion marker；
- marker 后只能有一个 strict JSON object；
- JSON 后不得有任何内容。

模型面对的成功 JSON 不是完整权威 envelope，只包含：

```json
{
  "evidence": ["<concise evidence>"],
  "noChangeReason": null
}
```

Runtime 已负责注入 schema、status、Subtask/attempt/WorkUnit identity、acceptance
keys、handoff identity 和 artifacts。因此本问题不是模型被要求手写整个内部协议对象。

### 3.3 短 Pi smoke 可以遵循当前协议

同日的真实 `pi-research` smoke 已通过，内容是使用 `web_search` 和 `web_fetch`
核验 Node.js 官方首页。真实 no-tool response-only Pi invocation 也成功输出了 literal
marker 和 strict JSON。

这证明 Pi 并非普遍不具备当前格式能力。失败更集中于长工具循环或异常终止后的结果
收集边界。

### 3.4 Completion Protocol 的拒绝是正确的

两次持久化 `raw_response` 都没有 marker、JSON report、完整国家进球统计、可追溯
来源清单或下游 `country-goal-data` handoff。第二次文本还明确表示“我会做复核”。

如果 Runtime 把任意非空 Markdown 自动包装成成功结果，这类中间状态文本就可能被
发布。当前 fail-closed 校验避免了错误完成事实进入 handoff、artifact 和 publication
链路。

## 4. Pi JSONL 终止适配缺陷

### 4.1 `message_end` 不等于最终回答

Pi 会为 user、assistant、tool result 以及每个模型轮次发送 `message_end`。assistant
消息可携带以下 `stopReason`：

```text
stop | length | toolUse | error | aborted
```

工具调用前的 assistant 状态文字通常会以 `stopReason: toolUse` 结束，之后 Pi 执行工具
并继续下一轮模型调用。因此“最后一条非空 assistant 文本”不是可靠的完成定义。

### 4.2 当前提取器忽略终止语义

`src/executor/executor-session-output.ts` 的
`extractPiFinalAssistantMessage()`：

- 扫描所有 assistant `message_end`；
- 抽取其中的 text content；
- 只要文本非空就覆盖 `finalMessage`；
- 不检查 `message.stopReason`；
- 不检查 `message.errorMessage`；
- 不要求存在 `agent_end`；
- 不验证 `agent_end.messages` 中的最后 assistant 状态。

如果末轮是空文本 `error`，提取器会跳过它并保留上一轮 `toolUse` 的状态文本。这与
本次“我会继续复核”的持久化结果高度吻合。

### 4.3 Pi JSON 模式退出码不能单独证明成功

AnyFusion-Pi 的 print mode 只在 `mode === "text"` 时读取最后 assistant
`stopReason`，并把 `error`/`aborted` 转换成非零退出码。`mode === "json"` 只输出事件
流；只要外层调用没有抛异常，进程可以返回 `0`。

AnyFusion Executor 当前使用：

```text
pi --mode json ...
```

但 `SandboxedExecutorAdapter` 最终只判断：

```text
exitCode === 0 && output 非空
```

因此 AnyFusion 把 Pi JSON 事件协议当成了传统 Unix“退出码 + stdout 最终文本”协议。
这是确定存在的适配错误。

### 4.4 当前诊断不足以还原末轮事件

Worktree attempt 的 stdout/stderr JSONL 只保存在 adapter 内存中。结果提取完成后：

- sandbox record 被删除；
- attempt-private Pi home 和 session JSONL 被递归删除；
- receipt 的 `raw_response` 只保存提取后的逻辑文本；
- parsing/verification 只保存 completion marker 结果；
- 不保存 Pi terminal stop reason、model error、最后 tool call 或 `agent_end` 摘要。

因此当前无法严格证明这两次 attempt 最终是：

- 模型以 `stop` 正常结束但忘记 completion contract；
- 最后一轮是 `toolUse` 后异常停止；
- 最后一轮是空文本 `error`/`aborted`，被提取器隐藏；
- provider stream 在长循环后出现了其他 Pi 可识别错误。

后续修复必须增加 bounded、脱敏的终止诊断，不能继续只保存错误提取后的 94 字节文本。

## 5. Pi 指令遵循结论

当前证据支持以下分层结论：

1. 不能把本次问题主要归因于用户操作或 Runtime 中断。
2. 不能仅根据保存下来的短文本断言 Pi 正常完成后拒绝遵循 JSON 指令，因为提取器
   可能隐藏了真正的末轮错误。
3. 两次长调研 attempt 都没有形成可验证完成提交，说明自然语言 trailer 在长 ReAct
   工具循环后可靠性不足。
4. 短 smoke 和 response-only correction 能正确输出 marker，说明问题不是 Pi 完全
   不支持该格式，而是完成边界依赖 prompt 的方法不够稳健。
5. 即使修复终止提取，也不能保证长任务每次都手写正确 marker；专用工具仍有价值。

## 6. Kernel 审核与 correction 额度问题

### 6.1 不应放宽 completion 边界

以下规则应继续严格执行：

- 必须有一个明确、唯一的完成提交；
- workspace delta 必须权威且可确定；
- report 必须零 workspace delta；
- edit 的 no-change reason 必须和 delta 一致；
- artifact 必须来自 Runtime 计算出的 created/modified paths；
- acceptance 和 handoff identity 必须由 Runtime 注入；
- 中间文本、截断响应和错误状态不得发布。

“缺少 marker 时自动当作成功”会破坏以上边界。

### 6.2 `receiptCount` 使用了错误的作用域

`SubtaskAttemptRunner.landContractFailure()` 当前计算：

```text
当前 Task + Subtask 下所有历史 contract_blocked receipt 数量 + 1
```

`ControlKernel.decideContractFailure()` 只在 `receiptCount === 1` 时允许 correction。

这把“一个 source attempt 最多一次 correction”错误实现成了“一个 Subtask 的整个历史
最多一次 correction 机会”。用户显式 unblock、新 primary attempt、fallback 或
continuation 都可能被历史格式失败剥夺自己的 correction。

正确的最小语义应是：

- 每个 primary、continuation 或 fallback source attempt 最多有一个
  `contract_correction`；
- 是否耗尽由该 source attempt 是否已有 correction dispatch/receipt 决定；
- 显式用户恢复产生的新 primary attempt 拥有新的 correction 额度；
- correction 自身再次格式失败后必须 fail closed，不进入普通 retry/fallback；
- 不使用 Subtask 历史总 receipt 数推断额度。

该调整仍由 Kernel 决定是否授权 correction；Runtime 只提供绑定 source attempt 的
事实，不能自行重试。

## 7. 方案比较

### 7.1 方案 A：继续使用 trailer，只修 prompt 和 correction

做法：

- 保留 literal marker + JSON；
- 修复 Pi 终止事件解析；
- 修复 correction 额度作用域；
- 依赖 response-only correction 修正偶发格式问题。

优点：

- 改动最小；
- 所有 Executor 继续使用一个 Completion Protocol 表面；
- 现有 validator 和 correction prompt 可以复用。

缺点：

- 长工具循环后仍依赖模型记得输出特殊 trailer；
- 自然语言正文、marker 和 JSON 仍混合在一个自由文本通道；
- Pi 的最终完成声明仍不具备工具级 terminal 语义；
- correction 会增加一次模型调用和额外失败面。

结论：适合作为立即止血，但不应作为 Pi 的最终可靠完成通道。

### 7.2 方案 B：Runtime 自动包装最后一段 Markdown

做法：

- 只要 Pi 正常退出且有非空 Markdown，Runtime 自动生成 evidence/JSON。

优点：

- 表面实现简单；
- 模型不再手写 marker 和 JSON。

缺点：

- 无法区分最终报告与“我接下来会继续复核”的中间状态；
- 容易把不完整内容发布为完成；
- 模型没有明确、可审计的完成动作；
- 自动包装只能解决序列化，不能证明 acceptance 或 handoff 已完成。

结论：不采用。

### 7.3 方案 C：Pi 专用 `submit_completion` 工具

做法：

- Pi extension 注册一个结构化 completion submission tool；
- 模型必须通过工具提交完成或受控失败；
- 工具成功返回 `terminate: true`；
- Runtime 从 `tool_execution_start`/`tool_execution_end` 获取并验证唯一 submission；
- Runtime 构造权威 Completion Envelope；
- assistant 自由文本不再作为 Pi 完成事实来源。

建议的最小成功参数：

```ts
{
  body: string;
  evidence: string[];
  noChangeReason: string | null;
}
```

建议的受控失败参数沿用现有结构：

```ts
{
  failure: {
    kind: 'capability_mismatch' | 'task_failed' | 'quality_failed';
    code: string;
    summary: string;
  };
}
```

工具参数仍是模型产生的结构化数据，但 TypeBox/provider tool schema 会在工具调用边界
约束形状。Runtime 不应进行字符串 JSON 拼接，而应从已验证参数构造对象并注入：

- schema version 和 status；
- Task/Subtask/attempt/WorkUnit identity；
- acceptance keys；
- outgoing handoff targets 和 keys；
- authoritative workspace delta；
- artifacts。

优点：

- 明确区分工具循环中的普通 assistant 文本和最终完成动作；
- 不再依赖模型手写 literal marker；
- 成功提交可以终止 Pi agent loop；
- Runtime 保持唯一权威 envelope materializer；
- 与现有 Planner `submit_planning_proposal` 模式一致，已有实现和测试经验。

缺点：

- Pi driver 和通用 trailer driver 暂时存在两种提交适配；
- 必须定义重复提交、工具后继续输出和 terminal event 的精确规则；
- tool schema 只能保证结构，不能自动保证报告内容质量；
- Codex、Hermes 和 generic CLI 暂时仍需要 trailer 或各自的结构化提交机制。

结论：推荐作为 Pi 的目标方案，但应在终止事件解析和 correction 作用域修复之后实施。

## 8. 推荐最小实施顺序

### P0.1：修复 Pi JSONL 终止判定

新增 Pi event stream parser，至少返回：

```ts
{
  sessionId: string | null;
  terminalObserved: boolean;
  terminalStopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | null;
  terminalError: string | null;
  finalText: string | null;
  toolSubmissions: CompletionSubmission[];
}
```

当前 trailer 模式下：

- 只有存在 `agent_end` 且最后 assistant 为 `stop` 时，才能把其文本作为普通最终响应；
- `error`/`aborted` 必须规范化成 Executor failure；
- `length` 必须 fail closed，不能发布截断结果；
- 无 completion tool 时，terminal `toolUse` 不能被当成自然语言完成；
- 缺少 `agent_end` 必须视为 transport/adapter failure；
- 进程退出码只作为补充事实，不能覆盖事件语义。

### P0.2：持久化 bounded 终止诊断

Receipt 或 attempt runtime parsing facts 至少保存：

- 是否看到 session header；
- 是否看到 `agent_end`；
- 最后 assistant `stopReason`；
- 脱敏、截断后的 `errorMessage`；
- 最后工具名和工具执行状态；
- completion submission 次数；
- JSONL 是否出现无法解析的 terminal 事件；
- 原始日志是否达到 16 MiB 截断上限。

不得持久化 provider credentials、完整 tool payload、完整网页正文或未脱敏环境变量。

### P0.3：按 source attempt 修复 correction 额度

Kernel event/snapshot 应提供 source attempt 是否已经使用 correction 的事实。删除
`receiptCount === 1` 对 Subtask 历史总数的依赖。

### P1：增加 Pi `submit_completion`

- 在 Pi attempt extension 注册工具；
- 加入 Pi `--tools` allowlist；
- 使用 sequential execution；
- 接受成功结果时返回 `terminate: true`；
- Runtime 要求恰好一次成功 submission；
- submission 前的 assistant 文本只属于执行 trace；
- submission 后出现额外模型轮次或第二次 submission 时 fail closed；
- 工具未调用但 Pi 正常 `stop` 时仍按缺少完成提交处理；
- tool result、`agent_end` 和 process settlement 三者都必须观察到。

初期只迁移 Pi。Codex、Hermes 和 generic CLI 保留 Completion Protocol v3 trailer，
避免一次性设计通用 Executor completion RPC。

### P2：评估删除 Pi response-only 格式纠错

当 `submit_completion` 稳定后，Pi 的 marker/JSON 格式纠错将不再必要。response-only
correction 仍可保留给 trailer-based drivers，以及工具参数通过结构校验但后续
completion/delta 校验失败的可修复场景。

## 9. 建议验收测试

### Pi event stream parser

- `message_end(stopReason: toolUse)` 后正常工具结果和最终 `stop`，只返回最终文本；
- 最终 assistant 为无文本 `error`，不得回退到上一条非空 `toolUse` 文本；
- 最终 assistant 为 `aborted`，返回 Executor cancellation/failure；
- 最终 assistant 为 `length`，返回截断失败；
- process exit `0` 但 `agent_end` 最后消息为 `error`，不得视为成功；
- process exit `0` 但没有 `agent_end`，不得视为成功；
- JSONL 混入普通 stderr diagnostics 时仍能解析合法事件；
- 达到日志截断上限时 fail closed。

### Completion tool

- 一次合法 `submit_completion` + `terminate: true` 成功；
- 没有工具提交时 contract failure；
- 两次提交时 contract failure；
- completion tool 与其他非 terminal tool 同批调用时 fail closed；
- 工具参数 schema 不合法时 Pi 可收到结构化错误并重新提交；
- 工具成功后出现额外 assistant 轮次时 fail closed；
- failure submission 正确进入受控 Executor failure；
- report 修改 workspace 时仍由 Runtime 拒绝；
- edit 零 delta 且缺少 no-change reason 时仍由 Runtime 拒绝；
- Runtime 注入 acceptance、handoff、artifact 和 identity，模型不能覆盖。

### Kernel correction

- 第一个 primary contract failure 获得一次 correction；
- 同一 source attempt 的 correction 再次失败后 blocked；
- 用户显式 unblock 后的新 primary attempt 获得新的 correction；
- fallback 和 continuation 各自按 source attempt 判断；
- 历史 Subtask receipt 不消耗新 attempt 的 correction；
- correction 不进入普通 retry、fallback 或 automatic replan。

### 真实 smoke

- 保留当前短 `pi-research` smoke；
- 增加包含多轮 `web_search`/`web_fetch` 的长 Pi research smoke；
- 注入末轮 provider error，确认不会持久化上一条状态文本；
- 验证 Task blocked 时保留 Subtask worktree；
- 显式 unblock 后可重新执行并完成；
- 成功 completion 仍经过用户批准 publication 和下游依赖解锁。

## 10. 非目标

- 不降低 Completion Protocol 的 workspace、artifact、acceptance 或 handoff 校验。
- 不把 Kernel 变成自然语言结果质量评审器。
- 不在本技术债中设计所有 Executor 的统一 completion RPC。
- 不因为 Pi 工具方案而让 Planner、Executor 或 extension 直接写 Task/Kernel storage。
- 不让 tool submission 绕过 immutable receipt、workspace delta、publication 或用户审批。
- 不恢复远程 Git fetch/pull/push。
- 不引入新的自动 retry 策略。

## 11. 需要同步的权威文档

实施时至少同步：

- `CONTEXT.md` 的 Completion Protocol 和 Attempt Receipt 说明；
- ADR-0021 的 Pi 工具化完成提交 amendment；
- `docs/current/technical-overview.md`；
- `docs/current/technical-overview.zh-CN.md`；
- `docs/current/phase-5-runtime-security.md` 的 attempt-private tool 和诊断边界；
- 对应实施计划与完成验证记录。

## 12. 当前结论

此次世界杯任务再次 blocked 的直接原因是 Runtime 收到的逻辑结果没有 Completion
Protocol marker。更深层的首要技术问题是 AnyFusion 没有按 Pi JSONL terminal event
语义判断成功，而是把退出码 `0` 和最后非空 assistant 文本误当作成功响应。

Kernel 对缺失完成边界 fail closed 是正确的；Kernel 错误之处在于把 correction 额度
绑定到了 Subtask 历史 receipt 总数。推荐先修 Pi 终止解析和 correction 作用域，再
以现有 Planner proposal tool 为模板，为 Pi 增加 attempt-bound、terminal
`submit_completion` 工具。
