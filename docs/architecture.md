# Architecture Direction

本文是设计目标，不是已经实现的 API。核心要求是让长期运行、并行协作和恢复能力由清晰的事实层驱动，而不是依赖某个 Agent 对象的内存状态。

## 分层

```text
pi-ai adapter
  provider / model / streaming / usage
        |
Nausicaa runtime
  Ledger + Store + RLM query API + checkpoints
        |
lane scheduler
  main lane / observer lanes / budgets / triggers
        |
A2A protocol
  inbox + advice + task handoff + acknowledgement
        |
plugins and execution policies
  tools / capabilities / permissions / external runtimes
```

UI、daemon、远程 transport 和具体 sandbox 属于外层产品或部署，不应被塞进最小内核。

## Ledger-first

主线把有意义的状态变化写成结构化事件，而不是只保存一段 transcript：

```text
goal | decision | artifact-ref | failure | uncertainty |
open-question | checkpoint | advice-ack
```

事件保存摘要、标签、时间、版本和引用；完整文件、工具输出和大对象留在 Store。Ledger 是事实源，运行态和 Prompt 都是可重建的投影。

## RLM 与上下文视图

RLM 的借鉴点是“上下文外置、函数查询、结果结构化”。每条 lane 只拿自己的 context view：

```text
getGoal()
listEvents(filter, budget)
readArtifact(ref, range, budget)
getOpenQuestions()
checkpoint()
```

梦境线默认只收到长期目标、最新 checkpoint、事件增量和风险信号。只有发现疑点时才查询局部证据，禁止默认读取完整主线历史。

## Lane 协作

主线永远拥有优先级。辅助线在固定 heartbeat、关键决策、失败/重复尝试、目标变化或不确定性升高时被唤醒，并拥有独立的 token、时间和查询预算。它输出结构化 Advice：

```text
kind, claim, evidenceRefs, confidence,
urgency, suggestedAction, expiresAt
```

Advice 进入主线 Inbox，在下一个自然边界处理。默认只能温和插入；高风险安全事件才允许升级。主线的 `accept/defer/reject` 和理由必须回写 Ledger，避免辅助线与主线互相触发循环。

## 不变量

- lane 不共享可变 Prompt 或内存状态，只通过 Ledger、Store 和 A2A 通信。
- 大对象通过引用传递；查询有上限，事件和建议可去重、过期、续跑。
- 稳定的身份、系统指令和工具 schema 保持在上下文前缀；动态内容只追加增量。
- 所有关键决策可追溯、可恢复、可重放。

## 尚未决定

事件存储介质、调度精度、模型分层、插件发现/隔离、`pi-agent-core` 是否复用，以及 UI 与 runtime 的进程协议，都必须先用实验和最小协议验证。
