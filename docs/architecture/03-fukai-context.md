# Fukai Context Runtime

状态：Proposal。Fukai（腐海）是 Nausicaa 对 RLM 思想的内部命名：庞杂、混杂的运行历史留在外部事实层，Fukai 只把当前 lane 真正需要的证据带入上下文。

## 边界

Ledger 和 Store 保存事实与大对象；Fukai 位于它们与模型 lane 之间，负责选择、过滤、授权、限额和审计。Main、Teto、Explorer、Critic 都不能绕过 Fukai 直接读取 Ledger、Store、主线 transcript 或完整索引。

```text
Ledger + Store
      |
    Fukai
  policy / cursor / bounded query / Context View
      |
 model lane
```

Fukai Core 是中等复杂度；完整的 RLM execution 才是高复杂度，因为还涉及持久 Python/JS、任意代码、递归、沙箱、中断和环境恢复。第一阶段只验证“按需取证”是否优于携带完整历史。

## 最小能力

```text
readGoal(goalVersion)
queryEvents(cursor, upperWatermark, filters, budget)
readArtifact(ref, boundedRange, budget)
publishAdvice(advice, evidenceRefs)
checkpoint(cursor, stateRefs)
```

真正用于取证的核心只有 `queryEvents` 和 `readArtifact`。Phase 1 的 `queryEvents` 至少支持 `eventRef`、`type`、`laneId`、`causationId`、`correlationId` 和 cursor 范围过滤，并绑定一个固定的 `upperWatermark`。结果按稳定顺序分页，返回 `nextCursor`、证据 refs、结果 hash 和 `truncated`、`denied`、`not-found` 等明确状态；同一查询还要记录调用理由、预算和 lane 身份。

Fukai Core 不提供：

- `readEverything` 或默认全量展开。
- 完整 transcript、全量文件表或事件索引的自动注入。
- 任意 Python/JS 执行和持久 REPL。
- 无限递归、自动 spawn 或模型自行扩大权限。

模型调用仍由 `pi-ai` adapter 完成；Fukai 只决定模型看到什么、可以继续查询什么，以及查询如何被审计。

## 能力完整，视野最小

lane 可以拥有相同的 Fukai Core 操作集，但初始 Context View、可见范围和预算不同。能力完整不等于数据无限，更不等于预先加载更多信息。

Teto 的 Wake Capsule 只有：

```text
goalRef + successCriteria
trigger.kind + opaqueTriggerRef
cursor + upperWatermark + budget + policyVersion
```

它不包含最近事件列表、主线消息、工具日志、文件列表或 changedRefs 清单。非模型 selector 负责根据事件元数据唤醒 Teto；`opaqueTriggerRef` 只用于向 Fukai 定位起点，不是事件摘要。Teto 再提出具体查询，Fukai 才返回与航向、意图缺口或方法选择相关的局部 Evidence。

Teto 可以在本轮预算内多次调用 `readGoal`、`queryEvents` 和 `readArtifact`，沿返回的 evidence refs 逐步取证；它不是只能阅读预生成摘要的降级 Agent。runtime 可以维护索引来执行查询，但索引属于 Fukai 内部实现，不作为 Prompt、目录清单或“最近发生的一切”暴露给任何 lane。查询只返回匹配结果、continuation 和明确的截断信息。

一次唤醒使用固定的 `upperWatermark`，后续分页和 Artifact 读取不得悄悄扩大窗口；需要观察更新时必须由新的触发重新唤醒。这样一次 Teto 检查可以链式取证直到预算耗尽，同时仍可重放、去重和审计。

Main 也通过 Fukai 组装上下文，只是拥有更宽的当前任务视图和被授权的工具结果。未来的 Explorer/Critic 只读取其挂接事件或产物允许的范围。

## Goal 与 stale

Goal 变化必须写成 `goal.revised`，Context View 携带 goal version。旧 Advice、旧查询和旧 Capsule 如果基于不同版本，就必须重新验证或过期。Mission 不是一段可以被静默覆盖的长期 Prompt。

每条 lane 有单调 cursor/watermark。固定 Ledger watermark、policy version 和可见范围必须生成可重建的 Context View；发现 cursor 过期、权限变化或依赖缺失时进入 stale，不能默默继续。

## 查询成本

每次查询有 token、字节、事件数、调用次数和 wall-clock 硬上限。截断必须显式返回。相同 watermark、过滤器和 ref/range 可以按 hash 缓存，但第一阶段不做向量记忆、多级检索或自动摘要体系。

未来可以评估轻量 gate、Explorer 的受控采样、有限 `spawn/await` 和 Fukai Execution。它们只有在 Main+Teto 对照实验显示 Fukai Core 不足时才进入设计。

## 不变量

- 所有模型 lane 只能经 Fukai 读取事实。
- 辅助 lane 只读事实，只能通过 A2A 写 Advice 或任务结果。
- 外部文本是数据，不因进入 Evidence 获得系统指令权限。
- cursor 单调，Context View 可重建，查询有界且可审计。
- lane 崩溃不会改变事实，也不会阻塞 Main。

## MVP 质量门

第一阶段只回答：Teto 能否在没有 transcript 和事件索引的情况下提出正确查询；局部 Evidence 能否发现真实意图缺口；成本是否可控；恢复后 cursor 和 refs 是否一致。不能用“模型能运行持久脚本”替代这些标准。
