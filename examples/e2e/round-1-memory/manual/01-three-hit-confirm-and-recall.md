# Round 1 Manual Scenario 01: Three-Hit Confirm And Recall

目标：验证同一偏好在三次重复后进入待确认状态，确认后在第四次同类任务中被自动召回。

## 前置条件

- 已构建当前版本：

```bash
npm run build
```

- 以真实 TUI 启动：

```bash
anyfusion
```

## 输入步骤

依次输入以下四个任务，等待每个任务完成后再输入下一个。

```text
给张总写一封邮件，内容是汇报本周进展，用正式语气
```

```text
再给张总写一封邮件，内容是同步项目风险，用正式语气
```

```text
继续给张总准备一封邮件，内容是安排下周会议，用正式语气
```

在第三个任务完成后，执行：

```text
/memory candidates
```

然后确认候选偏好：

```text
/memory confirm <observation_id> --scope contact --subject 张总
```

再输入第四个任务：

```text
给张总再起草一封邮件，内容是提醒确认预算
```

## 预期任务状态变化

- 前三个邮件任务都应完成
- 第三个任务完成后，系统应提示检测到重复模式
- 确认后，偏好进入已确认状态
- 第四个任务执行前，系统应自动注入相关偏好

## 预期 TUI 展示

必须看到以下类型的信息：

- 第三次后出现待确认提示
- `/memory candidates` 能看到该模式及出现次数
- `/memory confirm` 后显示已确认
- 第四次任务执行前显示 memory 注入块

memory 注入块至少应包含：

- scope
- content
- confidence
- 命中原因

## 通过标准

- 不需要用户第四次重复“用正式语气”
- 系统自动注入该偏好
- 用户能看懂为什么注入了这条偏好
