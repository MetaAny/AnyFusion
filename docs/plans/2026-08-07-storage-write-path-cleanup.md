---
status: completed
plan_date: 2026-08-07
completion_date: 2026-08-07
---

# Storage Write Path Cleanup

## Scope

本轮只删除冗余持久化和重复写入，不新增产品功能：

- 删除无生产消费者的 route、guidance 和 reflection 持久化；
- 收敛 Skill effect summary 与 Task event 的写入 interface；
- Skill usage 明细只持久化终态事件，运行期 verifier evidence 保持不变；
- 删除只由测试调用的 repository 方法；
- 硬切单一 SQLite v31 基线，不保留旧 schema 升级或双读路径；
- 保留 `kernel_events` 与 `task_events` 完整历史，不增加 retention module。

## Delivery Order

1. 用聚焦测试锁定终态 Skill 持久化、summary 原子写入、Task event envelope 和 feedback 去重。
2. 让 `SkillEffectSummaryRepo` 成为 summary 表唯一写入者，并把 Task event envelope 并入 `TaskEventRepo`。
3. 将 learning candidate 来源改为 Skill usage event，删除 reflection 与 guidance repository。
4. 建立纯 v31 fresh schema，删除旧表、索引、迁移代码和测试保活实现。
5. 更新 `CONTEXT.md`、ADR-0023、current technical overview 和 docs map。

## Validation

- `npm run lint`
- `npm run build`
- Docker 全量 `npm test`
- `npm run smoke:metaclaw`
- `npm run smoke:metaclaw -- --scenario artifact`

## Completion

Delivered behavior:

- `TaskEventRepo` 直接拥有 ID 与时间戳 envelope，删除 recorder 薄壳和测试专用查询；
- `SkillEffectSummaryRepo` 成为 summary 唯一写入者，usage detail 与 summary 保持同一事务；
- 过程型 Skill event 只保留为 attempt evidence，数据库只保存四种终态；
- learning candidate 直接引用 Skill usage event，删除 reflection、guidance 与 executor route event 持久化；
- SQLite 硬切 fresh-only v31，删除全部旧 schema 升级与兼容代码，并同步 Docker volume 隔离；
- 保留 `kernel_events` 与 `task_events` 完整历史。

Validation:

- `npm run lint`
- `npm run build`
- Docker full suite: 185 files / 738 tests passed; 4 files / 15 tests skipped
- `npm run smoke:metaclaw` (`planner-session`)
- `npm run smoke:metaclaw -- --scenario artifact`

Closing commit: `refactor: simplify storage write paths`
