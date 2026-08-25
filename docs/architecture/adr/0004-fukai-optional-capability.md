# ADR 0004: Fukai Is An Optional Context Capability

状态：Proposed。

## Context

RLM 的价值是让模型按需操作外置上下文。完整 RLM execution 还包含持久代码环境、递归、沙箱、中断和恢复，一次性实现会使 Nausicaa 变成大型执行平台。与此同时，让每条 lane 自己扫描 Ledger 或复制主线历史，会破坏上下文纪律和缓存效率。

## Decision

将 Nausicaa 的 RLM-inspired context capability 命名为 **Fukai**。Ledger/Store 是事实层；Fukai 是可插拔的按需上下文 provider，不是所有 lane 的唯一读取边界。

Fukai 不属于 Teto 的 Phase 1 必需路径。若作为独立实验实现，Fukai Core 只包括：

- 按 watermark/过滤器查询事件，按 ref/range 读取 Artifact。
- 从最小 Wake Capsule 和按需 Evidence 组装 Context View。
- 返回 refs、hash、watermark 和截断原因。
- 写入 checkpoint、Advice 和查询审计。
- 对 token、字节、次数和时间实行硬预算。

Teto 不依赖 Fukai。它消费 runtime 生成的固定大小 `ObservationFrame`，不接收 transcript、工具日志、changedRefs 或全量索引；信息不足时通过 A2A 向 Main 提交窄问题。

## Consequences

- 需要外置上下文的 lane 可以复用 Fukai，不改变 Ledger 和 A2A 契约。
- Teto 可以保持低成本观察，不成为第二份昂贵的主线。
- Prime 的函数化 RLM 思路仍可作为独立 provider 实验继续扩展。
- 第一阶段不提供任意代码执行、持久 REPL、无限递归或模型自行创建 lane。

## Revisit when

只有当某个 lane 的 Context Contract 无法表达真实任务，且 Fukai Execution 带来可测量的质量/成本收益时，才另立 ADR 评估持久代码 runtime、沙箱和恢复。
