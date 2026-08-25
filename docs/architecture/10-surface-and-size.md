# Surface, Configuration, And Size

状态：Proposal。目标是保持 Prime/Pi 风格的轻盈产品面，不让入口、TUI 和配置反向塑造 runtime。

## 参考取舍

- TUI 直接依赖 `pi-tui`，交互和紧凑信息密度主要参考 Prime Agent。
- 单一可执行入口参考 Pi/Prime：默认进入交互模式，print/JSON/RPC 作为 mode，而不是建立庞大子命令树。
- 内部 boot 保持一个 composition root，但不复制 DeepSeek 的 Cordis 插件树。
- 配置使用 Prime/Pi 风格 JSON settings，不采用 Codex 风格 TOML profile 矩阵。

## 初始入口

```text
nausicaa [message]                 interactive by default
nausicaa -p [message]              one-shot print
nausicaa --mode json [message]     NDJSON event output
nausicaa --mode rpc                machine control
```

具体 flag 尚未冻结，但只保留一个 bin 和一个 boot path。TUI、print、JSON 和 RPC 都消费相同的 runtime events，不能各自实现一套 loop。

## Settings

```text
~/.nausicaa/settings.json          user settings
.nausicaa/settings.json            trusted workspace overrides
CLI flags                          one-run overrides
environment / credential store     secrets
```

配置首期只包括模型选择、预算、Main+Teto 开关、Teto 触发参数、工具权限和显示偏好。项目配置不能提供凭据或静默放宽机器权限。对象可以做简单覆盖；数组整体替换。首期不做任意 graph DSL、插件清单、profile 矩阵、热重载或配置脚本。

## TUI 边界

TUI 只渲染 runtime projection 并提交命令：Main transcript、Goal、lane 状态、Advice、预算和审批。它不读取 Agent 内存、不调度 lane、不保存事实，也不拥有恢复逻辑。MVP 自有 TUI 目标为 300-500 行，渲染器、编辑器和 Markdown 全部复用 `pi-tui`。

## 代码预算

以下只计算自有生产 TypeScript，不含依赖、生成文件、测试和文档：

| 阶段 | 目标范围 | 审查门槛 |
| --- | ---: | ---: |
| MVP | 3,200-4,800 | 超过 6,000 暂停扩功能 |
| 本地可用 v1 | 6,000-9,000 | 超过 9,000 重新定义 v1 |

测试预计与生产代码相当或更多，尤其是 replay、恢复、幂等和权限测试。代码预算不是鼓励压缩写法，而是阻止提前加入 daemon、数据库、通用 graph、完整插件框架和持久 REPL。

## 防膨胀约束

- 首期单 package、单进程、单 writer、固定 Main+Teto。
- Main 与 Teto 使用同一 Lane Runtime 和 Fukai，只切换 policy。
- 没有第二个真实实现前，不创建通用 repository/ORM 层。
- 每个新增抽象必须删除重复、保护不变量或服务已经存在的第二个实现。
- 每个新增 lane 或边必须先通过 Main-only/Main+Teto 对照实验的阶段门。
