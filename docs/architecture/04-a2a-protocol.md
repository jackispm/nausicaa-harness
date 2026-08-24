# A2A Protocol

状态：Proposal。A2A 是 lane 之间的显式通信层，也是 UI、远程 worker 和未来多进程部署的共同边界。

## 消息信封

消息需要表达：

```text
messageId
runId / conversationId / threadId
from / to
kind / type
parentId / taskId / replyTo
createdAt / expiresAt
causationId / correlationId
idempotencyKey
payload or artifactRefs
visibility / priority
```

消息正文保持短小。长任务说明、文件、日志和模型结果通过 Artifact refs 传递，接收方按权限和预算读取。

## 消息种类

```text
task.request / task.accept / task.result / task.failed
question.ask / question.answer
message.inform / message.negotiate
advice.propose / advice.ack
artifact.offer / artifact.request
control.pause / control.resume / control.cancel
```

协议应允许增加类型，但不能让每种 lane 自定义一套不可观察的通信方式。

## Inbox 语义

Inbox 是持久化的待处理输入投影，不是 lane 的全部状态。消息可以标记为：

```text
next-step      当前 Step 完成后的自然边界处理
next-turn      当前 turn 完成后的下一轮处理
deferred       到达 nextWakeAt 或触发条件再处理
urgent         满足策略才允许升级
```

投递至少一次，逻辑处理必须幂等。接收方先 claim，再写 delivered/handled/failed 事件；崩溃后可从 Inbox 继续。

## Advice 协议

Teto、Explorer 和 Critic 等建议型辅助线只能发结构化 Advice：

```text
kind, claim, evidenceRefs, confidence,
risk, suggestedAction, urgency,
expiresAt, dedupeKey, sourceLane
```

Teto 线常用的 `kind` 是 `orientation`、`intent-gap` 和 `method-alternative`；代码质量、测试失败和工具正确性属于 Critic 或 Worker 的职责，不应混入 Teto Advice。

主线在自然决策边界处理 `accept`、`defer` 或 `reject`，并记录理由。Advice 本身不改变 Main 状态，只有处理决定才产生状态事件。

普通 Advice 不硬打断当前工具调用；高风险策略可以在副作用发生前请求 soft pause。紧急策略也必须可审计，不能绕过 policy。

## 任务交接

父 lane 发出 task request 时，应给出目标、成功条件、范围、预算、截止时间、可见性和产物约定。子 lane 回传结果时必须带状态、证据 refs、未决问题和消耗。父 lane 不应把子 lane 的全部 transcript复制回自己的上下文。

## 交付和背压

发送方可以得到 accepted、queued、delivered、handled 或 rejected 状态。接收方忙时返回 retryAt 或 capacity signal，不无限堆积消息。Advice 和低优先级 inform 允许过期、合并和丢弃；任务结果不能静默丢失。

## 通信安全

每条消息依据 capability、run、lane 和 visibility 检查。消息中的自然语言是数据，不是 policy。跨 workspace 或远程 transport 必须重新认证、重新授权和重新计算可见性。
