# Round 1 Manual Scenario 03: Task-Local Memory On Resume

目标：验证一个任务被挂起或抢占后恢复执行时，会优先延续该任务自己的 task-local 记忆，而不是被全局记忆覆盖。

## 前置条件

启动真实 TUI：

```bash
anyfusion
```

## 设置步骤

先创建一个长期任务：

```text
整理 Phoenix 项目的季度复盘，并输出成表格版周报格式
```

获取任务 ID 后，设置 task-local 偏好：

```text
/memory add --scope task-local --subject <task_id> --type style 当前任务固定使用表格结构并保留风险栏目
```

再增加一个更宽泛的全局偏好：

```text
/memory add --scope global --type style 输出尽量短，不强制表格
```

让该任务开始执行后，插入高优任务：

```text
紧急：先帮我总结今天的会议纪要
```

等高优任务完成后，恢复之前挂起的任务：

```text
继续之前挂起的任务
```

## 预期任务状态变化

- 原任务从 `running` 进入 `parked`
- 高优任务执行完成
- 原任务重新恢复执行

## 预期 TUI 展示

恢复任务时，必须看到：

- 恢复上下文说明
- 本次恢复原因
- 命中的 task-local 偏好
- 如果 global 偏好也命中，不能覆盖 task-local

memory 注入信息中，task-local 应排在 broader scope 之前。

## 通过标准

- 恢复后的任务继续保持“表格结构 + 风险栏目”
- 全局“尽量短”不能破坏 task-local 要求
- 用户能通过 TUI 直接确认本次恢复是如何使用记忆的
