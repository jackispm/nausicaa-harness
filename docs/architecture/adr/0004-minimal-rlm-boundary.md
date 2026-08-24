# ADR 0004: Start With RLM-lite

状态：Proposed。

## Context

RLM 的价值是让模型按需操作外置上下文；完整实现还可能包括持久 Python/JS 环境、递归调用、沙箱、中断、环境恢复和跨 lane 共享。一次性实现这些能力会把 Nausicaa 变成另一个大型执行平台。

## Decision

第一阶段只实现 RLM-lite：

- 从 Mission、Capsule 和 Evidence refs 组装 lane context。
- 按过滤条件查询事件，按有界范围读取 Artifact。
- 返回结构化结果、watermark、依赖 hash 和截断原因。
- 写入 checkpoint、Advice 和查询审计事件。
- 所有查询受 token、字节、次数、递归深度和 wall-clock 限制。

RLM-lite 不提供任意代码执行、持久 REPL、无限递归、默认全量读取或模型自行创建未授权 lane。模型调用仍由 `pi-ai` adapter 负责。

## Consequences

- 实现和恢复边界较小，可以先验证 Teto 的按需取证是否有效。
- Prime 风格的函数化 runtime 仍可在后续通过同一 query/store seam 扩展。
- 需要保留 refs、cursor、预算和审计，不能只返回一段文本。
- 如果查询型 runtime 已经解决问题，就不必引入代码执行环境。

## Revisit when

只有当实验显示结构化查询无法表达真实任务，且 RLM execution 带来可测量的质量/成本收益时，才评估持久代码 runtime；届时必须另立 ADR，单独处理沙箱和恢复。
