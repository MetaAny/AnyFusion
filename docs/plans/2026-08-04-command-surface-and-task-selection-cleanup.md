---
status: implemented_pending_external_validation
plan_date: 2026-08-04
---

# Command Surface And Task Selection Cleanup

## Scope

第一批对话命令技术债清理，覆盖 MetaClaw CommandCatalog、Executor/Profile 只读展示和 AnyFusion-Pi 原生命令补全适配。Permission 主动通知与按钮确认留到第二批；旧 Ink TUI 保持不变。

## Delivered Behavior

- `/task complete`、`/learning promote`、`/learning patch promote`、`/executor register`（含 wizard）和 `/executor unregister` 从命令树、帮助、补全和执行解析移除；底层 handler/service 保留。
- Task 候选以标题优先展示，描述状态和更新时间，最终 replacement 始终写入 immutable task id。
- 仅保留 operation-first Task 语法，删除 target-first 归一化。
- `/profile executor` 展示 AgentClass 静态画像与 skill 使用统计；`/executor list` 展示核心能力和 class health。

## Validation

MetaClaw 已完成聚焦测试断言迁移、`git diff --check` 和 `npm run lint`。另外修复了 `completion-protocol.ts` 的完成态联合类型收窄，以及 `ExecutorAttemptRuntimeRepo.recordWorkspaceDelta()` 对结构化 WorkspaceDelta 的过度类型约束。

Docker 验证结果：

- `npm run lint`：通过；
- 聚焦 Vitest：4 个文件、31 个测试通过，4 个既有 skip；
- `docker run --rm metaclaw-test npm test`：190 个文件中 186 通过、4 个 skip；746 个测试中 731 通过、15 个 skip；
- 未运行 smoke。

AnyFusion-Pi 现有适配器已能直接展示 Host 返回的标题/描述并写入 replacement text；其 fork 位于工作区外，当前环境无法写入对应测试文件，因此 Pi 测试与 `npm run check`/`npm run build:offline` 未执行。

## Closing

待 AnyFusion-Pi 外部工作区测试更新和约定验证完成后，补充 completion_date 与 closing commit。
