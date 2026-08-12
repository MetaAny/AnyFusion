# Manual 03: Material And Block Recovery View

## Goal

验证 blocked / resumed 任务在任务视图中能稳定展示材料、阻塞原因和恢复线索。

## Steps

1. 创建一个任务并让它进入 `BLOCKED`
2. 通过 `/task attach <id> <material>` 或 `/task resume <id> <material>` 补材料
3. 再次运行 `/task show <id>`

## Expected

- blocked 时能看到阻塞原因
- 补完材料后能看到材料列表更新
- 恢复后能看到最新快照下一步
- 用户能从任务详情判断“现在能不能继续”

## Fail Examples

- 补过材料但 `/task show <id>` 看不出来
- 阻塞原因只在老 transcript 里，任务详情看不到
- 恢复后的下一步没有体现
