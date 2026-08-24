# System Boundaries

状态：Proposal。目标是定义哪些能力属于 Nausicaa kernel，哪些能力必须留在外层或适配器。

## 核心对象

```text
Workspace
  └─ Run (long-lived goal)
       ├─ Goal and constraints
       ├─ Lane Graph (typed edges)
       ├─ Lanes
       │    ├─ main
       │    ├─ Teto / IntentNavigator
       │    ├─ explorer / critic
       │    └─ worker / specialist
       ├─ Ledger and projections
       ├─ Artifact Store
       └─ A2A inbox and outbox
```

- **Workspace**：资源、权限和产物的边界，不等于当前任务。
- **Run**：目标、预算、策略、事件流和恢复点的边界。
- **Lane**：独立推进或观察的执行线。lane 的身份、上下文、预算和 cursor 可恢复。
- **Lane Graph**：lane 及其 typed edges 的运行拓扑；边决定是否阻塞、能看什么、能发什么和何时过期。
- **Step**：一次模型请求及相关工具调用。Step 不要求所有 lane 同步，也不等于一次用户 turn。
- **Artifact**：文件、模型原始输出、工具结果、摘要或外部引用。大对象不直接进 Ledger。

## 分层和依赖方向

```text
surface -> control protocol -> runtime kernel
runtime kernel -> Ledger / Store / scheduler / projections
lane runtime -> RLM context / A2A / capability policy
adapters -> pi-ai / clock / storage / transport / executor
```

内核不能依赖 UI、CLI、某个 provider、某种数据库或某个远程 transport。适配器可以依赖内核的窄接口，反向依赖禁止。

## Typed edges

```text
depends-on  结果依赖，可能阻塞下游
observes    只读订阅，不阻塞被观察 lane
advises     发送可接受/延后/拒绝的建议
delegates   委派有界任务和产物责任
joins       在明确决策门汇聚结果
```

Teto 线通常通过 `observes` + `advises` 挂接在 Main 的目标、计划和决策边上；Explorer 可以挂接在某个问题或产物版本上，完成后自然过期。不能把所有关系简化成 `depends-on`。

## 内核职责

1. 接收并校验命令。
2. 根据策略预留预算和权限。
3. 追加事实事件，驱动 projection 和 scheduler。
4. 为每条 lane 生成受限 context view。
5. 管理 A2A inbox、Advice 生命周期和幂等。
6. 写入 checkpoint，支持 replay 和 resume。
7. 暴露资源、延迟、错误和决策来源。

## 外层职责

- **UI/API/CLI**：展示状态、提交命令、审阅 Advice 和产物。
- **Daemon/remote runner**：进程监管、跨机器调度和高可用。
- **Plugin/Executor**：工具、浏览器、代码执行、沙箱和第三方服务。
- **pi-ai adapter**：provider/model 选择、流式结果、usage 和 provider cache。

## 进程拓扑

初始验证建议使用单进程、单写 Ledger、异步 lane。未来可拆为控制面、runtime worker 和执行 worker，但拆分不能改变事件和 A2A 语义。多进程是部署选择，不是核心抽象。

## 边界上的决策

- UI 和 runtime 通过命令、事件订阅、投影查询通信，不直接读写 Agent 内存。
- 模型只看到被批准的 Context View，不直接访问 Ledger 全文或 Store 根目录。
- 插件只获得声明的 Capability 和 Workspace 子边界。
- 用户的高优先级命令可以改变 Run policy，但必须通过事件留下来源和时间。
