# Pi Planner 迁移行为等价性技术债

> 状态：已关闭
> 优先级：P0
> 创建日期：2026-08-03
> 完成日期：2026-08-04
> 责任边界：AnyFusion-Pi Planner 适配层与 MetaClaw Planner 接入边界
> 关联 ADR：ADR-0015、ADR-0020、ADR-0021、ADR-0022、ADR-0023

## 问题

早期 Pi 迁移只接通了原生 TUI、`submit_planning_proposal` 和 Host Bridge，
但没有迁入旧 Planner 的完整提示词、Skill、只读查询工具和上下文规则。
Pi 因信息不足而能生成结构合法但语义错误的计划。结构化 proposal 解决了
文本解析脆弱性，却没有自动获得行为等价性。

本次清债同时删除 `expectedOutput` 的混合语义，将 PlanningAgentPlan 升级到
v7、Work Graph 升级到 v6，并用 `deliveryKind: edit | report` 表达工作区变化
契约。Executor completion 升级为 identity-free v3；模型不再复制身份或
artifact，Runtime 依据权威 workspace delta 生成结果。

## 当前主链

```text
Pi Native TUI / Pi RPC
  → 同一个 Planner bootstrap
      → 固定 system prompt + 固定 metaclaw-planner/SKILL.md
      → 七个 MetaClaw MCP 只读查询工具
      → 四个 Pi 仓库读取工具
  → submit_planning_proposal({ plan: PlanningAgentPlan v7 })
  → Planner Host Bridge
  → MetaClaw v7 schema + semantic validation
  → Kernel 授权与 Work Graph 持久化
  → accepted + taskId
  → 后台 Executor / snapshot 状态流
```

`accepted` 只表示 MetaClaw validation、Kernel 授权和 Task/Work Graph 持久化
成功，不表示 Executor 已完成。Planner 不写存储、不调度、不授权、不控制
Executor。

## Parity Inventory

| 项目 | 当前归属与结论 |
| --- | --- |
| Stable system prompt | AnyFusion-Pi；只保留身份、只读边界、工具可信边界和必须提交 proposal 等稳定规则。 |
| Planner Skill | AnyFusion-Pi 唯一 `metaclaw-planner/SKILL.md`；构建复制到发布产物，启动逐字注入一次，缺失 fail-closed。 |
| `search_tasks` | MetaClaw MCP；按文本/状态查询持久 Task。 |
| `get_task_context` | MetaClaw MCP；读取一个已解析 Task 的权威上下文。 |
| `get_current_session_context` | MetaClaw MCP；只提供持久审计事实，Pi session 继续拥有对话连续性。 |
| `get_planning_context` | MetaClaw MCP；唯一提供确认偏好、精确待授权请求和 canonical routing catalog。 |
| `get_runtime_state` | MetaClaw MCP；提供 focus、活动和阻塞状态。 |
| `list_executor_status` | MetaClaw MCP；提供 AgentClass 健康和近期安全结果。 |
| `get_executor_diagnostics` | MetaClaw MCP；提供持久化 probe/不可用原因。 |
| `read/grep/find/ls` | Pi 原生只读工具；统一以 `/workspace` 为 cwd。 |
| PlanningAgentPlan v7 schema | MetaClaw 生成并验证；Pi 只通过 proposal tool 参数 schema 暴露给模型。 |
| Work Graph v6 validator | MetaClaw Planning/Work Graph 边界；使用结构化 acceptance 和 `deliveryKind`。 |
| Proposal identity | Pi Runtime 注入 session/turn/user input/submission ID；模型只能提供 plan。 |
| Kernel/Task/Executor 状态 | MetaClaw 独占授权、持久化、调度和修改。 |

MCP 固定 allowlist 缺少任一工具时首轮前失败；额外工具不注册。MetaClaw 注入
绝对 Node 20 命令和编译后的 `planner-mcp.js`，Pi Node 22 不使用自己的
`process.execPath`。回合中 MCP transport 断开会锁住 proposal 并中止当前
agent loop，下一回合前重新连接；普通领域错误不会被误判为 transport 故障。

## Completion v3

模型成功回执只有：

```json
{
  "evidence": ["..."],
  "noChangeReason": null
}
```

Runtime 在 completion 校验前计算并持久化一次权威 delta：

- `report` 必须零 delta 且 `noChangeReason=null`；
- 有变化的 `edit` 必须 `noChangeReason=null`；
- 零变化的 `edit` 必须提供非空原因；
- artifacts 只由新增/修改文件生成，删除只保留在 delta/evidence；
- delta 截断或无法权威计算时 fail-closed；
- response-only correction 复用来源 attempt 的持久 delta。

## 明确废弃

以下机制不保留兼容路径：

- Codex Stop hook；
- 模型文本 output-schema 和 Planning envelope；
- JSON 截取、尾括号修复和文本 repair fallback；
- proposal 专用固定重试次数；
- 外层 repair prompt 和 validation repair loop；
- 通用 read-only shell；
- prompt/catalog 环境变量重复注入；
- 未启用的 `get_session_interaction`；
- PlanningAgentPlan v6 / Completion v2 运行时读取；
- Planner 直接修改 Task、Work Graph、Kernel 或 Executor 状态。

## SQLite 迁移

Schema v30 提供唯一事务式 29→30 迁移。迁移重建 `subtasks.delivery_kind`，
转换所有仍可恢复的 pending Kernel event、未应用 decision/application、活动
dispatch 和 deferred replan payload。终态 Kernel ledger 保持不可变历史事实。
任一可恢复 payload 无法确定转换时整笔回滚并拒绝启动，不存在读取时 v6
fallback。

## 验收记录

全部构建、测试和行为验证均在 Linux Docker 中完成。

AnyFusion-Pi：

```text
docker run --rm anyfusion-pi-test:v7-skill-shape npm run check
docker run --rm anyfusion-pi-test:v7-skill-shape ./test.sh
```

- `npm run check` 通过；全量测试无失败，其中 agent 168 tests、TUI 690 tests；
- test/release image 内的 `npm run build:offline` 通过；
- 固定 Skill 仅注入一次、精确 MCP/仓库工具集合、外部资源禁用、Node 20
  MCP 子进程、首轮和回合中 fail-closed、重连、domain error、TUI/RPC
  bootstrap 等价以及 v7 proposal schema 均通过。

MetaClaw：

```text
docker run --rm metaclaw-test:v7-final
```

- 185 个 test files、725 个 tests 通过；4 个 files / 15 个 tests 按既有条件跳过；
- v7 schema/validator、v6 拒绝、Completion v3、workspace delta、
  SubtaskAttemptRunner、SQLite 29→30 原位迁移和回滚、活动 Work Graph、Kernel
  pending/deferred recovery、session/routing/replan 均通过。

最终 runtime smoke：

```text
docker exec metaclaw-shell npm run smoke:metaclaw -- --scenario planner-session
docker exec metaclaw-shell npm run smoke:metaclaw -- --scenario artifact
docker exec metaclaw-shell npm run smoke:metaclaw -- --scenario python-hello
```

- 两轮 Pi session continuity、artifact 发布以及 `hello.py` 创建并输出
  `Hello world` 全部通过；
- proposal accepted 后立即返回，Executor、delta 与 publication 在后台主链继续；
- 最终镜像中 MetaClaw 为 Node `v20.20.2`，Pi 为 Node `v22.23.2`，MCP、Host
  Bridge、Task 面板和 Executor 状态投影正常。

真实 provider 一次性行为验证：

- 创建 `hello.py`、修改已有文件、只读 `report` 零 delta、已满足目标的零变化
  `edit` 均通过；
- changed `edit` 的 Runtime artifacts 来自权威 delta；`report` 和零变化 `edit`
  的 artifacts 为空；零变化 `edit` 持久化非空 `noChangeReason`；
- Native TUI 像素 Logo、版本号、Task/Executor 面板和 connected/idle 状态更新正常。
- 2026-08-04 用户完成最终实际使用验证并确认通过。

关闭提交：

- AnyFusion-Pi：`d6251dd5 feat(planner): restore MetaClaw planning parity`
- MetaClaw：`feat(planner): complete Pi planner parity v7`（本提交）
