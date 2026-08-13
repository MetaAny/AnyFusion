# 飞书持久化 Gateway 自动化

## 状态

- 状态：代码、部署与飞书端真实验收完成
- 计划日期：2026-08-12
- 完成日期：2026-08-13
- Closing implementation commit：`8d0a252` (`feat: automate persistent Feishu gateway`)

## 目标

提供一个独立的 `anyfusion-gateway` Docker 容器，以前台 Gateway 进程维持
飞书 WebSocket 长连接。普通重启与同 schema 镜像重建复用数据和 Project
持久卷，不依赖 SSH、Pi TUI、`nohup` 或隐藏环境变量。

## 实施边界

- `gateway run` 优先于默认 Planner TUI，并对飞书配置、机器人身份与真实
  WebSocket ready 执行严格启动检查。
- Gateway Application Shell 按飞书 `chat_id` 创建稳定、隔离、可恢复的
  `MetaclawSession`，不改变 Kernel 的单活 Task 准入规则。
- 飞书凭据只通过只读 bind mount 载入进程环境；状态、日志、持久卷和
  `docker inspect` 不保存 Secret。
- `docker/gateway.ps1` 负责构建、创建、重启、诊断、日志和健康等待；
  `docker/shell.ps1` 保持交互开发用途。

## 验证

- `npm run lint` 与 `npm run build` 通过；Gateway/Feishu 聚焦测试 33 项通过。
- 最新 `Dockerfile.test` 镜像内完整套件通过：196 个测试文件、808 项测试通过，
  13 项按项目配置跳过。
- Docker 配置已检查：无入站端口、`unless-stopped`、四个只读凭据挂载、
  稳定数据与工作区卷、Gateway 前台命令和健康检查均符合约定。
- `-Rebuild` 与 `-Restart` 均恢复为 healthy，重启前后两个持久卷身份不变；
  日志、PID 1 环境和 `/data` Secret 泄漏检查通过。
- 飞书后台已只读核查：机器人能力、长连接及 `im.message.receive_v1` 已启用，
  长连接验证成功；消息发送、资源和表情回复权限已开通；版本 1.0.0 已发布，
  可用范围为部分成员，当前无待发布修改，因此未制造新的权限或发布变更。
- 飞书私聊连续上下文与重建恢复已通过真实验收：重建后机器人仍准确复述
  重建前口令；同一哈希会话文件保持 inode 不变，并在第三轮后继续增长。
- 图片接收路径已由真实验收确认：飞书图片成功下载到持久卷。验收期间发现
  Planner 上游瞬时连接错误会提前消费内存附件队列；现已改为仅在 Planner
  确定受理后消费，传输状态不确定时保留附件供同一请求重放。Linux 下飞书
  集成测试通过，修复后的 Gateway 已重建并恢复 healthy。
- 2026-08-13 文件创建验收的运行时事实核查确认 Executor 正常完成，表面“卡死”
  实为 `repository_promotion` 等待精确用户授权。飞书现在会显示待发布任务、
  接受“批准本次发布”或“拒绝本次发布”，并在批准后继续合并、最终回复和产物
  回传；多条历史请求存在时，“本次”稳定指向最新请求。
- 单独附件现在会立即回执实际文件名；富文本 `post` 会同时保留文字与内嵌图片，
  不再因消息类型分支丢弃文字。Linux 容器内飞书集成与事件归一化测试共 79 项
  通过，宿主 `npm run lint` 通过，部署容器再次重建后为 healthy/connected；原
  Task、Subtask、授权请求和 publication 均由持久卷恢复。
- 授权交互进一步闭环：授权前卡片直接展示 durable candidate 的 Executor 摘要、
  变更路径及不超过 64 KiB 的文本产物内容预览；批准后等待 integrated publication
  投影，而不依赖瞬时 Session 输出，再从最终 Project artifact 路径发送完成卡片与
  原文件。新增“重发上次结果”用于补投已集成但历史上漏发的最近结果。Linux 下
  飞书、Session publication 恢复与 TUI 权限投影测试共 95 项通过。
- 2026-08-13 真实发布与文件交付验收通过：Project `main` 在审批前前移时，
  Gateway 保留旧候选、将其同步到最新 `main`，并生成新的精确发布授权；用户发送
  “批准本次发布”后，publication 以 integration commit `abb5c95a244a309a3dffb541a393b099d0668785`
  进入 `integrated`，最终产物 `/workspace/default/最新AI动态简报_2026-08-12.md`
  存在且大小为 21,371 字节。飞书审计记录 `artifact/notice` 与 `artifact/file`
  均为 `ok:true`，用户确认可见最终产物。
- 发布恢复补充修复覆盖两项真实运行缺口：Gateway 启动时预加载拥有未完成发布
  或未收敛完成投影的飞书 Session；已同步工作树 HEAD 只要同时包含旧候选与当前
  `main` 即可幂等恢复，绝不复用旧授权；完成通知已持久化时，`ready` Task 通过
  合法生命周期转换收敛到 `done`。最终重建后 Task/Subtask 为 `done`、publication
  为 `integrated`、completion outbox 为 `sent` 且 `delivery_attempts=1`，未重复发件。
- 本轮新增与相关聚焦 Linux 回归共 14 项通过；宿主 `npm run lint` 通过。最终
  `anyfusion-gateway` 使用镜像 `sha256:646e365a0598e48a4940354f37754dcdc7ed4c9b7088f1629bc2b8a1fc3eb089`，
  状态 healthy、重启策略 `unless-stopped`，持久卷与飞书长连接正常。

## 完成记录

已交付独立持久化 Gateway、严格飞书连接生命周期、按 Chat 隔离的稳定会话、
安全凭据装载、健康/诊断命令及统一 Docker 运维脚本。飞书真实私聊、重建后
上下文恢复、图片接收、发布预览、审批后合并以及最终文件发送均已完成验收。
实现提交已记录；本文件的归档更新由后续文档提交完成。
