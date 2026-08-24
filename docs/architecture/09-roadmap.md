# Architecture Roadmap

状态：Proposal。每一阶段都有退出条件；没有通过退出条件，不进入下一层复杂度。

## Phase 0: vocabulary and invariants

确定 Run、Lane、Step、Event、Artifact、Message、Advice、Checkpoint、Capability 的语义和事件因果关系。

**退出条件**：能够用文档解释一次成功、失败、暂停、恢复、Advice 采纳和重复副作用。

## Phase 1: protocol slice

单进程、单 writer、文件 Ledger、内容寻址 Store、一个 Main 和一个 Teto。只验证增量 capsule、受限查询、Advice ack 和 recorded replay。

**退出条件**：崩溃可恢复，Teto 不读完整 transcript，Advice 可追踪，预算和去重有效。

## Phase 2: real model adapter

接入 `pi-ai`，保留 runtime 对 provider 的隔离。加入稳定前缀、cache outcome、工具 operationId 和最小能力 policy。

**退出条件**：与单 loop baseline 比较，至少能测量 token、缓存、延迟、纠偏和噪声，而不是只有演示。

## Phase 3: worker and A2A

加入有界 Worker lane、任务交接、Inbox 的 next-step/next-turn 语义、幂等投递和产物引用。

**退出条件**：并行任务不会破坏主线事实，重复消息和子任务失败可恢复。

## Phase 4: persistence and deployment

根据数据量和恢复需求选择 SQLite、事件服务或远程 Store；考虑多进程 runtime、权限隔离和外部 sandbox。

**退出条件**：拆分部署不改变事件、A2A 和 replay 语义，且安全边界有真实验证。

## Phase 5: management surface

通过稳定控制协议接入 UI、审阅面板、产物浏览、运行控制和多设备访问。UI 只消费 Projection、提交命令，不直接操作 lane 内存。

**退出条件**：用户能管理长期 Run、处理 Advice、审阅来源、暂停/恢复并理解成本和风险。

## 明确延后

通用 graph DSL、自动规划市场、向量记忆、无界自我复制、插件 marketplace、模型自动安装插件和 UI-first 的内核设计都延后到有证据证明其必要性。
