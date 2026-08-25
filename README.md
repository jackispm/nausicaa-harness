# Nausicaa

Nausicaa 是一个处于设计阶段的高性能 Agent harness。它面向长程任务，核心不是再造一个模型 SDK，而是探索一种不同于普通 DAG 的多节奏 Agent 图：主线推进工作，多条具有不同拓扑关系、步长、预算和权限的辅助线持续观察、质疑、发散和协作。

当前仓库只保存产品和技术设计，**没有运行时代码、CLI、UI 或 npm 开发脚本**。这些边界尚未通过实验验证，不应提前实现成不可替换的框架。

## 核心假设

- 主线与辅助线拥有不同的步长、预算和上下文视图，不强行同步。
- 图中的边不只有 `depends-on`，还包括 `observes`、`advises`、`delegates` 和 `joins`；辅助线可以伴随某个节点或决策边存在。
- 辅助线默认只读取主线的结构化状态增量，不读取完整 transcript。
- 辅助线可以提出目标漂移、风险、替代方案和关键疑问，但不直接改变主线状态。
- 建议通过可追踪的 A2A 消息在自然决策边界温和注入；主线明确 `accept`、`defer` 或 `reject`。
- Ledger 记录事实，**Fukai Context Runtime** 提供按需查询，Agent 负责判断。

第一条辅助线暂称为 **Teto 线（Teto Lane）**，技术角色名为 `IntentNavigator`。它借用《风之谷》中 Teto 作为伴随和感知的意象，负责监督任务航向、意图完整性和方法选择，不负责 bug 检查。

Fukai 是 Nausicaa 对 RLM 思想的内部命名：庞杂历史留在外部事实层，经过范围、权限和预算过滤，只把当前需要的证据带给 lane。Teto 拥有完整的 Fukai 查询能力，但默认视野最小，不读取主线 transcript 或不必要的事件索引。

整体机制暂称为 **Heterogeneous Lane Graph + Ledger-native Soft Advice Protocol**。它是待验证的核心创新假设，不宣称 Dream/Reflection 或并行 Agent 本身是原创。

## 设计原则

见 [`docs/principles.md`](docs/principles.md)。最重要的约束是 KISS、DIY、复用成熟底层、按需加载、稳定上下文前缀、高缓存命中、显式状态和可恢复运行。

## 技术边界

底层优先使用 [`pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) 处理 provider、模型和流式调用。Nausicaa 自己拥有 Ledger、lane 调度、Fukai、A2A inbox、插件边界和运行策略；是否复用 `pi-agent-core` 必须由实验决定，而不是默认继承其 loop 语义。

UI 是未来独立的产品层，当前不进入 harness 内核。

## 文档

- [`docs/principles.md`](docs/principles.md)：KISS、DIY 和工程约束。
- [`docs/product-requirements.md`](docs/product-requirements.md)：产品目标、核心体验和非目标。
- [`docs/architecture.md`](docs/architecture.md)：运行时分层、Ledger、Fukai、lane 和 A2A 设计。
- [`docs/references.md`](docs/references.md)：参考项目、借鉴边界和待验证差异。

## 当前下一步

先完成术语、事件类型、lane 生命周期、Advice 协议和评测指标的设计；通过小型实验验证 token 成本、缓存命中、延迟、纠偏率和任务成功率后，再建立 TypeScript 实现。
