# Lanes And Scheduling

状态：Proposal。lane 是并行性的基本单位，步长、预算和上下文视图都可以不同。

## Lane 类型

| 类型 | 目标 | 默认权限 | 节奏 |
| --- | --- | --- | --- |
| Main | 直接推进用户目标 | 读写已授权能力 | foreground，优先 |
| Teto / IntentNavigator | 发现任务脱离、意图缺口和更好方法 | Teto Observation Context，发 Advice | 稀疏、事件触发 |
| Explorer | 低频地产生替代路径、类比和新假设 | 自己的受限上下文，发 Advice | 随机、稀疏、有界 |
| Critic | 检查一个明确决策或产物的质量/风险 | 自己的挂接证据视图 | 一次性或阶段性 |
| Worker | 完成被委派的局部任务 | 任务范围内的工具 | 有界并行 |
| Coordinator | 汇总任务状态和交接 | 读 lane 状态，发任务消息 | 只在需要时运行 |

这些是策略配置，不要求为每种类型建立独立 Agent 实现。

## 最小拓扑

第一阶段只验证两种 lane 和三种关系：

```text
Run
 └─ Main spine
     ├─ checkpoint / decision edge
     │       └─ observes -> Teto sidecar
     │                       └─ advises -> next Main boundary
     └─ task work
```

Teto 是挂在 Main 上的伴随线，不是 Main 的下游依赖。它可以延后、失败或被取消，Main 仍能继续；Main 只有在自然决策边界主动消费 Advice。Worker、Explorer、Critic 和 `delegates/joins` 边必须等最小拓扑验证后再加入。

## Explorer 语义

Explorer 是一种受控的发散策略；“梦境线”只是它未来可能采用的产品化称呼，不是架构原语。它不是无边界的“第二主线”，而是在事件窗口、产物引用或问题集合中做稀疏采样，并使用不同的提示、模型或随机种子生成：

- 主线没有主动考虑的替代方案。
- 不同领域或历史事件之间的类比。
- 对当前假设的反事实问题。
- 低置信度但可能高价值的方向。

随机性必须记录 seed、输入 refs、策略版本和预算，才能复盘它为什么产生某个建议。Explorer 默认无工具写权限，只能发带 `novelty`、`confidence`、`evidenceRefs` 和 TTL 的 Advice。没有足够新颖性或证据的结果应在 lane 内丢弃，不进入 Main Inbox。

Teto 偏向任务航向和意图完整性，Explorer 偏向受限发散，Critic 偏向反证和质量门，Worker 偏向实际执行。Teto 不负责检查 bug；需要代码或产物质量审查时，必须显式挂接 Critic lane。它们可以使用同一个 runtime，但不能共用同一个无限上下文或预算。

## Teto lane: IntentNavigator

Teto 线是 Nausicaa 的第一条标准辅助线。非模型 selector 只根据事件类型和边关系决定是否唤醒它；Teto 本身不订阅或扫描 Main 的完整事件流。它重点回答三件事：

1. 当前行动是否仍然服务于原始任务意图？
2. 用户目标或成功条件是否缺失、含糊或互相冲突？
3. 当前路径之外是否有更简单、更稳妥或更有价值的方法？

Teto 不依赖 Fukai。Main 在原有模型调用中顺手产生可选的结构化 `navigationDelta`；runtime 再结合已知的工具状态、目标变化和 Advice 结果维护一个轻量 Navigation Projection，不额外调用模型做摘要。多个 step 只合并成“当前航向 + 关键变化 + 未决问题”，不会逐条复制。Teto 每次启动只收到一个固定大小的 `ObservationFrame`：

```text
mission: goalVersion + goal + successCriteria + hardConstraints
mainDelta: boundaryId + activeObjective + actionOrDecision
           + expectedOutcome + outcome/status
           + uncertainties + openQuestions
previousAdviceOutcome?
budget: maxOutputTokens + deadline
```

这些是 Main 的结构化航向状态，不是 transcript 摘要。内部 cursor、watermark 和事件索引由 runtime 保存，不进入 Teto Prompt。Teto 不获得聊天原文、CoT、文件列表、工具日志或“最近所有变化”的索引。runtime 只有在触发器明确需要时，才附带一个很小的证据片段；否则 Teto 通过 A2A 发窄问题给 Main。这个机制借鉴 Fukai 的按需取证思想，但实现和生命周期独立于 Fukai。

Mission 是稳定、可缓存的前缀；动态 ObservationFrame 默认不超过 600 input tokens，Teto Advice 默认不超过 200 output tokens。超限时丢弃低权重变化并标记 `truncated`，不能自动展开主线历史。

Teto 自己只保留固定大小的短状态：当前 goal version、最多 5 个未决航向问题、最近 3 条 Advice 的处理结果和上次唤醒边界。它不把 ObservationFrame 累积成第二份主线历史。

它不主动修改文件，不执行代码，不承担 bug 检查，也不直接暂停 Main。它只发 `orientation`、`intent-gap` 或 `method-alternative` Advice，并附证据引用、置信度、建议时机和过期时间。

## 生命周期

```text
planned -> dormant -> ready -> running
                         ^       |
                         |       v
                       waiting <-+
                         |
             paused / draining / completed
                         |
                 failed / cancelled
```

`dormant` 是正常状态，不表示失败。Teto 或其他辅助线完成一个检查周期后通常回到 dormant，并保存 cursor、cooldown 和下一次唤醒原因。

## Step 语义

Step 不是“调用一次模型”这么简单，而是一个可追踪的决策边界：

```text
scheduled -> admitted -> context-built -> model-running
          -> tool-running (optional) -> result-committed -> boundary
```

一个模型响应可能触发多个并行工具调用；一个工具失败也可能只结束当前 Step，而不结束 Run。所有转换由命令和事件产生。

## 唤醒策略

Teto 不跟随 Main 每一步运行。使用“观察窗口 + 事件权重 + 预算”调度：

- 用户输入、恢复、主线继续：立即唤醒 Main。
- 关键决策或计划改变：提高 Teto wake score；目标变化、重复失败或明显矛盾作为 hard trigger。
- 多个普通事件：只更新 Navigation Projection；达到阈值后生成一个 ObservationFrame，不传事件列表、changedRefs 或索引。
- Main 等待工具、消息或用户时：允许辅助线使用较多预算。
- 低频 heartbeat：用于长期航向检查，不用于每 token 轮询。

Explorer 的 heartbeat 可以比 Teto 更稀疏；它也可以只在 Main 空闲或完成 checkpoint 后运行。Teto 的具体步长由下面的 cadence policy 决定，而不是固定绑定某个模型或工具。

每次唤醒都写入原因、watermark、预算和结果。没有触发器时，辅助线不运行。

## Teto cadence policy

一次 Teto wake 只执行一个 observation pass（一次 LLM 请求），不启动自己的长工具 loop。调度器可以观察每个 Main step，但观察和合并只是本地状态更新，不消耗模型调用。默认策略维护上次唤醒后的 Main LLM 调用数和 observation credit：

- 普通完成 step 存入 `1` credit。
- 关键决策或计划改变存入 `2` credits。
- 目标改变、重复失败或明显矛盾直接把 credit 提升到 `5`，成为 hard trigger。
- credit 累计到 `5`，或连续 `7` 个 Main LLM 调用未检查时，合并成一个 ObservationFrame 并唤醒 Teto；唤醒后 credit 归零。
- 两次 Teto pass 默认至少间隔 `4` 个 Main LLM 调用。
- 滚动 20 个 Main LLM 调用最多允许 `4` 个 Teto pass；硬触发可以提前占用下一个额度，但不扩大滚动上限。

默认目标是 Teto 调用数约为 Main 的 `15%`～`20%`，Teto token 不超过 Run 模型 token 的 `10%`。因此 20 个普通 Main LLM 调用通常产生 3～4 个 Teto pass。若 Teto 需要更多信息，它发 A2A 问题并等待下一次合资格窗口，不在同一窗口连续调用模型。

这些数字是首个可测量的 policy 默认值，不是写死在 graph kernel 的语义；只有对照实验能证明更好的质量/成本比时才调整。

## 预算

Run 预算分为：模型 token、查询 token、工具时间、并发槽、外部调用次数和 wall-clock。Main 预留最低资源，Teto/Explorer/Worker 使用剩余预算。预算必须在启动外部操作前预留，结束后按实际消耗结算。

## 公平和背压

- Main 有保底并发和高优先级。
- 辅助线的总并发、单 lane 并发和递归 spawn 深度有限。
- Main 需要资源时，辅助线可被延后、暂停或取消。
- 事件风暴通过 selector、coalesce、debounce 和 cooldown 处理。
- 低价值 Advice 不应占用 Main 的决策窗口；每个边界有最大展示数。

## 失败隔离

Teto、Explorer 或其他辅助线超时、预算耗尽或模型失败只影响自身 lane；结果写入 lane failure，不能自动使 Main 失败。Main 可以在明确需要时重新唤醒或关闭它。

## 并行安全

lane 不共享可变 Prompt、工具实例状态或临时变量。跨 lane 的事实通过 Ledger，交互通过 A2A，长内容通过 Store；每条 lane 只能通过自己的 context provider 读取被授权内容。需要竞争同一产物时使用版本、锁或主线决策门，而不是隐式的最后写入获胜。
