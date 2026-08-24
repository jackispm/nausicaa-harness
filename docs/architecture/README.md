# Architecture Reading Guide

这些文档描述 Nausicaa 的目标运行时。它们刻意不包含 TypeScript 类、函数实现或具体数据库 schema；先稳定概念和不变量，再选择实现。

## 阅读顺序

先看系统边界，再看事实层和调度，最后看扩展、恢复与评测：

```text
boundaries -> ledger -> lanes -> RLM -> A2A
                    -> plugins -> recovery -> performance -> evaluation
```

## 文档状态

- **Invariant**：如果实现违反它，说明架构或实现有问题。
- **Proposal**：当前推荐方案，必须通过实验或实际约束修正。
- **Open**：暂不做决定，禁止在代码里偷偷固定。

## 术语速查

- **Run**：一次长期目标的可恢复执行边界。
- **Lane**：Run 内拥有独立 cursor、预算、上下文视图和生命周期的执行线。
- **Step**：lane 的一个模型决策及其可选工具过程，不等于全局时钟 tick。
- **Ledger**：追加写入、可重放的结构化事实流。
- **Store**：保存大对象和原始结果的内容寻址存储。
- **Projection**：从 Ledger 计算出的可丢弃视图，例如 Inbox、Budget 和 Context Capsule。
- **Advice**：辅助线给主线的带证据、置信度和 TTL 的建议。
- **Capability**：插件或工具声明的可调用能力及其权限边界。

## 设计纪律

文档中的“主线”“Teto”“Explorer”“Critic”是 lane 策略，不意味着必须创建不同的 Agent 类。优先用同一 runtime 的不同策略和 context view 表达差异，避免概念膨胀。

ADR 记录关键取舍：`adr/0001-pi-ai-boundary.md`、`adr/0002-ledger-as-source-of-truth.md`、`adr/0003-intent-navigator-soft-advice.md` 和 `adr/0004-minimal-rlm-boundary.md`。
