# Mowe Edge Ecosystem Compatibility and Import Roadmap

状态：Proposal（beta 约束下的导入决策，非 marketplace 实现）
基线：`main@c9bf684`
范围：Skills、MCP、未来 declarative plugin 的边界；不改变运行时代码或依赖。

## Executive Decision

Nausicaa 应把 Mowe 当作唯一工具执行边界，把生态来源当作可替换的 edge
adapter。beta 继续支持两种人工、显式注册：

1. 本地/已信任工作区中的 `SKILL.md`，只作为按需加载、明确标记为
   `untrusted-context` 的上下文贡献；
2. 用户在 settings 中声明的 MCP stdio 或 Streamable HTTP server，先经过
   host grant，再以稳定命名空间进入 Mowe。

两者都必须在 Turn 边界捕获不可变 generation snapshot。Skill 正文不是系统
提示、策略或工具定义；MCP server 的 annotations 也不是授权。插件在 beta
只保留设计上的 `plugin` source type，不执行任意 JavaScript、安装依赖或
热加载。没有可信来源、权限、版本和回滚契约前，不做 marketplace 自动安装。

这保持了“Pi-like core, thin boundaries”：复用成熟生态的文件格式和 MCP
协议，Nausicaa 自己只负责来源校验、权限重绑定、快照、脱敏、预算和 Mowe
执行。

## Evidence and Reuse Record

以下是本轮实际检查的本地参考。版本为检查时各仓库的 HEAD；它们是研究输入，
不表示 Nausicaa 运行时会加载这些源码。

| 来源 | 本地路径与 revision | 许可证 | 观察到的边界 | Nausicaa 采用/拒绝 |
| --- | --- | --- | --- | --- |
| Pi | `/Users/gongdongjie/Downloads/pi`, `1defa151e` (`fix(coding-agent): expose https-proxy-agent named export`)；`packages/coding-agent/docs/skills.md`、`src/core/skills.ts`、`docs/extensions.md` | `LICENSE`：MIT | Agent Skills 目录扫描、渐进式 disclosure；扩展是可执行 TypeScript，可注册工具、事件、命令、UI，且拥有宿主权限，需信任路径后才加载 | 采用 `SKILL.md` 兼容格式和“摘要先行、正文按需读”；拒绝把 Pi 扩展运行时直接载入进程，避免任意代码和全局事件总线进入 Mowe |
| Prime Agent | `/Users/gongdongjie/Downloads/primeagent`, `7787f0741` (`fix(coding-agent): retain root kill cleanup ownership`)；`packages/coding-agent/docs/skills.md`、`docs/mcp-integrations.md`、`packages/ai/src/mcp/` | `LICENSE`：MIT | Skills 可为 markdown 或 Python-backed package；MCP 集成作为 Python skill 在持久 IPython kernel 中调用，OAuth 登录把凭据放入 `auth.json`；当前集成以 HTTP 为主，stdio 不接 kernel | 采用其 progressive disclosure 和 MCP “先发现工具再调用”原则；拒绝 Python kernel、OAuth credential store、持久单例和 skill 自带依赖安装 |
| DeepSeek Harness | `/Users/gongdongjie/Downloads/deepseek-harness`, `b150a551b8` (`Merge pull request #2908 ... dsh-0.1.1-rc.2`)；`packages/skill/README.md`、`packages/extensions/`、`packages/extensions/cordis-host-runner/`、归档 `docs/reference-prompts/snapshots/deepseek-harness/dynamic-context/skill.ts` | `LICENSE`：MIT | Skill 是可渐进加载的上下文能力；Cordis Plugin 可注册 service、event、model tool、UI，并有 host/client activation、package/version、approval、retract 生命周期 | 采用“来源/版本/激活生命周期必须可见”的证据；拒绝 Cordis 全局 plugin runtime、动态源码执行、未持久化 event/service registry |
| OpenAI Codex | `/Users/gongdongjie/Downloads/codex`, `31d338a` (`Isolate required-model Guardian approval coverage`)；`docs/skills.md`、`codex-rs/plugin/src/manifest.rs`、`plugin/src/provider.rs`、`app-server/src/request_processors/plugins/` | 根 `LICENSE`：Apache-2.0 | Plugin manifest 是惰性的资源描述，skills/MCP/hooks/apps 均为路径；provider 先把资源绑定到 environment/root，拒绝越出 package root；搜索、marketplace、安装和共享是独立控制面 | 采用 authority-bound resource、manifest provenance、安装与激活分离；拒绝把远程 search/install/marketplace 作为 beta 能力 |
| Agent Skills format | Pi/Prime 文档引用的 `agentskills.io/specification`；本地实现见 Pi `packages/coding-agent/src/core/skills.ts` 与 Nausicaa `src/mowe/edges/skills.ts` | 格式规范；上游实现许可证见上表 | frontmatter 至少需要 `name` 和 `description`；目录中 `SKILL.md` 是可渐进加载文档，内容可能包含任意操作指令 | 兼容最小 markdown contract；Nausicaa 额外做路径、大小、符号链接、body hash 和 untrusted framing |
| MCP | Nausicaa 使用的 `@modelcontextprotocol/sdk`（`src/mowe/edges/mcp.ts`）；协议来源为 MCP SDK，不复制协议实现 | 依赖许可证由 `package.json`/lockfile 管理 | server 声明工具和 JSON schema；stdio/Streamable HTTP 负责传输；协议 annotations 只是 hints，不能替代 host policy | 采用 SDK transport 和 list/call 形状；host 自己决定 effect/scope/approval、超时、结果大小和命名空间 |

**采用边界记录。** 采用的是行为和数据格式（Skill frontmatter、MCP
list/call、Codex 的 authority-bound manifest 思路），不是上游框架、kernel、
marketplace 或其 credential store。若未来要移植代码，必须在独立 ADR 中记录
准确 upstream revision、许可证、保留的 API 边界和为何不采用更大运行时。

## Nausicaa Current Edge Contract

### Declarations and host composition

`src/config/settings.ts` 定义了 `edges.sources` 和独立的 `edges.grants`。
source 只描述 `sourceId`、`type`、Skill `location` 或 MCP `command`/`endpoint`；
它不会因为出现在 settings 就启动进程、联网或获得工作区权限。默认
`edges.enabled` 与 `refreshOnStart` 均为 `false`，CLI 的 `--edges`、
`--no-edges`、`--refresh-edges` 只是本次宿主组合的覆盖。

`src/cli.ts` 的 composition root 把 `skill` 映射到
`createSkillsEdgeAdapter`，把 `mcp` 映射到 `createMcpEdgeAdapter`。当前没有
`plugin` constructor；`plugin` 只能作为配置/合同中的保留 source type，实际
注册会因缺少 adapter 而不产生能力。

### Manifests, provenance, and grants

`src/mowe/edge-types.ts` 的 `EdgeManifest` 固定 source/capability/schema
版本、effect、scope、取消/幂等/恢复语义、adapter compatibility 和
`EdgeProvenance`。`src/mowe/edge-adapter.ts` 会验证严格字段、计算
`sha256:` manifest hash、克隆并 deep-freeze；tool definition 的 name、说明和
参数 schema 必须与 manifest 一致。Skill context summary 也有 source、稳定
contribution id、disabled、可选 body hash 和 provenance。

`MoweEdgeRegistry`（`src/mowe/edge-registry.ts`）是唯一 host registry：

```text
settings declaration
       -> adapter discover (metadata/schema only)
       -> validate ownership + manifest/hash
       -> adapter load (tool definition, not arbitrary package code)
       -> host grant rebind (effect/scope/approval)
       -> deterministic collision pass
       -> generation snapshot + MoweCatalog
       -> one Turn captures snapshot; later refresh affects next Turn only
```

缺少 grant 时，tool 不会被默默当作普通 workspace tool；registry 将其重新绑定
为 `external/host`, `requiresApproval: true` 的隔离能力并发出
`host-grant-denied` warning。grant 若不包含 manifest 的 effect 或 scope，能力
直接被拒绝。与第一方工具、其他 edge 的同名冲突按确定性顺序拒绝 edge，保留
host precedence。`disable`/`unregister` 只影响后续 snapshot，release 经过
registry 的串行生命周期队列。

### Skills: actual import boundary

`src/mowe/edges/skills.ts` 的默认扫描根是 `.agents/skills`、`.pi/skills`、
`skills`（配置 source 可指定 workspace-relative root）。扫描时只读
frontmatter 和文件 identity，不把正文放进 registry snapshot；大小、深度、
总量、NUL、符号链接、路径逃逸、重复名称和 frontmatter 错误都有明确限制。

`discoverContributions()` 返回 metadata-only `EdgeContextContributionSummary`。
宿主通过 `src/mowe/skills-selection.ts` 选择 generation 内的 summary 后，
registry 调 `loadContribution()`；loader 会重新校验文件 identity、大小、
frontmatter hash 和 contribution id。可选 resource 只能由调用方显式列出并
受独立字节上限保护。

`projectSkillContext()` 将结果变成：

```text
{ kind: "untrusted-context", trust: "untrusted", untrusted: true,
  sourceType: "skill", sourceId, contributionId, name, description,
  contentHash, body, resources }
```

它不是 `AgentTool`，不进入 `projectInstructions`、system policy 或 Worker
工具面。`src/runtime/edge-runtime.ts` 只在 host selector 明确选中时加载，
并将失败、取消、过期 generation 显式投影为诊断。

### MCP: actual import boundary

`src/mowe/edges/mcp.ts` 只接受显式 `command`/`args`（stdio）或显式
`endpoint`（Streamable HTTP）；两者互斥，HTTP URL 禁止内嵌凭据。SDK 负责
初始化和 JSON-RPC framing，adapter 负责 listTools 分页、schema 大小、工具数、
结果 block/image/structured-content 限制、超时、取消、重连和 release。

每个远端工具被投影为 `mcp__<source>__<tool>`，避免跨 server 名称碰撞；先
discover 再 load，发现时不会执行工具。MCP tool annotations 明确被视为
untrusted hints，effect/scope/approval 只能来自 host policy/grant。响应文本、
URL、session/header 等诊断经过截断与脱敏，不写入 prompt 或 secrets store。

### Snapshot and runtime surfaces

`src/mowe/workspace-catalog.ts` 将 registry snapshot 转为 Turn-local
`MoweCatalog`，复制 tools、metadata 和 context summaries；`src/mowe/index.ts`
导出的是窄 contract，而非一个 plugin framework。`src/cli/edge-status.ts`、
`src/cli/edge-selection.ts` 和交互 `/edges`、`/skills` 只显示健康、来源、
provenance、摘要与选择状态；它们不管理 edge 进程，不执行 marketplace 安装。

## Interoperability Matrix

分类：**现在采用** = beta 可用且手动配置；**薄适配 later** = 保留现有
contract，另写 adapter/转换器后再启用；**拒绝** = 与安全/事实源边界冲突，
除非产品方向重新确认。

| 来源/形态 | 现在行为与可复用契约 | 决策 | 最小导入形状 | 安全边界 |
| --- | --- | --- | --- | --- |
| Codex/Claude-style local `SKILL.md` | 标准 frontmatter + markdown body；通常放在 `.agents/skills`、`.claude/skills` 或 `.codex/skills`，正文可包含脚本和资源 | **现在采用（目录适配）** | 把已信任目录映射为现有 Skills adapter 的 `roots`；`.claude/skills`/`.codex/skills` 可由用户显式配置为 `location`，不扫描 home 外路径 | source 必须经 host settings 声明；仅 metadata 自动发现；body 只有用户选择后加载，作为 untrusted data；脚本不会由 loader 自动执行 |
| Pi skills | Pi `docs/skills.md` 的全局/项目/package/CLI 多来源和渐进式 `/skill:name`；名称冲突保留确定性 winner | **现在采用（薄格式兼容）** | 复用 `SKILL.md`，以 source root + relative path 作为 contribution id；不复制 Pi 命令或 package installer | 项目根只在 trusted workspace 才启用；Nausicaa 的路径、文件 identity、大小和 disable-model-invocation 检查优先 |
| Prime skills | Markdown skill 与 Python-backed skill；可有 `pyproject.toml`、kernel venv、`run()` 和 CLI | **现在采用 markdown；Python later/拒绝自动安装** | 仅导入 Prime skill 的 `SKILL.md`/资源；若 future adapter 识别 Python package，只能声明外部 executable capability，不在 Nausicaa 内建 IPython | 不创建 kernel venv，不安装 dependencies，不读取 Prime `auth.json`；Python 执行须另有 process/MCP adapter、grant 和可恢复 job 语义 |
| DeepSeek skill | Skill context 在动态 context 层 progressive load；Cordis skill/plugin 可修改 service/event/tool/UI | **现在采用格式；Cordis runtime 拒绝** | 只借鉴 context summary/body hash/provenance；把正文投影成 `untrusted-context` | 不允许 skill 改写 Host 事件、注册全局 service、持久隐藏 queue 或绕过 Ledger |
| stdio MCP | MCP SDK 的 `command + args` 子进程 transport，服务声明 tools/schema | **现在采用** | `createMcpEdgeAdapter({ sourceId, command, args, cwd })`；listTools→manifest→grant→Mowe call | 子进程只在 enabled + refresh 时由 host 启动；command/args 是 settings 中的高权限声明；默认无 grant，超时/输出/并发均有界；MCP annotations 不授权 |
| HTTP MCP / Streamable HTTP | MCP SDK Streamable HTTP transport；Prime 当前集成使用 HTTP，Codex 也分离 MCP refresh/auth 生命周期 | **现在采用（显式 endpoint）** | settings 中 `endpoint`、可选 headers/sessionId；SDK fetch/transport；来源身份仍是用户给的 sourceId，不是 URL | URL 不能含凭据；headers/sessionId 仅 host-owned，不能写入 diagnostics；network capability、SSRF/redirect、预算和 approval 由 host 负责 |
| Future declarative plugin package | Codex manifest 展示 skills/MCP/hooks/apps 的路径描述和 root authority；DeepSeek Cordis 展示 host/client activation | **薄适配 later** | 解析一个静态 manifest 为若干 Skill/MCP declarations；每个资源绑定 package root，转为现有 adapters；plugin 自身不执行代码 | 需要签名/哈希、来源许可证、依赖锁、权限声明、升级/回滚；未满足前只显示 disabled metadata，不进入 Turn |
| Arbitrary JS/TS extension | Pi/DeepSeek 都支持强大的 executable extension/plugin，拥有事件和宿主 API | **拒绝（beta）** | 无 | 进程内任意代码会绕过 Mowe、Ledger、grant 和 immutable snapshot；若未来支持，必须是隔离 worker + versioned RPC，不是 `import()` |
| Marketplace URL/search/install | Codex 已把 search、scope、marketplace、install、sharing 作为单独控制面；Prime/DeepSeek 的本地 package 也有独立安装语义 | **拒绝（beta）** | 无自动下载；用户手动放置并声明本地路径 | 无信任根、签名、依赖/升级/回滚和撤销协议时，自动安装等同远程代码执行 |

### Specific source import notes

**`.claude/skills` 与 `.codex/skills`。** 两者都可以作为用户显式指定的
`location`，但不能凭“目录名称”推断信任。Nausicaa 当前默认 roots 不包含
`.claude/skills` 或 `.codex/skills`，这是有意的：import 的动作必须留在
settings/host composition 中。导入只取得 Agent Skills 文档，不取得 Claude
hooks、Codex plugin apps 或 provider credentials。

**Pi skill/extension。** Pi 的 extension loader（`pi/packages/coding-agent/
src/core/extensions/loader.ts`、`docs/extensions.md`）提供热 reload、命令、
事件和 custom UI，但这些都是宿主级可执行代码。Nausicaa 只借用 Pi 的
“Skill body 按需读”和“project source 要先 trust”原则；不把 Pi extension
目录当作 Skill 目录，不把 `/skill:name` 命令映射为隐式 context 注入。

**Prime Python skill。** Python-backed skill 的 `pyproject.toml`、editable
install、kernel venv 和 `auth.json` 是 Prime 自己的事实与凭据边界，不能被
Nausicaa 复制成第二个 credential/runtime store。需要这类能力时，优先让它
以 stdio MCP server 或受控 process job 暴露，再按 MCP/host grant 规则导入。

**MCP stdio 与 HTTP。** 两者都共享 EdgeManifest/Mowe policy；transport
差异只留在 adapter。stdio 适合本机、可审查的命令；HTTP 适合显式远端服务，
但必须把 endpoint、headers、session 生命周期和网络权限分开审计。任何需要
OAuth/browser login 的服务暂不通过 Nausicaa 自动完成登录，除非另有明确
credential contract。

## What Common Tool Labels Mean

这些不是 Nausicaa 要自研的四个引擎；它们是 harness 中的能力标签，应优先由
成熟本地工具或 MCP server 提供。每项都必须声明 effect/scope、可取消性、
幂等/恢复语义和输出上限。

| 能力 | 在 harness 中的真实含义 | 最小可行集成 | 为什么不自研底层引擎 |
| --- | --- | --- | --- |
| Browser automation | 打开页面、导航、点击/输入、等待、截图/DOM 读取、下载；通常有 session/cookies 和不可逆外部副作用 | 采用已有 Playwright MCP/browser MCP server；Nausicaa 只做 MCP adapter、host approval、network/secret grant、artifact projection | 浏览器协议、渲染、等待/并发、下载隔离和站点兼容性持续变化，自研会把 Mowe 变成浏览器产品 |
| LSP | 对 workspace 的 language server 请求：initialize、symbols/hover、diagnostics、references、code actions；server 可能读写文件 | 先用已有 LSP MCP bridge 或本地 `stdio` LSP wrapper；只暴露受限 read/diagnostic tool，写操作另设 grant | 各语言 parser/indexer 与增量协议复杂；Mowe 只需路由 JSON、边界路径和结果大小 |
| Database | 连接数据库、schema/query/transaction，可能泄露数据或写入生产 | 首选已有 MCP database server；为 read-only query、migration/write、外网分别声明 source/grant；结果投影到 bounded text/artifact | 驱动、协议、事务、迁移、连接池和认证不是 harness 差异化；内核不应再维护数据库事实源 |
| Cloud service | GitHub/Linear/S3/observability 等外部 API，含 OAuth/token、速率限制和远端状态 | 现成 MCP server 或官方本地 CLI，包成 stdio/HTTP adapter；每个 source 独立 grant 和 provenance，secret 只在 host process | 云 API 版本、OAuth、重试和合规要求高；自研 SDK 会泄露 secrets 并扩大升级面 |

**统一执行形状：** `discover schema → host grant → immutable snapshot → Mowe
execute → bounded projection/artifact → Ledger operation/result`。对于不能
查询未知状态的外部能力，manifest 必须声明 `recovery: "none"` 或
`"reconcile"`，不能把网络重试当作幂等。

## Marketplace Automatic Installation: Precise Meaning

“自动安装”不是一个 `install` 按钮，而是一条改变主机状态的流水线：

```text
discovery/search
  -> source identity + provenance + license
  -> trust decision (signature/digest, publisher, allowed registry)
  -> dependency resolution/install (lockfile, native/python/node assets)
  -> permission review/grant (workspace, network, secrets, process)
  -> activation and immutable Turn snapshot
  -> update (new version, migration, staged rollout)
  -> rollback (old artifact + config + generated state)
  -> disable/remove (stop processes, revoke grants, delete files, preserve facts)
```

每一步都有失败状态和审计记录。特别是：

- **Discovery** 只能给候选元数据，不能暗示安全或已安装；
- **Trust/provenance** 要绑定 publisher、来源 URI、版本、许可证和内容摘要，
  最好有签名/透明日志；
- **Dependency install** 必须是可复现 lockfile，处理 native binary、Python
  venv、Node package 和网络失败；
- **Permissions** 必须逐 source/能力授予，不能从包名推断 shell、网络或 secret；
- **Update/rollback** 必须在 active Turn 外切换 generation，旧 snapshot 继续
  可运行；
- **Removal** 必须先停用/释放 transport 和 jobs，再撤销 grants，清理包但保留
  Ledger 事实与可验证审计。

beta 不实现上述流水线。当前只有 local/manual registration：用户审查目录或
server、写 settings source、写 grants、显式 refresh，再从 `/edges` 查看
health/provenance。不存在自动下载、依赖安装、账号登录、marketplace 搜索或
一键卸载；README 的 beta 边界也明确排除了 plugin marketplace/热加载。

## Two-Phase Roadmap

### Beta+ / near term（最多三个高价值项）

1. **Curated Skill roots adapter（优先）。** 增加一个纯配置层别名，将用户
   明确选择的 `.claude/skills`、`.codex/skills` 或团队目录映射到现有
   `createSkillsEdgeAdapter`。不新增 loader；测试覆盖 path trust、duplicate
   precedence、untrusted projection、disable/remove。交付条件是每个源在
   `/edges` 显示 provenance 和 generation。
2. **Curated MCP manifest helper。** 提供静态、可审查的本地 manifest 文件
   （sourceId、command/endpoint、expected tool namespace、provenance、grant
   request），由 host 显式导入到现有 `createMcpEdgeAdapter`。不下载、不安装、
   不保存 token；测试覆盖 schema drift、grant denial、transport release 和
   deterministic collision。
3. **Declarative plugin descriptor（仅静态）。** 解析类似 Codex
   `.codex-plugin/plugin.json` 的 package descriptor，但只接受 package-root
   内的 Skill/MCP 路径，转换成前两种 adapter。先提供 `inspect`/diagnostic，
   默认 disabled；只有签名、依赖锁和 removal 方案确定后才允许 activation。

  若资源有限，只做第 1 项；MCP 已有成熟 adapter，第三项在没有 trust/update
  方案时不要抢占 runtime 复杂度。

### Later（marketplace UX）

marketplace 的产品工作必须先冻结 trust roots、签名格式、artifact cache、
dependency policy、permission UI、update channel、rollback storage、remove
语义和离线行为，再实现 search/install/update/remove API。设计上应复用 Codex
的“search/list/install 是控制面”分层，而不是把网络搜索塞进 Mowe executor；
任何远程包安装都应产生可审计事实并在新 generation 才生效。未完成这些决定
前，marketplace UX 保持 disabled，UI 只可显示“manual registration required”。

## Future Edge Import Acceptance Contract

一个未来 adapter/package 只有全部满足下列条件，才可进入默认可选 beta+ 目录：

1. **Immutable per-turn snapshot**：每次 Turn 捕获 generation、manifest hash、
   tool schema 和 selected context；刷新不改变进行中的 Turn。
2. **Visible provenance**：用户能从 `/edges` 或 JSON status 看到 sourceId、
   upstream name/version、license、source URI（若有）和 diagnostics；不存在
   “unknown installed package” 的隐式来源。
3. **Explicit grants**：effect、scope、network/workspace/process/secret 许可
   来自 host grant；协议 annotations、包名和模型请求都不能自行升级权限。
4. **No secret leakage**：keys、bearer headers、OAuth refresh data 不进入
   Ledger prompt、manifest hash、诊断、snapshot JSON、artifact 或错误文本。
5. **Deterministic conflicts**：同名 capability、同名 Skill、schema drift 和
   source collision 都有稳定排序与明确拒绝/降级诊断；不依赖 filesystem
   iteration 或网络返回顺序。
6. **Bounded execution**：发现、加载、调用、结果、并发和 wall-clock 均有限；
   cancellation/recovery/unknown side effect 在 manifest 中声明。
7. **Clean disable/remove**：disable 对后续 generation 生效；release 停止
   transport/jobs；remove 不删除 Ledger 事实，且不能留下秘密、后台进程或
   无法解释的缓存。
8. **Offline verification**：能用 fixture 验证 manifest、grant、snapshot、
   redaction 和 rollback/disable，而不需要真实网络或 provider key。

## Open Decisions and Risks

- 是否将 `.claude/skills`、`.codex/skills` 加入一个显式 CLI 选项，还是继续只
  通过 settings `location`；两者都不能变成默认自动扫描。
- MCP OAuth/credential contract 尚未定义。当前仅支持 host 提供的 headers/
  sessionId 或外部 transport；不要复制 Prime `auth.json`。
- Declarative plugin manifest 的签名、依赖锁和 package cache 没有产品决定；
  在决定前，`plugin` source type 保持 disabled/diagnostic-only。
- Browser/LSP/database/cloud 的适配质量取决于外部 server；Nausicaa 只能
  证明边界、预算和事实记录，不能声称底层服务可用或安全。
- Skills body 是不可信内容，即使 provenance 来自受信路径；模型可能被其中
  的指令影响，故必须保留明确 untrusted framing 和用户选择步骤。
- MCP tool schema 可在 server 重启后漂移；manifest hash、generation 和
  deterministic collision 规则必须让 drift 可见，不得悄悄复用旧定义。

## S6 Handoff Checklist

- [x] 只新增本报告（及可选的同主题架构说明），未改 `src/mowe/**`、依赖或 CLI。
- [x] 所有上游主张带本地路径、revision 和许可证路径。
- [x] 明确没有 automatic installer、marketplace downloader 或 plugin runtime 已实现。
- [x] 明确 Skill/MCP 的实际导入边界、grant、snapshot、provenance 和脱敏责任。
- [x] 浏览器、LSP、数据库、云服务均给出 MCP/现有本地工具的最小接法和拒绝自研理由。
- [ ] S6 复核报告与其他 lanes 的文件所有权、beta 边界和 release 文案是否一致。
