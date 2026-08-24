# Lanes And Scheduling

状态：Proposal。lane 是并行性的基本单位，步长、预算和上下文视图都可以不同。

## Lane 类型

| 类型 | 目标 | 默认权限 | 节奏 |
| --- | --- | --- | --- |
| Main | 直接推进用户目标 | 读写已授权能力 | foreground，优先 |
| Teto / IntentNavigator | 发现任务脱离、意图缺口和更好方法 | 读 Ledger/Store，发 Advice | 稀疏、事件触发 |
| Explorer | 低频地产生替代路径、类比和新假设 | 只读证据，发 Advice | 随机、稀疏、有界 |
| Critic | 检查一个明确决策或产物的质量/风险 | 读相关证据，发审查结果 | 一次性或阶段性 |
| Worker | 完成被委派的局部任务 | 任务范围内的工具 | 有界并行 |
| Coordinator | 汇总任务状态和交接 | 读 lane 状态，发任务消息 | 只在需要时运行 |

这些是策略配置，不要求为每种类型建立独立 Agent 实现。

## Explorer 语义

Explorer 是梦境线的一个受控策略，不是一个无边界的“第二主线”。它可以在事件窗口、产物引用或问题集合中做稀疏采样，并使用不同的提示、模型或随机种子生成：

- 主线没有主动考虑的替代方案。
- 不同领域或历史事件之间的类比。
- 对当前假设的反事实问题。
- 低置信度但可能高价值的方向。

随机性必须记录 seed、输入 refs、策略版本和预算，才能复盘它为什么产生某个建议。Explorer 默认无工具写权限，只能发带 `novelty`、`confidence`、`evidenceRefs` 和 TTL 的 Advice。没有足够新颖性或证据的结果应在 lane 内丢弃，不进入 Main Inbox。

Teto 偏向任务航向和意图完整性，Explorer 偏向受限发散，Critic 偏向反证和质量门，Worker 偏向实际执行。Teto 不负责检查 bug；需要代码或产物质量审查时，必须显式挂接 Critic lane。它们可以使用同一个 runtime，但不能共用同一个无限上下文或预算。

## Teto lane: IntentNavigator

Teto 线是 Nausicaa 的第一条标准辅助线。它订阅 Main 的目标、约束、计划变化、决策、未决问题和产物引用，重点回答三件事：

1. 当前行动是否仍然服务于原始任务意图？
2. 用户目标或成功条件是否缺失、含糊或互相冲突？
3. 当前路径之外是否有更简单、更稳妥或更有价值的方法？

它不读取完整工具日志，不主动修改文件，不执行代码，不承担 bug 检查，也不直接暂停 Main。它只发 `orientation`、`intent-gap` 或 `method-alternative` Advice，并附证据引用、置信度、建议时机和过期时间。

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

不要规定“主线走 N 步，梦境线走 M 步”。使用事件和资源驱动：

- 用户输入、恢复、主线继续：立即唤醒 Main。
- 关键决策、目标变化、失败、重复尝试、矛盾或不确定性升高：唤醒 Teto、Explorer 或 Critic。
- 多个普通事件：合并为一个增量 capsule，再唤醒一次。
- Main 等待工具、消息或用户时：允许辅助线使用较多预算。
- 低频 heartbeat：用于长期航向检查，不用于每 token 轮询。

Explorer 的 heartbeat 可以比 Teto 更稀疏；它也可以只在 Main 空闲或完成 checkpoint 后运行。不存在固定的“主线一步对应辅助线几步”，每次运行由触发器、剩余预算和 lane 自己的 cursor 决定。

每次唤醒都写入原因、watermark、预算和结果。没有触发器时，辅助线不运行。

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

lane 不共享可变 Prompt、工具实例状态或临时变量。跨 lane 的事实通过 Ledger，交互通过 A2A，长内容通过 Store。需要竞争同一产物时使用版本、锁或主线决策门，而不是隐式的最后写入获胜。
