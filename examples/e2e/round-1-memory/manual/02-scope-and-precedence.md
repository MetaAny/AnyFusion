# Round 1 Manual Scenario 02: Scope And Precedence

目标：验证 `Global / Project / Contact` 同时存在时，系统能按 PRD 规则裁决。`Task-local` 由场景 03 单独验证。

## 前置条件

启动真实 TUI：

```bash
anyfusion
```

## 设置步骤

先写入四类偏好：

```text
/memory add --scope global --type style 输出尽量简洁
```

```text
/memory add --scope project --subject Phoenix --type domain Phoenix 项目材料统一使用 Phoenix 术语
```

```text
/memory add --scope contact --subject 张总 --type contact 给张总的邮件使用正式语气
```

然后输入：

```text
给张总整理一份 Phoenix 项目周报，今天明确要求先保留表格格式
```

## 预期裁决顺序

必须体现以下优先级：

1. 用户当前显式指令
2. contact / project
3. global

## 预期 TUI 展示

执行前应看到注入信息，且至少能分辨：

- 当前输入中的显式要求仍为最高优先级
- contact 偏好被命中
- project 偏好被命中
- global 偏好被命中

如果出现冲突，展示必须能说明：

- 为什么 contact 或 project 被优先
- 为什么 global 没有覆盖更具体的偏好

## 通过标准

- 输出不丢失“表格结构”
- 面向张总的沟通风格保持正式
- Phoenix 术语被保留
- TUI 能解释这些要求分别来自哪里
