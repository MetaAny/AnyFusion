# Session-first 持久化与恢复简化

## 状态

- 状态：提案，待架构评审
- 计划日期：2026-08-13
- 适用范围：先用于飞书 Gateway；本地交互入口在 Gateway 验收后再决定是否切换

## 目标

把 Agent 自己持久化的 Pi session JSONL 作为对话连续性的唯一事实来源，显著
削减 Gateway 对 SQLite、快照、决策账本和启动恢复流程的依赖。重启或镜像重建
后，按同一个飞书 Chat 恢复同一个 Agent session，而不是重放一套自有的完整
Kernel 恢复状态。

目标架构：

```text
飞书 Chat → 稳定 session_id → Agent session JSONL → 当前轮执行 → 飞书回复
```

## 核心取舍

- Session 历史负责“聊过什么、当前上下文是什么”。
- 外部副作用（文件写入、Git 合并、飞书上传）不能仅凭对话历史证明已完成。
- 因此不再追求由 AnyFusion 自己实现的全量自动恢复和 exactly-once；进程在
  不确定的副作用阶段中断时，恢复后明确提示“上次执行未确认完成”，要求用户
  重新确认或重试。
- 为避免再次形成第二套快照系统，只保留一个很小的运行回执（可选但建议）：
  `run_id`、`session_id`、阶段、工作区、最近副作用、产物路径、状态和更新时间。
  回执只用于识别中断和避免无提示重复，不承载对话或完整 Kernel 历史。

## 计划内容

### 1. 先固定新的 Session 接口

- 保留现有 `chat_id → sess_feishu_<hash>` 稳定映射和 Pi session 文件。
- 在 Application Shell 增加一个小而深的 `SessionRuntime` seam，隐藏 session
  文件、Planner 进程和恢复提示的细节；调用方只需要 `open/send/close/status`。
- 同一 Chat 复用同一 session，不同 Chat 严格隔离。

### 2. 缩短当前轮生命周期

- Gateway 每次新消息只创建或打开 session，执行当前一轮并把结果追加回 Agent
  历史。
- Kernel 只保留当前轮的准入、权限和单活 Task 约束，不再在 Gateway 启动时重放
  decision ledger、snapshot、application/outbox 或完整 workflow。
- 用运行回执记录“进行中/已完成/未知”，停止自动重试、fallback、replan 和
  publication 恢复；这些动作改为用户确认后重新执行。

### 3. 移除旧恢复链路（分阶段）

- Gateway 路径不再调用 `recoverDurableStartup` 及其派生的启动 reconciliation。
- 停止为 Gateway 新写完整 Kernel 恢复事实；旧表和旧数据先只读保留，避免直接
  删除或破坏回滚能力。
- 增加一次性迁移/兼容开关，确认新路径稳定后，再评估删除旧 schema、快照和
  outbox 代码；不在本计划中直接删库或自动迁移历史数据。

### 4. 明确 Feishu 恢复交互

- 无未完成运行：直接打开同一 session，继续正常对话。
- 有未确认运行：发送一条恢复提示，展示最近阶段和产物信息；用户确认后才重试
  合并、上传或其他不可逆副作用。
- 发送文件前以运行回执和文件存在性做一次本地检查；状态不确定时不静默重复
  上传。

### 5. 验证与文档

- 新增 SessionRuntime、会话隔离、重启连续性、中断提示和副作用确认测试。
- 验证 Gateway 重启/重建后不依赖 SQLite 恢复也能读回同一段对话。
- 记录新的语义边界：恢复保证从“对话连续”转为“对话连续 + 副作用需确认”。
- 实施前新增或修订 ADR，明确替代 ADR-0022/0023 中对 Gateway 仍适用的耐久恢复
  约定，并同步 `CONTEXT.md`、技术概览和部署文档。

## 验收标准

- 同一飞书 Chat 重启或 `-Rebuild` 后能够引用重启前的对话；不同 Chat 不串上下文。
- Gateway 启动不执行完整 DB/快照恢复，且不因旧 publication 或旧 commit 阻塞启动。
- 中断发生在合并、上传等副作用期间时，用户能看到“未确认完成”并主动决定是否重试。
- 新路径不把 Secret 写入 session、运行回执、日志或普通状态文件。
- 旧数据卷仍可保留和回滚；本计划不承诺旧任务自动无感迁移。

## 不在本计划内

- 多 Task 持久调度、跨进程 exactly-once 外部副作用、历史 SQLite 数据清理。
- 立即改造所有本地 TUI/服务器入口；先以飞书 Gateway 作为可控迁移面。
- 在没有新 ADR 和真实重启验收前删除现有 Kernel/Storage 实现。
