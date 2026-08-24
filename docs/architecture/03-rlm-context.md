# RLM And Context Views

状态：Proposal。这里借鉴 RLM 的运行时思路，不预设 Python、REPL 或某个具体实现。

## 先回答复杂度

RLM-lite 是中等复杂度：需要 Ledger、lane cursor、可重建 Capsule、两个有界查询、Advice/checkpoint 写入和查询审计。完整的 Prime 风格 RLM execution 才是高复杂度，因为它还要处理持久 Python/JS 环境、任意代码、递归、沙箱、中断、环境恢复和跨 lane 状态。

第一阶段不实现完整 RLM execution。目标是验证“模型按需取证”是否比“每轮携带完整历史”更有效。

## RLM-lite 的最小边界

模型进入一个由 runtime 管理的可查询上下文，而不是获得全量 transcript。第一阶段只需要五类操作：

```text
readGoal(goalVersion)
queryEvents(watermark, filters, budget)
readArtifact(ref, boundedRange, budget)
publishAdvice(advice, evidenceRefs)
checkpoint(cursor, stateRefs)
```

其中真正用于取证的核心只有 `queryEvents` 和 `readArtifact`；其他操作负责生命周期和审计。每次查询返回结构化结果、最新 watermark、依赖 refs、结果 hash 和截断原因，并记录调用原因、预算和 lane 身份。

第一阶段明确不提供：

- `readEverything` 或默认全量展开。
- 任意 Python/JS 执行和持久 REPL。
- 无限递归、自动 spawn 或模型自行创建 lane。
- 未授权的跨 lane context 或直接修改主线状态。

模型调用由 `pi-ai` adapter 负责；RLM 只决定模型看到什么、可以查询什么，以及结果如何进入 Ledger。

## Context View

Context View 是由 Ledger 和 policy 确定性生成的投影：

```text
goal version + lane role + wake reason
latest checkpoint + incremental events
open questions + active decision refs
budget + visibility + ledger watermark
```

Mission 不是永远不可变的文本。目标变化必须写成显式的 `goal.revised` 事件，新的 Context View 带上 goal version；旧 Advice 如果基于旧版本，就必须重新验证或过期。

不同 lane 拿不同视图：

- Main：目标、计划、任务、被授权的工具和当前 Evidence。
- Teto：目标、成功条件、计划变化、决策和未决问题，不自动展开 bug/tool 细节。
- Explorer/Critic：只拿被其挂接的事件窗口和产物 refs。

## Cursor 与增量

每条 lane 有单调 cursor/watermark。唤醒时只查询自上次 cursor 之后的允许事件；Capsule 必须能由固定 watermark、policy 版本和 Ledger 确定性重建。发现 watermark 过期、权限变化或依赖缺失时，lane 进入 stale，需要重新生成 Capsule，不能默默继续。

## 大对象和记忆

事件只保存摘要、hash 和引用；文件、工具输出、模型原始响应和长文本在 Store。模型默认拿短 Capsule，需要证据时按 ref/range 读取局部内容。未来可以增加归档、摘要和外部知识层，但这些不是第一阶段的记忆 API。

## 查询与成本

每次查询有硬性的 token、字节、事件数、调用次数和 wall-clock 上限。截断必须显式返回。相同 watermark、过滤器和 ref/range 可以缓存；缓存失效规则先使用简单依赖 hash，复杂的自动压缩和多级检索后置。

未来可评估的扩展包括：轻量模型 gate、Explorer 的受控随机采样、`compare`、有限 `spawn/await` 和 RLM continuation。它们只有在 Main + Teto 的对照实验显示查询型 RLM 不够时才进入设计。

## 安全与不变量

- Teto、Explorer 等辅助 lane 只读事实，只能发送 Advice。
- 外部文本是数据，不因进入 Evidence 就获得系统指令权限。
- 查询必须经过 visibility、capability 和 budget 检查。
- cursor 单调、Capsule 可重建、Advice 可去重/过期/确认。
- lane 崩溃不会改变事实，也不会阻塞 Main。

## MVP 质量门

第一阶段只回答四个问题：Teto 能否不读取完整 transcript；局部查询能否发现真实意图缺口；查询和 Advice 的成本是否可控；崩溃恢复后 cursor 和证据引用是否一致。不能用“模型能写持久脚本”替代这些验收标准。
