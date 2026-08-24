# Plugins And Execution

状态：Proposal。插件化用于减少内核体积和上下文噪声，不是把所有能力都自动暴露给模型。

## Capability 模型

插件声明：

- 能力名称和版本。
- 输入/输出契约和可产生的副作用。
- 所需 workspace、网络、凭证和资源范围。
- 支持的 lane 类型和最低权限。
- 可否并行、取消、重试、checkpoint 和恢复。
- 产生的 Artifact 类型及其可见性。

模型先发现能力，再由 runtime 根据任务、policy 和预算激活能力。未激活的插件不进入当前 context view，也不能被模型调用。

## 插件层次

```text
provider adapter       pi-ai model and stream
context capability     query, read, compare, checkpoint
workspace capability   file, process, browser, network
coordination capability A2A, task, inbox, approval
deployment capability  remote, sandbox, secrets, observability
```

最小内核只需要稳定的 capability contract；具体实现可以是进程内函数、子进程、远程服务或未来的插件包。

## 激活流程

```text
discover -> select -> authorize -> budget -> activate
         -> execute -> record -> release
```

激活不是一次永久注入。能力可以有 scope、TTL、并发上限和 token 说明；任务阶段改变时重新评估。

## 工具执行边界

任何外部副作用先记录 operation intent，再调用 executor，最后记录 result、exit state 和 artifact refs。工具必须报告是否幂等、是否可查询、是否可取消以及未知状态如何处理。

插件默认没有 shell、网络、凭证或整个 workspace 权限。权限通过 capability policy 授予，安全边界由外部 sandbox 承担，Nausicaa 不把进程内检查称为 sandbox。

## 插件状态

插件必须属于以下一种：

1. **纯函数**：无持久状态，直接记录输入输出。
2. **可快照**：状态可以导出、恢复并在 checkpoint 中引用。
3. **外部不可恢复**：必须显式标记；崩溃后转为 unknown，由 policy 或人工确认。

隐藏的全局 singleton、未记录的队列和无法解释的缓存不能成为关键事实的唯一来源。

## 版本和兼容

能力 schema、参数格式和输出事件带版本。升级不应改变历史事件含义；必要时通过 projection migration 或新事件类型兼容。插件错误要隔离到对应 lane 或 operation，不允许任意修改 Run。

## 不做的事情

第一阶段不做自动插件市场、任意第三方代码热加载或模型自行安装能力。先验证按任务激活、权限隔离、上下文缩减和可恢复执行是否真的有收益。
