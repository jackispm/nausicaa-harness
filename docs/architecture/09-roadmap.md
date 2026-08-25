# Architecture Roadmap

状态：Proposal。每一阶段都有退出条件；没有通过退出条件，不进入下一层复杂度。

## Phase 0: vocabulary and invariants

确定 Run、Lane、Step、Event、Artifact、Message、Advice、Checkpoint、Capability 的语义和事件因果关系。准备固定事件样例，验证 projection、cursor 单调性、goal revision、权限过滤和 recorded replay。

**退出条件**：能够用文档解释一次成功、失败、暂停、恢复、Advice 采纳和重复副作用。

## Phase 1: protocol slice

单进程、单 writer、文件 Ledger、内容寻址 Store、一个 Main 和一个 Teto。配合 mock model 验证 `observes`/`advises` sidecar、最小 opaque wake capsule、Fukai Core 的受限查询、Advice ack 和 recorded replay；不做 Worker、Explorer、通用 graph DSL 或持久代码 runtime。

**退出条件**：崩溃可恢复，Teto 不读完整 transcript，不阻塞 Main，重复 Advice 可恢复，预算和去重有效；query/read/checkpoint 三类 Fukai Core 能力在恢复后保持 cursor 一致。

## Phase 2: real model adapter

接入 `pi-ai`，保留 runtime 对 provider 的隔离。加入稳定前缀、cache outcome、工具 operationId 和最小能力 policy。

**退出条件**：按评测文档预先冻结任务集、模型层级、预算和收益公式，完成 Main-only 与 Main+Teto 的 A/B，并报告 token、缓存、延迟、纠偏、意图缺失发现和 Advice 噪声；若净收益在预设样本和区间内归零或为负，不增加更多 lane，先简化机制。

## Phase 3: worker and A2A

加入有界 Worker lane、`delegates/joins` 边、任务交接、Inbox 的 next-step/next-turn 语义、幂等投递和产物引用。只有此阶段才评估 Fukai continuation 的有限 spawn/await。

**退出条件**：并行任务不会破坏主线事实；并发上限、背压、公平性、死锁、重复消息和子任务失败可恢复。

## Phase 4: persistence and deployment

根据数据量和恢复需求选择 SQLite、事件服务或远程 Store；考虑多进程 runtime、权限隔离和外部 sandbox。

**退出条件**：拆分部署不改变事件、A2A 和 replay 语义，且安全边界有真实验证。

## Phase 5: management surface

通过稳定控制协议接入 UI、审阅面板、产物浏览、运行控制和多设备访问。UI 只消费 Projection、提交命令，不直接操作 lane 内存。

**退出条件**：用户能管理长期 Run、处理 Advice、审阅来源、暂停/恢复并理解成本和风险。

## 明确延后

通用 graph DSL、Fukai Execution（持久 Python/JS、任意代码和环境恢复）、自动规划市场、向量记忆、无界自我复制、插件 marketplace、模型自动安装插件和 UI-first 的内核设计都延后到有证据证明其必要性。
