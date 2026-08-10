# Round 2 Manual Scenario 03: Unblock And Resume Guidance

目标：验证 blocked 任务解除后，系统会主动给出恢复建议，而不是只默默切状态。

## 前置条件

启动真实 TUI：

```bash
anyfusion
```

## 输入步骤

先创建一个会 blocked 的任务，例如：

```text
整理客户起诉材料并输出处理意见
```

让任务进入 blocked 状态后，执行：

```text
/task unblock <task_id> /tmp/evidence-v3.pdf
```

## 预期 TUI 展示

解除阻塞后，除状态变化外，还应看到一个主动指导块：

- 任务已经具备恢复条件
- 为什么现在适合恢复
- 建议的下一步动作

如果当前没有别的更高优任务，应优先恢复该任务。

## 通过标准

- 用户能看见系统不是只改状态，而是主动指导恢复
- 恢复建议带有可解释原因
