# 飞书发布授权自动通过

## 状态

- 状态：实现完成并已部署，等待真实飞书消息验收
- 计划日期：2026-08-13
- 完成日期：2026-08-13

## 目标

在持久化飞书 Gateway 中隐藏并自动通过 `repository_promotion` 用户审批环节，
使多子任务工作图可连续完成调研、制品生成、Git publication 与文件交付。
CLI、TUI、RPC 及未显式启用该策略的飞书部署继续使用手动审批。

## 实现

- 新增 `gateway.platforms.feishu.delivery.publication_approval: manual | auto`，默认
  为 `manual`。
- Windows Docker Gateway 配置和启动环境显式选择 `auto`；环境覆盖确保现有
  持久卷内的旧 `config.yaml` 无需改写。
- 自动模式检测到 publication 后调用现有 Session 权限决议接口，不修改 SQLite，
  不跳过 Kernel，也不直接合并 Git。
- 同一 Task 后续产生的新 publication 会继续自动批准，直到最终 Executor result
  和产物完成飞书交付。
- 同一 Session/Task 的并发消息复用一个自动发布 Promise，避免重复批准与重复交付。
- 自动批准中间 publication 后继续等待同一 Task；只有 Task 达到 `done` 才选择
  最新 integrated result 作为最终交付，避免把上游 Markdown 当作最终文件。
- Gateway 审计以 `permission/local` 记录每个自动批准的 request ID；飞书用户侧不再
  收到审批预览、批准口令或批准确认卡。

## 验证

- `npm run lint`：通过。
- Linux Docker 聚焦测试：飞书集成、配置加载和 Docker 运维共 101 项通过。
- 多阶段回归场景覆盖“调研 Markdown 已合入、PDF 子任务仍运行、稍后产生第二次
  publication”，确认 Markdown 不会被提前发送，最终仅上传 PDF。
- Linux Docker 完整测试：822 项通过，13 项按条件跳过。
- `docker/gateway.ps1 -Rebuild`：通过；容器健康状态为 `healthy`，重启策略为
  `unless-stopped`，未发布宿主端口，飞书 WebSocket 与 Gateway socket 均已就绪。
- 运行镜像：`sha256:ed55b16a7f7585be9be3b4c172354a97bfbe1b2df4d0e2e1f3a014e6d5164913`。
- 升级前已经停在 `awaiting_approval` 的 Task 会在所属 Chat 的下一条消息到达时
  进入新自动批准路径；无需再发送批准口令。真实文件交付验收待该消息触发。
- Closing commit：待与工作区中并行文档整理变更分离后补记。
