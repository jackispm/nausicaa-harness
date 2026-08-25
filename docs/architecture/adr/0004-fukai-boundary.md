# ADR 0004: Fukai Is The Context Boundary

状态：Proposed。

## Context

RLM 的价值是让模型按需操作外置上下文。完整 RLM execution 还包含持久代码环境、递归、沙箱、中断和恢复，一次性实现会使 Nausicaa 变成大型执行平台。与此同时，让每条 lane 自己扫描 Ledger 或复制主线历史，会破坏上下文纪律和缓存效率。

## Decision

将 Nausicaa 的 RLM-inspired context runtime 命名为 **Fukai**。Ledger/Store 是事实层，Fukai 是所有模型 lane 唯一的读取边界。

第一阶段只实现 Fukai Core：

- 按 watermark/过滤器查询事件，按 ref/range 读取 Artifact。
- 从最小 Wake Capsule 和按需 Evidence 组装 Context View。
- 返回 refs、hash、watermark 和截断原因。
- 写入 checkpoint、Advice 和查询审计。
- 对 token、字节、次数和时间实行硬预算。

Teto 拥有与 Main 相同的 Fukai Core 操作集和完整有界查询原语，但默认只收到 Goal、成功条件、不透明触发引用、cursor、固定 upper watermark 和预算；不接收 transcript、工具日志、changedRefs 或全量索引。它可以在固定 watermark 内连续查询，直到本轮预算耗尽。

## Consequences

- Main 和所有辅助 lane 使用同一上下文机制，只改变 policy 和 visibility。
- Teto 可以主动取证，而不会成为第二份昂贵的主线。
- Prime 的函数化 RLM 思路仍可从同一 seam 继续扩展。
- 第一阶段不提供任意代码执行、持久 REPL、无限递归或模型自行创建 lane。

## Revisit when

只有当结构化查询无法表达真实任务，且 Fukai Execution 带来可测量的质量/成本收益时，才另立 ADR 评估持久代码 runtime、沙箱和恢复。
