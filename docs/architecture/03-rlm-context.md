# RLM And Context Views

状态：Proposal。这里借鉴 RLM 的运行时思路，不预设 Python、REPL 或某个具体实现。

## RLM 的核心启发

上下文、文件、事件和中间结果放在持久 runtime；模型通过受限函数查询、筛选和组合所需信息。模型不需要每轮携带完整历史，Prompt 只是当前查询结果的一个投影。

## 三层上下文

```text
Mission       长期目标、约束、用户确认的不可变背景
Capsule       当前 lane 的短状态、事件增量、未决问题和预算
Evidence      通过 query/read 按需获取的局部事件、产物和结果
```

Main 的 Capsule 可以包含当前计划和可写任务；Teto 的 Capsule 只包含目标、成功条件、阶段、计划变化、意图风险和待审问题；Explorer 还可以收到受限的随机采样窗口和历史类比索引。不同 lane 看同一事实层的不同视图。

## 查询边界

RLM runtime 至少需要以下能力族：

```text
goal / constraints
facts / open questions
query events by type, tag, ref or watermark
read artifact by reference and bounded range
compare decisions or artifact versions
inspect lane status and pending messages
publish checkpoint or Advice
```

函数必须返回结构化小结果、证据引用和截断原因。不能存在默认的 `readEverything()`；查询有事件数、字节数、token、递归深度和 wall-clock 限制。

Explorer 的随机采样也必须通过 runtime 完成：采样范围、seed、去重规则和最大窗口由 policy 提供，不能让模型自行读取全库或改变采样边界。Teto 的查询范围则优先覆盖目标、决策和未决问题，不自动展开 bug/tool 细节。

## Context Capsule

Capsule 由 runtime projection 生成，不把模型的长摘要当作唯一事实。建议包含：

- 当前目标和硬约束。
- lane 身份、角色、预算和本次唤醒原因。
- 自上次 cursor 以来的事件增量。
- 当前阶段、下一步候选和未决问题。
- 已改变的产物引用和版本。
- 风险、不确定性和 pending Advice 的摘要。
- watermark、依赖 hash 和过期时间。

## 查询层级

先通过无模型规则筛选事件，再由轻量模型判断是否值得深查，最后才让主模型读取少量 Evidence。这个分层不是必须的实现，但应作为降低成本和噪声的默认方向。

## 记忆分层

```text
L0  当前请求和工具结果
L1  lane checkpoint / open questions / active plan
L2  Run facts、decisions、artifacts index
L3  归档事件和外部知识
```

模型默认只拿 L0/L1，按证据需求查询 L2；L3 必须显式授权。记忆写入也必须区分事实、假设和用户确认，不能把模型猜测自动升级为长期事实。

## 缓存纪律

稳定前缀包含 lane identity、system policy 和确定性 capability schema。动态 capsule 只追加 watermark 之后的增量。每个查询结果带依赖 refs/hash，只有依赖变化才失效；完整 transcript 不进入每条 lane 的默认 Prompt。

## 安全边界

Ledger 事件、产物、用户输入和工具输出都带来源与信任级别。外部文本不能因为进入 Evidence 就获得系统指令地位。敏感内容通过 visibility 和 capability policy 过滤，模型只能查询被授权的 refs。

## 质量门

RLM 查询必须记录调用原因、预算、返回 refs、截断情况和结果 hash。这样可以回答：为什么读了这段内容、读了多少、是否重复读取、是否产生了有效决策。
