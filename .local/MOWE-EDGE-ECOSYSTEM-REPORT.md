# Mowe Edge Ecosystem Compatibility Report

基线：`main@c9bf684`
范围：Skills、MCP、未来插件的兼容性和导入路线。本文是 beta 设计决策，不实现
marketplace、下载器、热加载或新的运行时。

## 结论

Mowe 应继续是 Nausicaa 外围的薄、可替换 edge。beta 可以安全复用两类成熟能力：

1. 本地、人工放置且显式选择的 `SKILL.md`；
2. 用户设置中明确声明、由 host grant 授权的 MCP server（优先 stdio；HTTP 仅作
   高风险手动配置）。

Pi/Prime 的扩展运行时、Prime 的 Python/RLM 技能和 DeepSeek/Cordis 的动态插件图不应
进入 Mowe core。未来插件包只能先转换成可审计的 manifest 和 adapter，再经过 host
admission；当前没有自动安装器，也没有 marketplace 发布承诺。

## 已实现的 Mowe 边界

### 合同和事实所有权

- `EdgeManifest` 要求稳定的 `sourceId`/来源类型、能力和 schema 版本、输入输出 schema、
  effect/scope、取消/幂等/恢复语义、adapter 兼容范围、provenance 和 host 计算的
  `manifestHash`（`src/mowe/edge-types.ts:16-50`）。许可证和来源 URI 是 manifest
  字段；它们不是授权本身。
- `EdgeAdapter` 只负责 `discover`/`load` 和可选的 refresh/health/release；Skill/plugin
  的 `EdgeContributionAdapter` 把正文作为渐进式 context contribution（同上文件
  `:98-149`）。Ledger、Run、lane、权限和 daemon 仍由宿主拥有。
- Registry 在宿主内存中发布原子 generation。刷新按 source 合并，构建确定性、不可变的
  capability/context snapshot；正在使用的 Turn 继续持有旧 snapshot。选中 contribution
  必须属于该 registry 的精确 snapshot（`src/mowe/edge-registry.ts:303-369`、
  `:665-800`）。这不是第二个事实库。
- Host grant 在 capability 进入 catalog 前应用。无 grant 的能力被隔离为
  `external/host/approval-required`；effect 或 scope 不被 grant 允许时拒绝
  （`src/mowe/edge-registry.ts:1039-1083`）。

### 配置和组成入口

- Edge 设置是声明，不是自动加载器。`enabled` 和 `refreshOnStart` 默认均为 `false`，
  source 只能是 `skill`、`mcp` 或 `plugin`，grant 单独列出
  （`src/config/settings.ts:33-80`、`:280-309`）。用户设置来自
  `~/.nausicaa/settings.json`；项目设置只有在 host 明确信任 workspace 时才合并
  （`src/config/settings.ts:158-187`）。
- Composition factory 要求调用方注入 Skill/MCP/plugin constructor，不自动 import
  adapter。默认不会调用 constructor；plugin source 目前明确记录为
  `plugin-unsupported`，缺少 Skill/MCP constructor 记录为 `planned`
  （`src/config/edge-factory.ts:25-35`、`:83-117`）。constructor 错误只进入脱敏诊断。
- 当前 CLI composition root 明确注入 `createSkillsEdgeAdapter` 和
  `createMcpEdgeAdapter`，并把 source 的 `location`/`command`/`endpoint` 传给它们
  （`src/cli.ts:525-592`）。这仍是人工配置后的宿主接线，不是自动发现、下载或安装。
- CLI/TUI 只提供状态和选择面：`/skills` 管理下一 Turn 的明确选择，`/edges` 查看或
  请求刷新；它们不直接管理 edge 进程（`README.md:41-66`、`:147`）。因此“导入”在
  beta 的真实含义是用户编辑设置、host 构造已审计 adapter、刷新并在后续 Turn 使用。

### Skills

- Loader 读取 Agent Skills convention 的 `SKILL.md`，默认根为
  `.agents/skills`、`.pi/skills`、`skills`；跳过 `.git`、`.nausicaa`、`dist`、
  `node_modules` 等目录，并限制深度、文件/总字节、资源数量和资源字节
  （`src/mowe/edges/skills.ts:9-39`）。
- Discovery 只返回冻结 metadata；正文和资源只有在 host 选择 exact summary 后才读取。
  重名可以 `error`、`first`、`last` 或 `report`，结果和诊断按稳定顺序排列
  （`src/mowe/edges/skills.ts:250-355`）。
- 选中的正文投影为 `untrusted-context`，不携带 effect、scope、approval、grant、Goal
  或 Ledger 字段；禁用 model invocation 的 Skill 保留在诊断中但不能被选择
  （`src/mowe/edges/skills.ts:549-649`、`src/mowe/skills-selection.ts:151-218`）。

### MCP

- Adapter 使用 SDK 负责 JSON-RPC；可以接入注入的 transport/client、stdio command 或
  Streamable HTTP endpoint，并拥有有界的连接、分页、schema、结果、取消、超时和 release
  生命周期（`src/mowe/edges/mcp.ts:146-154`、`:188-240`、`:249-357`）。离线测试可注入
  client/transport，不需要网络。
- 工具名称被稳定地命名为 `mcp__<source>__<tool>`。默认 policy 是
  `external`/`run`、需要 approval、非确定性且不可假定幂等；MCP annotation 不会自行
  授予权限（`src/mowe/edges/mcp.ts:681-738`；离线行为见
  `test/unit/mowe-mcp-discovery.test.ts:102-134`）。
- HTTP endpoint 只允许 `http`/`https`，拒绝内嵌用户名/密码；headers 和 session id
  由 host 持有并在诊断/provenance 中脱敏（`src/mowe/edges/mcp.ts:1048-1098`、
  `:1166-1205`）。返回 task handle 目前明确失败，不能假装支持异步任务
  （`src/mowe/edges/mcp.ts:750-773`）。

## 互操作矩阵

“采用”表示 beta 可在现有边界内使用；“后续薄适配”不表示现在要实现；“拒绝”表示
该形态与 beta 的信任或运行时边界冲突。

| 来源 | 决策 | 可借用的部分 | 导入形态和安全边界 |
| --- | --- | --- | --- |
| 本地 Codex/Claude-style `SKILL.md` | **现在采用** | 标准 frontmatter、名称/描述、正文和相对资源路径 | 使用现有 Skills edge；只读用户指定根，先 metadata 后正文，exact summary 选择，正文以不可信 context 注入。默认根不含 `.claude/skills` 或 `.codex/skills`，这些路径必须由用户显式配置；Claude 的 `.claude/rules/*.md` 不是 `SKILL.md`，不应被隐式递归导入。 |
| Pi skills | **现在采用其格式，后续薄适配** | 可见 Skill 目录只列 name/description/location，匹配任务时再读正文；快照还显示 XML 转义和相对路径规则（`docs/reference-prompts/snapshots/pi/agent-system-prompt.ts:1-25`） | 将静态 Skill metadata 映射为 context contribution；不把 Pi 的 prompt builder 当作 Nausicaa system prompt，也不复制其运行时。 |
| Pi extensions | **后续薄适配；beta 拒绝直接加载** | `before_agent_start` 可根据当前 tools/skills 添加提示，扩展示例位于用户或项目 `.pi/extensions`（`docs/reference-prompts/snapshots/pi/examples/prompt-customizer.ts:1-20`, `:86-95`） | 未来仅接受声明式、可审计的 manifest，或把扩展封装为独立 MCP/子进程。不得在 Nausicaa 进程内执行任意 TypeScript、修改 system policy 或绕过 Mowe catalog。 |
| Prime skills | **后续薄适配；beta 不承诺 RLM** | Prime 将 Skill 映射为预安装 Python 模块或 shell 命令，并要求阅读对应 `SKILL.md`（`docs/reference-prompts/snapshots/prime-agent/rlm-prompts.ts:87-105`） | 可把纯文档部分按 Skill 导入；可执行部分必须变成显式 stdio/MCP capability。Prime 的常驻 IPython、`rlm(...)` 子代理、continual harness CRUD 不进入 Mowe core。 |
| DeepSeek Skill provider | **后续薄适配；Cordis runtime 拒绝** | provider 以 `list()`/`get()` 分离候选发现和正文加载，并按 scope 合并 provider（`docs/reference-prompts/snapshots/deepseek-harness/dynamic-context/skill.ts:247-268`, `:347-355`） | 可借用 provider/catalog 分层和显式加载；转换为 Mowe context contribution 时仍采用本地路径、hash、大小和不可信 framing。不得引入 Cordis service/event/tool/UI 图或持久动态源码。 |
| stdio MCP | **现在采用** | 现有 adapter 已覆盖 discovery、schema、结果投影、超时、取消和释放 | 用户手动声明 command/args；host 为 source 配置 effect/scope grant，默认 approval-required。优先只读或声明式工具，使用 fake/injected transport 做离线验证。 |
| HTTP MCP | **技术上现在可用，beta 只作手动高风险 opt-in** | 现有 Streamable HTTP transport、endpoint/header/session 校验和脱敏 | 不做远程目录发现或 marketplace。必须显式 endpoint、host-owned headers、network/external grant、超时和可观测 release；缺 grant 时隔离。 |
| 未来 declarative plugin package | **后续薄适配；beta 拒绝自动加载** | 仅借用 manifest/provenance、版本兼容和可逆生命周期思想 | 包先在受控外部环境解析为 Mowe manifest，再由 host 注入 adapter。没有签名/信任、依赖锁定、更新/回滚/移除合同前，不执行包代码或自动安装。 |

参考快照是研究资料，不是运行时依赖。它们的本地版本和提交记录见
`docs/reference-prompts/README.md:46-54`（Pi `0.0.3`、Prime `0.7.2`、DeepSeek
`0.1.1-rc.2`）。归档没有替代上游许可证审查；采用任何外部包前必须从其发行物确认
SPDX/license、作者和来源 URI，并写入 manifest。Mowe 当前在缺少 MCP 许可证信息时保留
`UNKNOWN`（`src/mowe/edges/mcp.ts:704-708`），这不是“已批准”标记。

| 研究来源 | 仓库内可核实的 revision | 许可证证据 | 本报告采用边界 |
| --- | --- | --- | --- |
| Pi | `docs/reference-prompts/README.md:50` 的 `1defa151...` | 快照目录未包含 `LICENSE`；发行前需核实上游 SPDX | 只借用 Skill metadata/progressive disclosure；不引入 Pi extension runtime。 |
| Prime Agent | `docs/reference-prompts/README.md:51` 的 `7787f074...` | 快照目录未包含 `LICENSE`；发行前需核实上游 SPDX | 只借用 Skill 目录和显式调用提示；不引入 Python/RLM kernel 或 credential store。 |
| DeepSeek Harness | `docs/reference-prompts/README.md:52` 的 `b150a551...` | 快照目录未包含 `LICENSE`；发行前需核实上游 SPDX | 只借用 provider/catalog 分层；不引入 Cordis plugin graph。 |
| MCP SDK | 当前依赖和 adapter 见 `src/mowe/edges/mcp.ts:146-154` | 依赖许可证由本仓库 package/lockfile 管理；具体 server 许可证仍是 source provenance | 复用 SDK transport/list/call，不复制协议或 server 实现。 |

## 工具类别的具体含义和最小形态

这些类别描述的是能力，不是要求 Nausicaa 自己实现底层引擎。每个能力都必须成为普通
Mowe tool，带 manifest、effect/scope、取消/恢复语义和 host grant。

| 类别 | 在 harness 中意味着什么 | 最小接入形态 | 不在 Nausicaa core 实现的部分 |
| --- | --- | --- | --- |
| 浏览器自动化 | 导航、点击/填写、页面读取、截图、下载等有状态外部交互；可能改变远端页面或账户 | 现成浏览器 MCP/受控子进程 adapter；每个操作声明 `external`，写入或账户动作需要 approval，超时后按 reconcile/unknown 处理 | 浏览器驱动、渲染、JS 执行、下载隔离和反滥用策略。当前 ADR 0009 只实现有界 `web_fetch`/`web_search`，明确不实现浏览器引擎（`docs/architecture/adr/0009-mowe-web-capabilities.md:7-25`, `:35-40`）。 |
| LSP | 向语言服务器请求 diagnostics、定义/引用、符号、格式化等；server 通常是长生命周期进程 | 现成 LSP server 的 stdio MCP 或窄 protocol bridge；查询按 `read`/`compute`，格式化等写操作单独声明 `write`，绑定 workspace scope 和取消 | 语言解析器、编译器、索引数据库、server 进程实现。 |
| 数据库 | 参数化查询、事务、迁移、读写数据，凭据和副作用都在 workspace 外 | 现成数据库 MCP/CLI adapter；beta 默认只读，写入/DDL 要显式 grant+approval，结果有界并可引用 Artifact | 数据库引擎、ORM、连接池和迁移框架；不要把数据库状态复制进 Ledger。 |
| 云服务 | Git hosting、对象存储、工单、部署等远端 API；网络、凭据、重试和幂等性各异 | 现成 provider SDK/MCP 的外部 adapter；凭据只在 host secret boundary，manifest 只记能力和 provenance，按 operation 标记幂等/reconcile | 云 SDK 集合、credential store、全局重试队列和远程 scheduler。 |

## “Marketplace 自动安装”的精确定义

自动安装不是“列出几个链接”。完整流程至少包括：

```text
discover catalog
  -> verify publisher/provenance/signature/license/hash
  -> resolve and install dependencies in an isolated, locked location
  -> show requested effects/scopes/secrets and obtain host approval
  -> activate an immutable manifest/adapter generation
  -> observe health and record version
  -> update with compatibility check and staged replacement
  -> rollback to a known-good manifest on failure
  -> disable/revoke, release processes, remove package/cache, and forget credentials
```

其中 discovery 解决“谁发布了什么”，trust/provenance 解决“为什么相信它”，dependency
install 解决“代码和依赖在哪里运行”，permissions 解决“能做什么”，update/rollback
解决“升级失败如何回到已知版本”，remove 解决“停用后是否仍有进程、缓存或权限”。

beta 只支持本地/manual registration，原因是当前代码刻意缺少上述安装器、签名/发布者
信任根、依赖锁和隔离 store、更新/回滚状态机以及撤销/删除 UX。`plugin-unsupported`
诊断和设置中的 `plugin` 声明不能被解释成已实现的 marketplace；README 也将插件市场、
热加载和真实 MCP marketplace 验证列为 beta 外内容（`README.md:17`、`:39-66`）。

## 两阶段路线

### Beta+ / 近期（最多三个）

1. **Curated local Skills profile**：固定 `SKILL.md` 根和冲突策略，补齐 provenance/license
   录入、选择/禁用的 CLI 投影和离线 fixture。只允许正文作为不可信 context，不执行 Skill
   内命令。
2. **Curated read-only stdio MCP profile**：选择一个本地、可审计的文档/工程查询 server，
   固定 namespace、schema/result 上限、`read/workspace` grant 和 approval 规则；所有 smoke
   使用 fake/injected transport。
3. **一个单独的领域 adapter spike**：由产品 owner 在 LSP、浏览器 MCP、数据库或云服务中
   选一个，优先现成 stdio MCP。只提交 manifest、权限、取消/未知状态和离线 contract tests；
   不同时铺开多个生态，也不写底层引擎。

每个近期 adapter 都要能在配置中独立 disable，刷新只影响后续 Turn，失败只影响自己的
source/operation，并留下 health/diagnostic 证据。没有这些条件就停在手动 manifest，不扩大
catalog。

### Later / marketplace UX

先定义可验证的 publisher/signature/license 记录、依赖 lock/install root、沙箱和 secret
边界，再定义版本 pin、兼容检查、staged update、known-good rollback、disable/revoke/
remove 及其审计事件。之后才可以做搜索、安装、更新和卸载 UI；UI 仍只提交 host 命令，
不直接拥有进程或事实。任何实现都必须保留 Mowe catalog/admission 和单一 Ledger 事实源，
不能引入 Cordis 式全局插件 runtime。

## Future edge import acceptance contract

一个未来 edge package/adapter 只有满足以下条件才能进入 beta 之后的 host：

1. **Immutable Turn snapshot**：每个 Turn 固定 generation、tool schema/context summary、
   manifest hash 和 adapter compatibility；刷新不会改变正在执行的 Turn。
2. **Visible provenance**：UI/诊断可看到 source、upstream name/version、license、作者/URI
   （经过脱敏）和健康状态；历史事件的含义不因重新发现同名能力而改变。
3. **Explicit grants**：manifest 的 effect/scope 只是声明；host grant 明确列出允许值，
   approval 默认开启，缺 grant 时隔离或拒绝。
4. **No secret leakage**：API key、header、session token、环境变量和完整 endpoint 不得进入
   manifest、Ledger、prompt、health message 或错误；日志和 provenance 使用脱敏投影。
5. **Deterministic conflicts**：source/capability/contribution identity 可稳定计算；重复
   名称、namespace、版本和 schema 冲突有固定 winner 或显式 error，并生成可排序诊断。
6. **Disable/remove path**：可在下一 Turn 前禁用；release 会关闭连接/子进程，撤销 grant，
   清理 adapter cache 和安装物，并留下可恢复的 provenance/审计记录。不能依赖进程内 singleton
   或不可见队列作为事实。

## Evidence and open risks

| 证据 | 已观察行为 | 对路线的影响 |
| --- | --- | --- |
| `src/mowe/edge-types.ts:16-50`, `:124-157` | manifest/provenance/hash、工具和 context adapter、snapshot 类型已存在 | 复用合同；不新建插件 schema 或第二个 runtime。 |
| `src/mowe/edge-registry.ts:303-369`, `:665-800` | source-scoped refresh、generation、稳定排序和 exact contribution snapshot | marketplace/导入必须适配 registry，不能在 UI 或 adapter 内另存事实。 |
| `src/mowe/edges/skills.ts:250-355`, `:549-649` | metadata-only discovery、显式 load、不可信投影、有界资源 | 本地 Skills 可现在采用；任意规则/命令不能隐式执行。 |
| `src/mowe/edges/mcp.ts:188-240`, `:681-797` | stdio/HTTP transport、默认 external+approval、结果边界、task handle 拒绝 | stdio 适合 beta；HTTP 需显式高风险 opt-in；异步 MCP 需另立合同。 |
| `src/config/settings.ts:158-187`, `:280-309` | 用户设置/受信项目设置，edge loading 默认关闭，grant 独立 | “导入”当前是手动配置，不是安装。 |
| `src/config/edge-factory.ts:83-117` | constructor 注入；plugin 记录 unsupported；缺 constructor 记录 planned | 没有自动 plugin loader 或 marketplace，不能在文档中声称已实现。 |
| `src/cli.ts:525-592` | CLI 只在启动 composition 时注入现有 Skill/MCP adapter；选择和状态仍由 host provider 投影 | 可复用生产接线；不要把它扩展成扫描、下载或安装控制面。 |
| `docs/reference-prompts/README.md:3-13`, `:46-67` | Pi/Prime/DeepSeek 是只读研究快照，带本地版本/commit | 可借用行为和边界，不复制上游 runtime；许可证仍需发行物审查。 |
| `docs/architecture/adr/0010-edge-ecosystem-contract.md:76-117` | 已确定 edge、provenance、snapshot、admission 和 non-goals | 本报告细化 beta 互操作和产品路线，不改写既有 ADR。 |

### Remaining risks

- 当前 manifest 的 `license: UNKNOWN` 允许技术 discovery，但产品不能把它当作分发许可；
  curated adapter 上线前必须补齐上游许可证证据。
- HTTP MCP 的 host-owned headers 仍可能授予远端服务高权限；beta 不应把“可连接”当作
  “可信”。
- MCP task handles、长生命周期 LSP/browser sessions 和数据库事务需要明确 reconcile/
  rollback 合同后才能支持写操作。
- 本报告没有实现任何 downloader、installer、marketplace、browser/LSP/database/cloud
  engine，也没有进行网络调用或使用凭据。

## S6 handoff

- 交付文件：`.local/MOWE-EDGE-ECOSYSTEM-REPORT.md`；没有修改 `src/mowe/**`、依赖、
  package、CLI 或现有架构文档。
- 离线证据：`git diff --check` 通过；报告引用的 source/test/reference 路径均已在本地
  检查存在。文档改动不需要 typecheck 或测试套件。
- S6 应复核：与 README 的 beta 排除项、S4/S5 的发布和 smoke 边界是否一致；尤其不要把
  HTTP MCP 的技术可用性写成 marketplace 信任或自动安装。
- 未生成 commit hash：当前 sandbox 不允许写 `.git/refs`，且工作树含其他 session 的
  并行改动；请由集成 session 在干净分支中提交本文件。
