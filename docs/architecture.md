# Architecture Overview

状态：大规模技术架构草案。本文和 `docs/architecture/` 下的文档描述目标边界与不变量，不代表已经实现的 API。

## 一句话模型

Nausicaa 是一个由 **Ledger 驱动的异构多 lane graph runtime**：主线推进工作，辅助线以不同的节奏、权限和上下文视图挂接在节点或决策边上；所有 lane 通过可恢复的事实和结构化 A2A 消息协作。

```text
                    surfaces
              UI / API / CLI / daemon
                         |
                  control protocol
                         |
       +-----------------+------------------+
       |            runtime kernel          |
       | command admission / policy        |
       | scheduler / projections / inbox   |
       | RLM context views / replay        |
       +-----------------+------------------+
                         |
       +-----------------+------------------+
       | Ledger (facts) | Store (artifacts) |
       +-----------------+------------------+
             |              |             |
          main lane    Teto / Explorer   worker lanes
             \       typed graph edges      /
                  A2A + capability boundary
                         |
                 adapters and plugins
             pi-ai / models / tools / sandbox
```

## 核心原则

- Ledger 是跨进程、跨 lane 的唯一事实源；Prompt、Agent 对象和缓存只是投影。
- 图的核心关系是异构的：`depends-on`、`observes`、`advises`、`delegates`、`joins` 拥有不同的阻塞、权限和生命周期语义。
- lane 不共享可变内存或完整 Prompt，只共享事件、产物引用和 A2A 消息。
- 主线永远拥有优先级；辅助线默认只读、限额、可暂停、可丢弃。
- 大对象外置，模型按需查询；稳定前缀固定，动态内容增量化。
- 外部副作用必须可识别、可查询、可恢复，不能依赖“应该只执行一次”的假设。
- UI 是管理面，不是内核；模型 provider 是适配器，不是产品架构。

## 文档地图

1. [`architecture/00-system-boundaries.md`](architecture/00-system-boundaries.md)：对象、边界、进程和依赖方向。
2. [`architecture/01-ledger-runtime.md`](architecture/01-ledger-runtime.md)：事件、Store、Projection、命令和事实源。
3. [`architecture/02-lanes-scheduling.md`](architecture/02-lanes-scheduling.md)：主线、辅助线、预算和唤醒策略。
4. [`architecture/03-rlm-context.md`](architecture/03-rlm-context.md)：RLM、context view、按需查询和缓存。
5. [`architecture/04-a2a-protocol.md`](architecture/04-a2a-protocol.md)：消息、Advice、Inbox 和交接语义。
6. [`architecture/05-plugins-execution.md`](architecture/05-plugins-execution.md)：能力、插件、工具和执行边界。
7. [`architecture/06-replay-recovery.md`](architecture/06-replay-recovery.md)：checkpoint、replay 和副作用恢复。
8. [`architecture/07-performance-cache.md`](architecture/07-performance-cache.md)：token、延迟、缓存和资源公平。
9. [`architecture/08-observability-evals.md`](architecture/08-observability-evals.md)：可观测性、对照实验和验收指标。
10. [`architecture/09-roadmap.md`](architecture/09-roadmap.md)：从协议实验到产品 runtime 的阶段门。

## 当前不做的事情

不先建立通用 Agent graph、复杂自治规划器、插件市场、向量数据库、远程 daemon 或 UI 框架。只有当最小协议的实验结果证明需要它们，才把它们加入外层。

## 仍需实验决定的事项

事件存储介质、模型分层、Teto/Explorer 触发阈值、插件隔离方式、`pi-agent-core` 是否作为可选 worker、UI 与 runtime 的控制协议，以及跨机器 A2A transport 都属于可替换决策。
