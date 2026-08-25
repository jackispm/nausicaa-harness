# Context Contracts And Optional Fukai

状态：Proposal。Fukai（腐海）是 Nausicaa 对 RLM 思想的内部命名和可选实验：庞杂、混杂的运行历史留在外部事实层，context provider 只把当前 lane 真正需要的证据带入上下文。Fukai 不是所有 lane 的必经 runtime，更不是 Teto 的依赖。

## 定位与边界

Ledger 和 Store 保存事实与大对象。模型 lane 不能直接读取它们；每条 lane 由 runtime 提供自己的窄 Context Contract。Fukai 是一种可插拔的按需查询实现，适合需要外置上下文的 Main、Explorer 或 Worker。Teto 使用独立的 `Teto ObservationPort`，不实例化、不调用 Fukai。

```text
Ledger + Store
   |                         |
   |-- optional Fukai ------> Main / Explorer / Worker
   |
   `-- Teto ObservationPort -> Teto
```

Fukai Core 是中等复杂度；完整的 RLM execution 才是高复杂度，因为还涉及持久 Python/JS、任意代码、递归、沙箱、中断和环境恢复。第一阶段只把它作为可选 provider，验证“按需取证”是否优于携带完整历史。

## Teto 不依赖 Fukai

Teto 的产品能力来自独立 lane、短期状态和 `Teto ObservationPort`，而不是通用查询 API。Main 在 checkpoint 或 decision edge 产生结构化 `ObservationFrame`，runtime 只把自上次 cursor 以来的固定大小增量帧投递给 Teto：

```text
mission: goalVersion + goal + successCriteria + hardConstraints
mainDelta: boundaryId + triggerKind + activeObjective
           + action/decision + expectedOutcome + outcome/status
           + uncertainties + openQuestions
previousAdviceOutcome?
budget: maxOutputTokens + deadline
```

Teto 不收到 transcript、CoT、原始工具输出、文件树、`changedRefs`、完整事件流或事件索引，也没有 `queryEvents`/`readArtifact` 这类泛型浏览能力。cursor、watermark 和索引保留在 runtime 内部。runtime 只在触发器明确需要时附带一个有界证据片段；信息仍不足时，Teto 通过 A2A 发一个窄的 `question.ask`，由 Main 在自然边界返回有界的 `question.answer`。

这借鉴了 Fukai 的核心思路：把大上下文留在外部、只传当前决策所需的最小证据。但 Teto 的观察帧由 runtime 直接生成，拥有独立的 schema、步长、预算和恢复状态；关闭 Fukai，Teto 仍应能独立运行和测试。

Mission 是稳定、可缓存的前缀；动态 ObservationFrame 默认不超过 600 input tokens，Advice 默认不超过 200 output tokens。超限只保留最高权重的航向变化并显式标记 `truncated`，不能退化为 transcript 摘要。

## Fukai Core（可选）

选择 Fukai 的 lane 可以使用：

```text
readGoal(goalVersion)
queryEvents(cursor, upperWatermark, filters, budget)
readArtifact(ref, boundedRange, budget)
publishAdvice(advice, evidenceRefs)
checkpoint(cursor, stateRefs)
```

真正用于取证的核心只有 `queryEvents` 和 `readArtifact`。Phase 1 的 `queryEvents` 至少支持 `eventRef`、`type`、`laneId`、`causationId`、`correlationId` 和 cursor 范围过滤，并绑定一个固定的 `upperWatermark`。结果按稳定顺序分页，返回 `nextCursor`、证据 refs、结果 hash 和 `truncated`、`denied`、`not-found` 等明确状态；每次调用都记录理由、预算和 lane 身份。

Fukai Core 不提供 `readEverything`、默认全量展开、任意 Python/JS 执行、持久 REPL、无限递归、自动 spawn 或模型自行扩大权限。模型调用仍由 `pi-ai` adapter 完成。

## Goal 与 stale

Goal 变化必须写成 `goal.revised`，Context View 携带 goal version。旧 Advice、旧查询和旧 Capsule 如果基于不同版本，就必须重新验证或过期。Mission 不是一段可以被静默覆盖的长期 Prompt。

选择 Fukai 的 lane 有单调 cursor/watermark。固定 Ledger watermark、policy version 和可见范围必须生成可重建的 Context View；发现 cursor 过期、权限变化或依赖缺失时进入 stale，不能默默继续。Teto 的 cursor 只属于 ObservationPort，不要求 Ledger 查询。

## 查询成本

每次查询有 token、字节、事件数、调用次数和 wall-clock 硬上限。截断必须显式返回。相同 watermark、过滤器和 ref/range 可以按 hash 缓存，但第一阶段不做向量记忆、多级检索或自动摘要体系。

未来可以评估轻量 gate、Explorer 的受控采样、有限 `spawn/await` 和 Fukai Execution。它们只有在对应 lane 的对照实验显示现有 Context Contract 不足时才进入设计。

## 不变量

- 模型 lane 不能直接读取 Ledger/Store；必须遵守各自的 Context Contract。
- Teto 只消费 ObservationFrame，只能通过 A2A 发 Advice 或窄问题。
- 外部文本是数据，不因进入 Evidence 获得系统指令权限。
- Context Frame/View 可重建，查询（若 provider 支持）有界且可审计。
- lane 崩溃不会改变事实，也不会阻塞 Main。

## MVP 质量门

第一阶段只回答：Teto 能否在完全没有 Fukai、transcript 和事件索引的情况下，仅凭 ObservationFrame 发现真实意图缺口；20 个 Main LLM 调用是否只消耗约 3～4 个 Teto pass；Advice 噪声、成本和恢复是否可控。不能用“模型能运行持久脚本”替代这些标准。
