# Observability And Evaluation

状态：Proposal。多 lane 系统如果不能解释“谁看到了什么、为什么被唤醒、建议是否有效”，就无法调优或证明收益。

测试分层、OpenRouter 安全边界和 release gate 见 [`../testing-and-acceptance.md`](../testing-and-acceptance.md)。本文只定义运行时观测与评测指标。

## 可观测对象

每个 Run、lane、Step、query、message、Advice、tool operation 和 checkpoint 都需要关联：

```text
run / lane / step ids
causation and correlation ids
ledger watermark
budget reservation and actual usage
input/output refs and hashes
policy decisions
latency and outcome
```

原始模型响应和敏感工具输出进入受控 Store；公开指标只保留脱敏的 refs、hash 和计数。

## 关键指标

### 效果

- 任务成功率和产物质量。
- 目标漂移发现率、纠正率和纠正延迟。
- 高价值 Advice 采纳率。
- Explorer 建议的新颖性、可行性和后续转化率。
- 无效、重复、过期和被拒 Advice 比例。

### 效率

- 每个成功任务的总 token/费用。
- Main 与辅助线的 token 分布。
- provider cache read/write 比例。
- P50/P95 首次响应和完成延迟。
- 查询重复率、Store 读取量和事件扫描量。
- Teto 每次唤醒的 ObservationFrame 字段数/字节、Main step 间隔、A2A 问答次数和有效 Advice 比例。
- 每滚动 20 个 Main LLM 调用的 Teto pass 数，以及 Teto/Main token 比例。

### 可靠性

- checkpoint 恢复成功率。
- 重复副作用率和 unknown operation 数量。
- 消息重复、丢失、过期和背压次数。
- 辅助线故障对 Main 的影响。

## 对照实验

每个多 lane 机制至少与以下 baseline 比较：

1. 单 loop、无辅助线。
2. 单 loop、每轮固定摘要的 Reflection。
3. 并行 lane、共享完整 transcript。
4. Nausicaa 的固定大小 ObservationFrame、稀疏 cadence 和 Soft Advice。

对于 Explorer，额外比较固定随机种子与不同种子，区分“产生更多内容”和“发现更多有效方向”。随机性带来的 token 增长必须和可采纳的替代方案数量一起报告。

任务集合需要覆盖编码、研究、规划、文件修改、长等待和失败恢复。结果必须同时报告质量、成本和延迟，不能只展示最好的成功样例。

同一任务集至少使用两个能力等级的模型。分别测量 Main-only 和 Main+Teto 的绝对质量，以及 Teto 带来的边际收益。我们希望 lane 能随模型增强而更好地理解 ObservationFrame 并产生 Advice；如果边际收益持续归零，就不能把“模型单调性”当作已验证结论。

评测前固定任务集、模型版本、工具版本、预算、随机种子、样本量和权重。对模型 `m` 定义：

```text
utility(m) = quality + correctionValue + acceptedAdviceValue
             - costWeight * cost - latencyWeight * p95
             - noiseWeight * invalidAdviceRate
uplift(m) = utility(Main+Teto, m) - utility(Main-only, m)
```

分别报告 `uplift` 及其置信区间；较强模型应至少不降低 lane 的净收益，并应在更难任务上提高有效 Evidence/Advice 比例。若连续两批预注册任务的 `uplift` 低于零或与零无显著区别，相关机制回到实验 flag，不进入默认内核。

## 事件审计

要能够回答：

- 哪个事件触发了 Teto、Explorer 或 Critic？
- 辅助线实际收到了哪些 frame 字段、附件或 refs？
- Advice 基于什么证据、花费多少预算？
- Main 在哪个边界看到并处理了它？
- 采纳后任务是否真的改善？

## 评测纪律

固定模型、工具版本、任务种子和预算后再比较。记录失败和无效建议，不用人工挑选轨迹。任何新策略先进入实验 flag，不直接成为默认行为。
