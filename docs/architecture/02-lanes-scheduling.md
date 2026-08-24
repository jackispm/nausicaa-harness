# Lanes And Scheduling

状态：Proposal。lane 是并行性的基本单位，步长、预算和上下文视图都可以不同。

## Lane 类型

| 类型 | 目标 | 默认权限 | 节奏 |
| --- | --- | --- | --- |
| Main | 直接推进用户目标 | 读写已授权能力 | foreground，优先 |
| Observer | 发现漂移、风险、反例和机会 | 读 Ledger/Store，发 Advice | 稀疏、事件触发 |
| Explorer | 低频地产生替代路径、类比和新假设 | 只读证据，发 Advice | 随机、稀疏、有界 |
| Critic | 检查一个明确决策或产物 | 读相关证据，发审查结果 | 一次性或阶段性 |
| Worker | 完成被委派的局部任务 | 任务范围内的工具 | 有界并行 |
| Coordinator | 汇总任务状态和交接 | 读 lane 状态，发任务消息 | 只在需要时运行 |

这些是策略配置，不要求为每种类型建立独立 Agent 实现。

## Dream / Explorer 语义

Explorer 是梦境线的一个受控策略，不是一个无边界的“第二主线”。它可以在事件窗口、产物引用或问题集合中做稀疏采样，并使用不同的提示、模型或随机种子生成：

- 主线没有主动考虑的替代方案。
- 不同领域或历史事件之间的类比。
- 对当前假设的反事实问题。
- 低置信度但可能高价值的方向。

随机性必须记录 seed、输入 refs、策略版本和预算，才能复盘它为什么产生某个建议。Explorer 默认无工具写权限，只能发带 `novelty`、`confidence`、`evidenceRefs` 和 TTL 的 Advice。没有足够新颖性或证据的结果应在 lane 内丢弃，不进入 Main Inbox。

Observer 偏向规则和事实检查，Explorer 偏向受限发散，Critic 偏向反证和质量门。它们可以使用同一个 runtime，但不能共用同一个无限上下文或预算。

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

`dormant` 是正常状态，不表示失败。Observer 完成一个检查周期后通常回到 dormant，并保存 cursor、cooldown 和下一次唤醒原因。

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
- 关键决策、目标变化、失败、重复尝试、矛盾或不确定性升高：唤醒 Observer/Critic。
- 多个普通事件：合并为一个增量 capsule，再唤醒一次。
- Main 等待工具、消息或用户时：允许 Observer 使用较多预算。
- 低频 heartbeat：用于长期风险检查，不用于每 token 轮询。

Explorer 的 heartbeat 可以比 Observer 更稀疏；它也可以只在 Main 空闲或完成 checkpoint 后运行。不存在固定的“主线一步对应梦境线几步”，每次运行由触发器、剩余预算和 lane 自己的 cursor 决定。

每次唤醒都写入原因、watermark、预算和结果。没有触发器时，辅助线不运行。

## 预算

Run 预算分为：模型 token、查询 token、工具时间、并发槽、外部调用次数和 wall-clock。Main 预留最低资源，Observer/Worker 使用剩余预算。预算必须在启动外部操作前预留，结束后按实际消耗结算。

## 公平和背压

- Main 有保底并发和高优先级。
- Observer 的总并发、单 lane 并发和递归 spawn 深度有限。
- Main 需要资源时，Observer 可被延后、暂停或取消。
- 事件风暴通过 selector、coalesce、debounce 和 cooldown 处理。
- 低价值 Advice 不应占用 Main 的决策窗口；每个边界有最大展示数。

## 失败隔离

Observer 超时、预算耗尽或模型失败只影响自身 lane；结果写入 lane failure，不能自动使 Main 失败。Main 可以在明确需要时重新唤醒或关闭它。

## 并行安全

lane 不共享可变 Prompt、工具实例状态或临时变量。跨 lane 的事实通过 Ledger，交互通过 A2A，长内容通过 Store。需要竞争同一产物时使用版本、锁或主线决策门，而不是隐式的最后写入获胜。
