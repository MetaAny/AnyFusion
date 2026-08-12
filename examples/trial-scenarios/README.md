# Metaclaw Trial Scenarios

这套案例用于给用户直接试用 Metaclaw，覆盖两类场景：

- `scripts/`：可直接用 `metaclaw --script <file>` 或 `node dist/index.js --script <file>` 运行的脚本化案例
- `manual/`：需要在真实 TUI 里手动输入，才能覆盖多任务、抢占、阻塞恢复这类交互场景

## 使用方式

先构建：

```bash
npm run build
```

直接跑脚本案例：

```bash
node dist/index.js --script examples/trial-scenarios/scripts/00-command-smoke.txt
```

如果要用全局命令：

```bash
metaclaw --script examples/trial-scenarios/scripts/00-command-smoke.txt
```

## 场景清单

### 脚本化场景

- `scripts/00-command-smoke.txt`
  - 不依赖外部执行器成功返回
  - 用于验证 `/help`、`/task list`、`/task dashboard`、`/config`

- `scripts/01-byd-catl-research.txt`
  - 真实行业调研问题
  - 用于验证新建任务、执行器派发、完成后进入 `/task list done`

- `scripts/02-memory-observation.txt`
  - 真实沟通类任务
  - 用于验证偏好观察和 `/memory candidates`

### 手动交互场景

- `manual/01-preempt-high-priority.md`
  - 验证单执行器下的多任务抢占

- `manual/02-block-and-unblock-with-materials.md`
  - 验证阻塞、解除阻塞、附带新材料恢复

- `manual/03-task-list-and-follow-up.md`
  - 验证 `/task list` 分组、`/task show <id>` 详情、已完成任务后的 follow-up

## 推荐补充试用

如果要验证最新的商用化亮点，不要只跑 `trial-scenarios/`，还建议直接运行这些分轮验收包：

- `examples/e2e/round-12-risk-gate/`
  - 高风险动作先确认再执行
- `examples/e2e/round-13-preference-inline-confirm/`
  - 候选偏好支持 `y / n / e <新内容>`
- `examples/e2e/round-14-task-artifacts/`
  - 执行器写出的文件回流为任务产物
- `examples/e2e/round-15-tui-refresh/`
  - 新 TUI 的运行摘要、执行步骤、等待提示、结果块

## 素材文件

`assets/` 下放了可直接引用的真实业务风格材料，方便在手动场景中做 `/task attach <id> <资源路径>` 或 `/task resume <id> <资源路径>`：

- `assets/byd-catl-brief.md`
- `assets/foshan-plastics-brief.md`
- `assets/customer-evidence-v3.md`
- `assets/hermes-openclaw-notes.md`

## 建议试用顺序

1. 先跑 `scripts/00-command-smoke.txt`
2. 再跑 `scripts/01-byd-catl-research.txt`
3. 然后打开 `manual/01-preempt-high-priority.md` 做真实交互试用
4. 最后跑 `manual/02-block-and-unblock-with-materials.md`

## 注意

- 真实调研类案例依赖默认执行器 `codex`
- 如果当前环境网络受限，命令类脚本可以正常验证，但真实研究任务可能会因外网连接失败而挂起
- 手动场景里凡是需要 `<task_id>` 的地方，都先执行 `/task list` 复制任务 ID
- 写入目录类案例建议直接使用 `/tmp` 或当前项目下的 `projects/` 目录，便于观察任务产物回流
