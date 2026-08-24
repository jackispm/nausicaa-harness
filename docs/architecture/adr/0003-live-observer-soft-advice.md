# ADR 0003: Live Observer With Soft Advice

状态：Core hypothesis；不是已验证的行业标准，也不是对 Dream/Reflection 的原创声明。

## Context

普通 loop 通常把模型思考限制在一条连续路径；后台反思和并行 Agent 已有多个先例。Nausicaa 想验证一种更克制的辅助线：它以不同步长观察主线，发现问题时提供帮助，但不复制完整上下文，也不频繁打断。

## Decision

Observer lane 订阅 Ledger 的增量 projection，按需查询局部 Evidence，输出带证据、置信度、优先级和 TTL 的 Advice。Advice 进入 Inbox，在 Main 的自然决策边界处理为 accept、defer 或 reject。Observer 默认无主线写权限。

## Consequences

- 辅助线 token 和延迟可以独立控制。
- 建议来源、证据和结果可评测。
- capsule、query budget、冷却和防递归是必需机制。
- 可能增加噪声、事件量和调度复杂度，必须用 baseline 验证收益。

## Revisit when

如果 Advice 采纳率、纠偏收益或单位成本长期不优于 baseline，应降低 Observer 能力或删除该 lane 类型，而不是继续堆叠规则。
