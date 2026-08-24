# Replay And Recovery

状态：Invariant + Proposal。长程 harness 的可信度取决于“中断后能否继续”，而不是一次成功的演示。

## 三种恢复模式

1. **Recorded replay**：使用已记录的模型响应、工具结果和 Artifact refs，不产生外部副作用。用于调试和回归。
2. **Live resume**：从 checkpoint 继续，只对明确允许的未完成 operation 重新调用外部系统。
3. **Verify replay**：重建 Context View、policy、tool schema 和请求 hash，比较当前结果与历史差异。

模型非确定性意味着不能默认保证逐字 replay；可以保证事件链、输入引用、预算和决策来源可重建。

## Checkpoint 内容

Checkpoint 只保存恢复所需的最小快照：

```text
ledger watermark
projection version and checksum
each lane cursor and lifecycle
pending inbox/advice
budget reservations and charges
in-flight operation ids
policy/model/capability versions
plugin snapshot refs
```

不把完整 Prompt 作为 checkpoint 的唯一内容；Prompt 从 Ledger、Store 和 policy 重新组装。

## 提交顺序

```text
prepare snapshot -> write and checksum
-> append checkpoint.committed
-> expose new recovery watermark
```

恢复时取最新有效的 committed checkpoint，校验 checksum，再 replay 后续事件。未完成 snapshot 不能成为恢复来源。

## 外部副作用

每个工具、远程请求或写操作都使用 operationId，并记录：

```text
requested -> started -> succeeded | failed | cancelled | unknown
```

如果进程在结果写回前崩溃，恢复时先查询 executor 或要求确认；不能因为“上次可能失败”就盲目再次执行。至少一次投递与至少一次执行必须通过幂等协议或人工门控制风险。

## 事件演进

事件不可变，schemaVersion 随事件保存。字段弃用通过新版本或 projection migration 处理；旧事件必须继续可读。任何改变事件语义的设计都需要迁移说明和 replay 对照实验。

## 暂停和取消

暂停是调度状态变化，不等于杀掉当前外部副作用。取消必须区分：已取消的等待、已发送但未知的 operation、和已完成的副作用。用户看到的状态必须来自事件，而不是进程是否还存活。

## 恢复验收

至少验证：模型请求中断、工具调用中断、Advice 未处理、Teto/Explorer 失败、重复消息、损坏 checkpoint、schema 升级和 Store 缺失引用。每种情况都要有明确的继续、暂停、失败或人工确认结果。
