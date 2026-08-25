# ADR 0001: Use pi-ai As The Model Boundary

状态：Accepted for design phase；实现前仍需验证版本和许可证。

## Context

Nausicaa 需要 provider、模型、流式响应和 usage/cache 信息，但这些不是产品差异。直接重写会扩大内核，fork 整个 Pi 又会把 coding-agent 的入口和 loop 语义带进来。

## Decision

以 `pi-ai` 作为底层模型适配边界。Nausicaa runtime 自己负责 lane、Ledger、Fukai context、预算、A2A 和恢复。`pi-agent-core` 只能作为可选 worker 实现，必须通过实验确认不会限制 Ledger-first 调度。

## Consequences

- provider 和模型切换成本较低。
- runtime 可以保持与 CLI/UI 无关。
- 需要自己定义模型请求记录、上下文组装和 tool operation 事件。
- 未来可能需要一个薄 adapter 处理 `pi-ai` 版本变化。

## Revisit when

如果 `pi-ai` 无法提供需要的流式、缓存或 provider 能力，先补 adapter；只有无法通过 adapter 解决时才评估 fork，且优先 fork 单个小包。
