# ADR 0003: Teto IntentNavigator And Soft Advice

状态：Core hypothesis；不是已验证的行业标准，也不是对 Dream/Reflection 的原创声明。

## Context

Nausicaa 的核心不是再开一个“反思 Agent”，而是验证一种异构多 lane 图：辅助线以不同步长挂接到主线节点或决策边，拥有不同的可见性和权力。第一条标准辅助线需要守护任务航向，而不是承担代码质量检查。

## Decision

将第一条辅助线命名为 **Teto 线（Teto Lane）**，技术角色名为 `IntentNavigator`。名称借用《风之谷》中 Teto 作为伴随和感知的意象。Teto 通过 `observes` + `advises` 边挂接 Main，只接收 runtime 生成的最小 `ObservationFrame`，不调用 Fukai；必要信息通过窄 A2A 问答补充，输出 `orientation`、`intent-gap` 或 `method-alternative` Advice。

Advice 进入 Inbox，在 Main 的自然决策边界处理为 `accept`、`defer` 或 `reject`。Teto 默认只读，无工具写权限，不执行 bug 检查，也不直接改变 Main 状态。

Teto 使用稀疏 cadence：默认每累计约 5～7 个 Main LLM 调用运行一个单步 observation pass，滚动 20 个 Main 调用最多 4 次。关键事件可以提前占用额度，但不能无界增加调用。

## Consequences

- 图的核心关系不再只有 `depends-on`，Teto 可以伴随 Main 而不阻塞 Main。
- 航向监督、方法发散和代码质量审查可以拆成不同 lane，预算与评测互不污染。
- 需要设计 typed edges、ObservationFrame、Advice 去重和防递归。
- 可能增加事件量和建议噪声，必须与单 loop 和普通 Reflection baseline 比较。

## Revisit when

如果 Teto 的纠偏收益、意图缺口发现率或单位成本长期不优于 baseline，应降低它的默认预算或删除该 lane 类型，而不是继续堆叠规则。
