# Ledger And Runtime

状态：Invariant + Proposal。Ledger 是 Nausicaa 区别于普通内存 Agent loop 的核心事实层。

## 责任划分

```text
Ledger       immutable structured facts
Store        large content and raw outputs
Projection   rebuildable read models
Runtime      command admission and query boundary
Scheduler    wakeups and resource allocation
```

Ledger 不保存完整 Prompt，也不承担全文搜索数据库的职责。Store 保存文件、工具输出、模型原始响应、长 transcript 片段和可复用摘要；Ledger 保存它们的引用、摘要、hash、来源和生命周期。

## 事件包络

每个事件至少包含：

```text
eventId, runId, laneId, globalOffset, laneSeq,
type, schemaVersion, occurredAt,
causationId, correlationId, idempotencyKey,
payload or refs, visibility, contentHash
```

- `globalOffset` 用于恢复和增量扫描。
- `laneSeq` 描述单 lane 的局部序列。
- `causationId` 表达命令、模型响应、工具结果和 Advice 的因果链。
- 时间只用于展示和 TTL，不用于决定事实顺序。
- 事件不可修改；纠正通过追加补偿事件完成。

## 事件类别

```text
run/*             goal/*             lane/*
step/*            model/*            tool/*
artifact/*        question/*         uncertainty/*
message/*         advice/*            budget/*
checkpoint/*      policy/*            plugin/*
```

必须区分“意图”和“结果”：例如 `tool.requested` 不等于工具已经执行，`advice.issued` 不等于主线已经采纳。

## MVP 不变量

- Ledger 只追加、不修改；每个事件有唯一 `eventId`、版本和因果引用。
- 同一 Run 的事件顺序由 `globalOffset` 表达；lane cursor 只能向前移动。
- 固定 Ledger watermark、policy 版本和 visibility 规则，必须生成可重建的同一 Capsule。
- 查询超出 token、字节、事件数或时间预算时必须显式截断，不得伪装成完整结果。
- Goal 修改必须追加新版本事件；不能静默覆盖旧目标或让旧 Advice 继续有效。
- Artifact 通过内容 hash/ref 固定；外部副作用必须拥有 `operationId`。
- lane 崩溃、重复投递或丢弃 Projection 不能改变事实，恢复只依赖 Ledger、Store 和 checkpoint。

## Command 到 Event

所有改变事实的动作都走以下边界：

```text
command received
  -> identity / policy / budget admission
  -> append intent event
  -> external or model operation
  -> append result event
  -> update projections
  -> schedule dependent work
```

Projection 不能直接修改 Ledger；模型不能绕过 runtime 写事实；UI 不能直接修改 Projection。

模型不能直接读取 Ledger、Store 或原始 transcript；runtime 为每条 lane 生成自己的 Context View。内部 selector 可以读取事件元数据进行唤醒和调度，但不能把全量索引直接注入 lane Prompt。Fukai 是一种可选的按需查询 provider；Teto 使用独立的观察上下文，不要求调用 Fukai。

## Projection

从 Ledger 可重建的主要视图包括：

- Goal View：目标、约束、已确认和未决事项。
- Run View：运行状态、预算、策略和最近 checkpoint。
- Lane View：生命周期、cursor、最近 capsule 和 pending work。
- Inbox View：未处理消息、Advice、审批和人工问题。
- Artifact Index：产物引用、hash、来源、权限和过期状态。
- Cost View：模型、工具、查询和缓存使用量。

Projection 可以丢弃、缓存或换实现；事实不能依赖 Projection 才存在。

## 可见性

事件和产物带有来源与 visibility：`main`、特定 lane、run 内共享、用户可见或敏感。默认最小可见；Teto、Explorer 等辅助线只能读到被授权的 projection 和 refs，不能因为拥有 Ledger cursor 就读取秘密。

## 写入与一致性

初版使用单 writer 或等价的顺序化 append。未来支持多 writer 时必须保留全局 offset、幂等 key 和因果引用。跨 lane 的“同时发生”不靠墙上时间解释，而靠事件顺序和版本检查解释。

## 长度控制

事件流可通过 checkpoint、归档和 Store 引用减小热数据，但不能删除仍被事实引用的对象。摘要是查询优化，不是事实替代品；摘要失效时可由原始引用重建。
