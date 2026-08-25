# Product Requirements

状态：设计讨论稿。仓库当前不包含实现；本文件记录目标、假设和验证方向。

## 定位

Nausicaa 是面向长程工作的 Agent harness。它不是单纯的 CLI、TUI 或多 Agent 面板，而是一个让 Agent 能持续运行、在异构多线图中并行思考、互相通信、恢复执行并保持目标聚焦的运行内核。未来可以由独立 UI 管理它。

## 核心体验

用户提交一个长期目标后：

1. 主线负责拆解和推进可执行工作。
2. 第一条辅助线 Teto 线（`IntentNavigator`）以独立步长观察航向、意图完整性和方法选择。
3. 其他 Explorer、Critic 或 Worker 线按图中的 typed edges 协作，不被强制同步。
4. 辅助线只通过结构化 Advice 提醒，不把第二份完整上下文塞进主线。
5. 主线在决策边界采纳、延后或拒绝建议，并留下可追踪理由。
6. 任务、消息、产物和决策都可暂停、恢复、审阅和回放。

## 必须具备

- 主线与辅助线的独立预算、步长、上下文视图和生命周期。
- 具有 `observes`、`advises`、`delegates`、`depends-on`、`joins` 语义的异构多线图，而不是只有串行 loop 或通用 DAG。
- Ledger-first 的事实记录，以及按需查询的大对象 Store。
- Fukai Core：所有 lane 通过有界查询读取事实，而非每轮复制全部历史；持久代码 runtime 不属于第一阶段必需能力。
- A2A 消息、Inbox、任务交接、建议确认和幂等语义。
- 插件化的工具、能力、模型适配和执行策略。
- 稳定上下文前缀、增量状态和缓存命中观测。
- 可恢复、可重放、可解释的运行记录。

## 非目标

第一阶段不做完整 UI、不做插件市场、不做向量数据库、不做通用 Agent graph 平台、不复制某个参考项目的全部功能，也不为了“自研”重写 provider 或模型协议。

第一阶段的 TUI、入口和 JSON settings 参考 Prime/Pi 的轻量风格，直接复用 `pi-tui`；不引入复杂子命令树、TOML profile 矩阵或插件配置语言。

## 核心创新假设

“Heterogeneous Lane Graph + Ledger-native Soft Advice Protocol”是待验证的差异化假设：不同 lane 以不同节奏和上下文视图挂接到主线节点或边，通过 typed A2A 关系并行协作。Teto 线是第一种意图航向 lane；Dream、Reflection、并行 Agent 和 A2A 各自已有先例，不能单独作为原创声明。

产品不以堆叠 Prompt、planner 或启发式纠错来长期补偿模型。核心赌注是：模型越强，越能利用独立 lane 的不同视角、Fukai 的选择性取证和 A2A 协作；这个趋势必须通过跨模型对照实验验证。

## 验证指标

每个实现阶段至少比较普通单 loop 与多 lane 方案的：任务成功率、目标偏离纠正率、无效建议率、token/美元开销、P95 延迟、缓存读取比例、恢复成功率和人工介入次数。
