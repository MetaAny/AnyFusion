# Round 2 Manual Scenario 02: Idle Reminder And Throttle

目标：验证会话内 idle 提醒存在，并且 reminder throttle 生效，不会连续轰炸。

## 前置条件

启动真实 TUI：

```bash
anyfusion
```

确保当前配置中：

- `orchestration.reminder_enabled: true`
- `orchestration.reminder_throttle` 设为一个便于观察的短值

## 输入步骤

创建一个 ready 任务：

```text
整理 Phoenix 项目的待办清单
```

让系统处于空闲一段时间，不再输入。

观察是否出现提醒。

在 throttle 时间窗口内继续空闲，观察是否重复提醒。

超过 throttle 窗口后继续空闲，再观察是否重新提醒。

## 预期 TUI 展示

- 空闲时出现会话内提醒
- 提醒内容包含：
  - 建议动作
  - 任务标题或 ID
  - 原因
- throttle 窗口内不重复弹同一提醒
- throttle 过后，如果任务仍然可操作，可以再次提醒

## 通过标准

- reminder 存在
- reminder 不轰炸
- 用户能理解“为什么现在提醒”
