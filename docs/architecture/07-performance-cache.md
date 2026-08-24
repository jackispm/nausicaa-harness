# Performance And Cache

状态：Proposal。高性能不是“并行越多越快”，而是单位有效进展的 token、延迟和资源成本更低。

## 成本面

每个 Run 追踪至少：

- model input/output/cache-read/cache-write tokens。
- query、摘要和 Evidence 的 token。
- tool wall-clock、排队时间和重试次数。
- lane 唤醒次数、有效 Advice 数和无效 Advice 数。
- 主线被延后的时间和 context 构建时间。
- checkpoint、replay 和 Store 读写成本。

所有辅助线预算独立统计，不能把它们的 token 隐藏在 Main 成本里。

## 缓存布局

上下文按稳定性分层：

```text
stable prefix: lane identity, policy, system rules, capability schemas
semi-stable: mission, constraints, confirmed facts
dynamic tail: capsule delta, inbox, recent results, current query
```

稳定前缀必须确定性排序，动态状态通过 watermark 增量追加。随机 heartbeat、实时 roster 和易变计数不能污染前缀。每次 Context View 记录 prefix hash、dependency refs 和 cache outcome。

## 查询优化

- 先用事件类型、标签、visibility 和 watermark 筛选，再让模型判断。
- 大对象使用引用和有限范围读取，不自动展开全文。
- 相同事件窗口、artifact range 和 Advice 使用 hash 去重。
- 查询结果带 truncation reason，避免模型把截断误当完整事实。
- observer 只消费自上次 cursor 的变化，不重复扫描全 Ledger。

## 并发策略

Main 使用保底资源；Teto、Explorer 等辅助线使用可抢占的剩余资源；Worker 受任务级并发限制。调度器需要背压，不能因为事件越积越多就无界创建 lane。并发度由模型延迟、工具类型、预算和 workspace 冲突共同决定。

## 模型分层

模型选择是策略，不是 lane 类型的硬编码：

```text
rule gate -> small classifier/critic -> main model -> optional deep analysis
```

低价值检查尽量不调用大模型；高价值 Advice 必须证明为什么值得消耗额外预算。`pi-ai` 负责 provider/model 调用，Nausicaa 负责选择时机、上下文和预算。

## 性能目标的表达

不预先承诺绝对吞吐或 token 数。每个优化都必须与单 loop baseline 比较：有效进展、纠偏收益、总成本、P95 延迟、缓存读取比例和建议噪声。没有任务成功率提升的“并行”是负优化。
