# Manual Scenario 02: Blocked Task And Resume With New Materials

目标：验证任务阻塞后不会锁死系统；解除阻塞时可附带新材料，并按 `resume-blocked` 恢复。

## 前置素材

用仓库内现成材料：

```text
examples/trial-scenarios/assets/customer-evidence-v3.md
```

## 步骤

1. 新建一个真实法务任务：

```text
请帮我梳理一份客户纠纷材料，整理起诉书需要补齐哪些关键证据
```

2. 等任务创建后，执行：

```text
/task list
```

3. 复制该任务的 `<task_id>`，然后阻塞它：

```text
/task block <task_id> 等待客户补充付款记录和聊天证据
```

4. 再提交一个新的普通任务，确认系统还能继续工作：

```text
帮我整理一下下周产品评审会议的议程提纲
```

5. 等拿到新材料后，解除阻塞并附带资源路径：

```text
/task resume <task_id> examples/trial-scenarios/assets/customer-evidence-v3.md
```

6. 再执行：

```text
/task show <task_id>
/task list
```

## 预期

- 被 `block` 的任务进入 `已阻塞`
- 阻塞任务不会阻止你提交和执行其他任务
- `unblock` 后任务恢复时，输出文案会明确“新增资源”
- 任务详情中的 `资源` 应包含新附带的材料路径
