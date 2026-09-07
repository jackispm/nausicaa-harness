# Nausicaa

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/Nausicaa-dark.svg">
    <img src="assets/Nausicaa.svg" alt="Nausicaa logo" width="160">
  </picture>
</p>

> 面向通用任务的多 Lane、多拓扑 Agent 执行运行时。
> An execution runtime for general-purpose agents that think and act as a topology.

[![CI](https://github.com/jackispm/nausicaa-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/jackispm/nausicaa-harness/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/nausicaa-harness)](https://www.npmjs.com/package/nausicaa-harness)

[中文说明](#中文说明) | [English](#english)

## 中文说明

Nausicaa 的核心不是更复杂的 workflow，而是让更强的模型自己决定何时协作。
我们认为随着模型计算更多转移到云端，未来的 Agent 将由多个不同职责、上下文和
节奏的 Lane 组成动态拓扑，而不再只是一个窗口里的线性循环。

- **Teto**：独立的感知与思考 Lane，默认按需开启，观察 Main 的公开行为并提供
  第二视角；它不执行工具，也不是隐藏的 chain-of-thought。
- **Lane**：每个 Agent 都是可寻址、可恢复、拥有独立上下文和生命周期的执行单位。
- **多拓扑**：Main、Teto、Worker、Team branch 以及跨 Run A2A 可以按任务自然组合；
  Team branch 也可以拥有自己的 Teto。
- **Host 边界**：模型负责决定协作方式，Host 只负责身份、授权、持久化和恢复等
  不可妥协的事实。

```text
Main
|- observes Teto
|- delegates Team:research
|  `- observes Teto
|- delegates Worker:tests
`- A2A -> another Run
```

当前版本：`0.1.1` beta。核心运行时有离线测试覆盖，provider、daemon、RPC 和
edge 集成仍在完善。

### 快速开始

需要 Node.js >=22.19.0。在要工作的目录启动：

```bash
npm install -g nausicaa-harness
cd /path/to/project
nausicaa
```

安装脚本和发布归档见 [Releases](https://github.com/jackispm/nausicaa-harness/releases)。
默认可使用当前用户权限执行命令和修改文件；可通过 `/permissions` 限制权限。

### 登录与模型

- `/login` 打开居中的可搜索菜单，直接选择服务商和登录方式。OpenAI API 与
  ChatGPT 订阅是不同入口；Anthropic、OpenRouter 等只显示各自支持的 API Key 或 OAuth。
- 完成登录后，凭据保存到 `~/.nausicaa/credentials.json`，下次启动可继续使用。
  浏览菜单或取消不会保存账号；本地“已配置”状态不代表远端访问已验证。
- `/model [搜索词]` 在同样居中的面板中切换当前会话模型，默认只显示已配置服务商；可筛选服务商或
  切到 All 浏览完整目录。未选择模型时，登录成功会打开对应服务商的模型列表。
- `/thinking [level|default]`（别名 `/effort`）选择当前模型支持的思考强度。
  设置随当前会话保存，从下一次 Main 请求生效，不修改 Teto 或 Worker。
- `/logout [provider]` 移除本地保存的凭据，不会删除环境变量中的密钥。

也可在终端指定登录入口；以下是可选示例，不必全部执行：

```bash
nausicaa auth login openai api-key
nausicaa auth login openai-codex oauth
nausicaa auth login openrouter api-key
```

`nausicaa config set-model <provider:model>` 保存启动默认模型；
`--provider <provider> --model <id>` 只覆盖本次运行。
`nausicaa auth status <provider>` 查看本地认证状态，`nausicaa --help` 查看完整 CLI 用法。

### 常用命令

| TUI 命令 | 用途 |
| --- | --- |
| `/help`、`/hotkeys` | 命令与当前快捷键 |
| `/list-agents` | 活跃会话与 Lane 拓扑 |
| `/new`、`/resume`、`/session` | 创建、恢复、切换会话 |
| `/name`、`/export`、`/import` | 会话命名、HTML/JSONL 导出、JSONL 导入 |
| `/skills`、`/mcp`、`/reload` | 选择 Skill、管理 MCP、刷新资源 |
| `/context`、`/compact` | 上下文用量与压缩 |
| `/permissions`、`/plan`、`/stop` | 权限、规划模式、停止当前任务 |

CLI：`--print` 单次回答，`--json` 输出事件，`--continue` 恢复最近会话，
`--resume <run-id>` 恢复指定会话，`--topology` 查看拓扑；`--daemon` 启动后台控制主机，
`--attach <run-id>` 以只读 TUI 查看 daemon 会话。

内置 `codebase-map`、`task-plan`、`code-review` 三个 Skill，项目或配置来源的同名 Skill 优先。
项目内 `.agents/skills`、`.pi/skills`、`skills` 默认发现元数据；完整内容按需加载，
也可通过 `/skills` 插入 `/skill:name` 调用。`--no-edges` 关闭 Skill 和 MCP 来源；
Worker 默认可按需委派，`--no-worker` 可禁用。

`/mcp` 用居中菜单添加 HTTP/stdio 服务、明确授权、启用、禁用或移除配置；配置变更需重启生效。
`/mcp refresh` 只刷新现有连接，`/mcp status` 查看状态。本版不提供通用 MCP OAuth。

### 开发

```bash
git clone https://github.com/jackispm/nausicaa-harness.git
cd nausicaa-harness
npm ci
npm run build
npm link
```

检查：`npm run typecheck`、`npm test`、`npm run eval`、`npm run test:smoke`。

## English

Nausicaa is deliberately not a more complicated workflow. It lets capable models
decide when to collaborate. As more model computation moves to the cloud, we
expect future Agents to form dynamic topologies of Lanes with different roles,
contexts, and cadences instead of one linear loop in one window.

- **Teto**: an independent sensing and thinking Lane, opened on demand. It
  observes Main's public behavior and offers a second perspective; it does not
  execute tools or expose hidden chain-of-thought.
- **Lane**: an addressable, resumable execution unit with its own context and
  lifecycle.
- **Multi-topology**: Main, Teto, Worker, Team branches, and cross-Run A2A can be
  composed as a task unfolds; a Team branch may own its own Teto.
- **Host boundary**: the model chooses how to collaborate; the Host owns the
  non-negotiable facts of identity, authority, durability, and recovery.

```text
Main
|- observes Teto
|- delegates Team:research
|  `- observes Teto
|- delegates Worker:tests
`- A2A -> another Run
```

Current version: `0.1.1` beta. Core runtime contracts have offline test coverage;
provider, daemon, RPC, and edge integrations are still evolving.

### Quick start

Requires Node.js >=22.19.0. Start in the directory you want to work in:

```bash
npm install -g nausicaa-harness
cd /path/to/project
nausicaa
```

Installers and archives are available in [Releases](https://github.com/jackispm/nausicaa-harness/releases).
Commands and file writes use your user permissions by default; `/permissions` can restrict access.

### Login and models

- `/login` opens a centered, searchable menu of providers and login methods.
  OpenAI API and ChatGPT subscription access are separate entries. Anthropic,
  OpenRouter, and other providers show only their supported API-key or OAuth routes.
- Successful login saves credentials in `~/.nausicaa/credentials.json` for future
  launches. Browsing or cancelling does not save an account; a local configured
  status does not verify remote access.
- `/model [search]` uses the same centered panel to switch the current session's
  model. It defaults to configured
  providers, with provider filters and an All catalog view. When no model is
  selected, successful login opens that provider's models.
- `/thinking [level|default]` (alias `/effort`) selects a level supported by the
  current model. It persists with this session and applies to the next Main
  request, without changing Teto or Worker.
- `/logout [provider]` removes a saved credential without changing environment keys.

You can also select a login route from the shell. These are alternatives:

```bash
nausicaa auth login openai api-key
nausicaa auth login openai-codex oauth
nausicaa auth login openrouter api-key
```

`nausicaa config set-model <provider:model>` saves the startup default;
`--provider <provider> --model <id>` overrides only the current run.
Use `nausicaa auth status <provider>` for local authentication status and
`nausicaa --help` for the full CLI reference.

### Useful commands

| TUI command | Purpose |
| --- | --- |
| `/help`, `/hotkeys` | Commands and active keybindings |
| `/list-agents` | Active sessions and Lane topology |
| `/new`, `/resume`, `/session` | Create, resume, and switch sessions |
| `/name`, `/export`, `/import` | Name sessions, export HTML/JSONL, import JSONL |
| `/skills`, `/mcp`, `/reload` | Choose a Skill, manage MCP, refresh resources |
| `/context`, `/compact` | Context usage and compaction |
| `/permissions`, `/plan`, `/stop` | Permissions, Plan mode, stop the current task |

CLI: `--print` returns one answer, `--json` emits events, `--continue` resumes the
latest session, `--resume <run-id>` resumes a specific session, and `--topology`
prints the topology. `--daemon` starts the control host; `--attach <run-id>` opens
a read-only TUI for a daemon session.

Three Skills are bundled: `codebase-map`, `task-plan`, and `code-review`.
Same-name project or configured Skills take precedence. Project `.agents/skills`,
`.pi/skills`, and `skills` directories are discovered as metadata by default;
full instructions load on demand, or `/skills` inserts a `/skill:name` invocation.
`--no-edges` disables Skill and MCP sources. Worker delegation is available on demand by
default; `--no-worker` disables it.

`/mcp` opens a centered menu to add HTTP/stdio servers, grant explicit access,
enable, disable, or remove configurations. Changes require a restart.
`/mcp refresh` refreshes existing connections; `/mcp status` shows status.
Generic MCP OAuth is not available in this release.

### Development

```bash
git clone https://github.com/jackispm/nausicaa-harness.git
cd nausicaa-harness
npm ci
npm run build
npm link
```

Checks: `npm run typecheck`, `npm test`, `npm run eval`, and `npm run test:smoke`.

Nausicaa uses [`pi-ai`](https://github.com/earendil-works/pi) for provider
transport and references Pi coding-agent, Prime Agent, and DeepSeek Harness for
selected boundaries. Teto, Lane topology, and Host-owned durability are Nausicaa's
own runtime contracts.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR. Report security issues
through [SECURITY.md](SECURITY.md). Nausicaa is released under the [MIT License](LICENSE);
third-party notices are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
