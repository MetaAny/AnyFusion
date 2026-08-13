# 场景 2：给 blocked 任务按 id 补材料

## 步骤

1. 准备一个 blocked 任务
2. 确保当前没有活跃任务焦点
3. 执行 `/task attach <taskId> evidence-a.pdf evidence-b.pdf`
4. 执行 `/task show <taskId>`

## 预期

- 即使没有当前任务，也能给指定任务补材料
- 输出明确指出任务当前仍为 blocked，并提示继续用 `/task resume <id>`
- 任务详情中的 `关联材料` 包含新增文件

