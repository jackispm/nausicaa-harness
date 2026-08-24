# ADR 0002: Ledger Is The Source Of Truth

状态：Proposed。

## Context

内存 AgentState、Prompt 和 session JSONL 都能保存一部分运行信息，但多 lane、崩溃恢复和跨进程协作要求一个统一、可重放的事实来源。

## Decision

所有跨 lane 的事实、意图、结果、消息、预算、Advice 处理和 checkpoint 都写入 append-only Ledger。Prompt、Inbox、Budget、Lane View 和 AgentState 都是从 Ledger 生成的 projection；Store 保存大对象并通过引用连接。

## Consequences

- 可以从事件重建请求和 lane 视图。
- 能够审计 Advice 的证据与处理理由。
- 事件 schema、存储和归档需要长期维护。
- 不能把模型摘要当作事实覆盖原始事件。

## Revisit when

只有在性能、隐私或一致性实验明确证明单一 Ledger 不足时，才引入分层或外部事实服务；拆分后仍必须保持可重放语义。
