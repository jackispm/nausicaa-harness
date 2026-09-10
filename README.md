# Nausicaa

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/Nausicaa-dark.svg">
    <img src="assets/Nausicaa.svg" alt="Nausicaa logo" width="160">
  </picture>
</p>

> 面向通用任务的下一代 Agent，以多 Lane、多拓扑支持协作。
> A next-generation general-purpose agent built around collaborating Lanes.

[![CI](https://github.com/jackispm/nausicaa-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/jackispm/nausicaa-harness/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/nausicaa-harness)](https://www.npmjs.com/package/nausicaa-harness)

[中文说明](#中文说明) | [English](#english)

## 中文说明

Nausicaa 让模型在不同职责、上下文和节奏的 Lane 之间协作，按任务组织动态拓扑。
根 Agent 的对外身份是 **Nausicaa**，本 Run 内的公开 A2A 地址为 `nausicaa`。
团队成员使用自己的名字；辅助观察者的身份是 **Teto**。

- **Teto**：默认开启的辅助观察 Lane，只观察订阅到的部分行为，关注用户意图偏离
  和可改进的方案；默认不打扰所属 Agent，仅在新的高价值建议能影响
  下一步决策时主动通过 A2A 提醒。
  所属 Agent 可通过已授权的控制工具关闭或重新开启 Teto。
- **Lane**：每个 Agent 都是可寻址、可恢复、拥有独立上下文和生命周期的执行单位。
- **多拓扑**：主 Agent、Teto、Worker、Team member 以及跨 Run A2A 可以按任务自然组合；
  Team member 也可以按需开启自己的 Teto。
- **Host 边界**：模型负责决定协作方式，Host 只负责身份、授权、持久化和恢复等
  不可妥协的事实。

```text
Nausicaa (lane: nausicaa)
|- Teto (observes Nausicaa)
|- Team research (lead: Nausicaa)
|  |- researcher
|  |  `- Teto (observes researcher)
|  `- reviewer
|- worker 1 (delegated task)
`- A2A <-> another Run
```

创建团队时，主管可用 `members[].memberId` 命名成员，例如 `researcher`、`reviewer`。
未命名的成员默认使用 `worker-1`、`worker-2` 等标识，显示为 `worker 1`、`worker 2`。
不同团队可以重名，发 A2A 消息时应使用工具返回的完整 `laneId`。
Team 的主管由实际创建它的 lane 决定，负责汇总和判断结果。
详见 [Team 协作合同](docs/team-collaboration.md)。

主管无需为成员填写 token 预算、轮数或总时长限制。新任务也没有隐藏的“两轮结束”
或“30 分钟截止”默认值。交互会话保持打开时，主管可以先结束当前轮次；成员继续工作，
结果返回后主管自动继续协调。关闭会话或取消任务会停止相关工作。

当前版本：`0.1.4` beta。核心运行时有离线测试覆盖，provider、daemon、RPC 和
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

`/login`、`/model`、`/mcp`、`/skills` 进入同一个淡粉色全屏配置页的对应分页。
Ctrl+Left/Right 切页时保留搜索、选择和 MCP 草稿；聊天内容暂时隐藏，退出后恢复。

- `/login` 直接选择服务商和登录方式。OpenAI API 与
  ChatGPT 订阅是不同入口；Anthropic、OpenRouter 等只显示各自支持的 API Key 或 OAuth。
- 完成登录后，凭据保存到 `~/.nausicaa/credentials.json`，下次启动可继续使用。
  浏览菜单或取消不会保存账号；本地“已配置”状态不代表远端访问已验证。
- `/model [搜索词]` 在同样居中的面板中切换当前会话模型，默认只显示已配置服务商；可筛选服务商或
  切到 All 浏览完整目录。未选择模型时，登录成功会打开对应服务商的模型列表。
- `/thinking [level|default]`（别名 `/effort`）选择当前模型支持的思考强度。
  每档附有说明，选择后模型旁显示 `模型名 • medium` 等标记。
  设置随当前会话保存，从下一次 Nausicaa 请求生效，不修改 Teto 或 Worker；
  `default` 使用服务商默认值，不把所有模型的默认值假定为 medium。
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
| `/clear`、`/clone` | 新会话别名、从当前检查点克隆会话 |
| `/name`、`/export`、`/import` | 会话命名、HTML/JSONL 导出、JSONL 导入 |
| `/skills`、`/mcp`、`/reload` | 选择 Skill、管理 MCP、刷新资源 |
| `/context`、`/compact` | 上下文用量与压缩 |
| `/permissions`、`/plan`、`/stop` | 权限、规划模式、停止当前任务 |
| `/settings`、`/system-prompt`、`/logs`、`/traces` | 会话设置、实际系统提示词、日志位置、本地 Run 事件与指标 |
| `/btw <问题>`（`/side`） | 当前会话的无工具侧问，不写入主对话；用量计入预算 |
| `/changelog`、`/update` | 版本记录、更新安装包（完成后重启） |

CLI：`--print` 单次回答，`--json` 输出事件，`--continue` 恢复最近会话，
`--resume <run-id>` 恢复指定会话，`--topology` 查看拓扑；`--daemon` 启动后台控制主机，
`--attach <run-id>` 以只读 TUI 查看 daemon 会话。

### Teto 与 Skills

新 Run 默认开启 Teto，交互会话和 `--print`、`--json` 使用相同的观察者机制。
你可以让主 Agent 关闭或重启 Teto，由它调用 `teto_stop`、`teto_start`；关闭决定在
同一 Run 的重启和恢复后仍然有效。Plan 模式保留只读边界，不提供启停工具。
创建新 Run 时可用 `nausicaa --main-only` 或配置 `tetoEnabled: false` 禁用 Teto。
Worker 默认可按需委派，`--no-worker` 可禁用。

Teto 订阅 `user.message`、`assistant.message` 和 `tool.requested` 的公开投影，
因此看到的是部分行为，不是所属 Agent 的完整上下文。它辅助检查是否偏离用户意图，
以及当前方案是否存在明显不足或更好的做法。所属 Agent 可以是根
Nausicaa，也可以是有自己名字的团队成员。

Teto 默认对所属 Agent 保持沉默，但可以在自己的对话记录中记下简短观察。
只有新的高价值建议时，它才主动发 A2A；直接收到 A2A 协作请求时，可以作实质性答复。
订阅内容是观察资料，不是交给 Teto 执行的用户任务。

内置 `codebase-map`、`task-plan`、`code-review` 三个 Skill，项目或配置来源的同名 Skill 优先。
默认发现项目内 `.agents/skills`、`.pi/skills`、`skills`；不会自动扫描
`~/.agents/skills` 或 `~/.codex/skills`。添加项目 Skill 时可使用
`.agents/skills/<name>/SKILL.md`。

主 Agent 的上下文自动包含技能名称和描述，任务匹配时通过 `skill` 工具加载正文，
再按需读取引用文件。加载结果提供技能目录，作为脚本和资源相对路径的基准。
也可通过 `/skills` 插入 `/skill:name` 显式使用。`/system-prompt` 只显示系统提示词，
不包含动态的技能目录；可用 `/skills` 查看发现结果。`--no-edges` 关闭 Skill 和 MCP 来源。

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

Nausicaa lets models collaborate across Lanes with different roles, contexts,
and cadences, organizing their topology around the task. The root Agent's public
identity is **Nausicaa**, with the public in-Run A2A address `nausicaa`. Team members
use their own names; the auxiliary observer's identity is **Teto**.

- **Teto**: an auxiliary observer enabled by default. It follows subscribed
  portions of its owner's activity, watching for intent drift and improvements
  to the current solution. It is quiet toward its owner
  by default, sending unsolicited A2A advice only when new, high-value guidance
  could affect the next decision. Its owner may stop or restart it
  through the authorized controls.
- **Lane**: an addressable, resumable execution unit with its own context and
  lifecycle.
- **Multi-topology**: the primary Agent, Teto, Worker, Team members, and cross-Run
  A2A can be composed as a task unfolds; a Team member may start its own Teto.
- **Host boundary**: the model chooses how to collaborate; the Host owns the
  non-negotiable facts of identity, authority, durability, and recovery.

```text
Nausicaa (lane: nausicaa)
|- Teto (observes Nausicaa)
|- Team research (lead: Nausicaa)
|  |- researcher
|  |  `- Teto (observes researcher)
|  `- reviewer
|- worker 1 (delegated task)
`- A2A <-> another Run
```

The lead can name members through `members[].memberId`, for example `researcher`
or `reviewer`. Unnamed members receive IDs such as `worker-1` and `worker-2`,
displayed as `worker 1` and `worker 2`. Names may repeat across Teams; use the
full `laneId` returned by the tools for A2A messages. A Team's actual creating
lane is its lead and owns synthesis and acceptance.
See the [Team collaboration contract](docs/team-collaboration.md).

Members start with independent contexts and, by default, inherit the Team
Lead's host-authorized workspace tool catalog. The lead can narrow a member
with `members[].capabilities.tools` and allow or deny nested Team creation with
`members[].capabilities.allowNestedTeam`; these are enforced permissions, not
prompt text. Nested Teams are limited to depth three. A member uses
`team_message` for its parent Team channel and `child_team_message` for a
nested Team channel.

The lead does not assign token, call-count, or duration budgets to members. New
tasks also have no implicit two-call or 30-minute cutoff. In an open interactive
session, the lead may finish its current turn while members keep working;
durable reports automatically resume coordination. Session closure or task
cancellation stops the corresponding work.

Current version: `0.1.4` beta. Core runtime contracts have offline test coverage;
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

`/login`, `/model`, `/mcp`, and `/skills` open their tab in one pale-pink,
full-screen configuration workspace. Ctrl+Left/Right switches tabs without losing
searches, selections, or MCP drafts. The conversation is hidden until you leave.

- `/login` lists providers and their supported login methods.
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
  current model, with descriptions for each level and a `model • medium` label
  after selection. It persists with this session and applies to the next Nausicaa
  request, without changing Teto or Worker. `default` retains the provider default;
  it does not assume every model defaults to medium.
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
| `/clear`, `/clone` | New-session alias, clone the current checkpoint |
| `/name`, `/export`, `/import` | Name sessions, export HTML/JSONL, import JSONL |
| `/skills`, `/mcp`, `/reload` | Choose a Skill, manage MCP, refresh resources |
| `/context`, `/compact` | Context usage and compaction |
| `/permissions`, `/plan`, `/stop` | Permissions, Plan mode, stop the current task |
| `/settings`, `/system-prompt`, `/logs`, `/traces` | Session settings, effective system prompt, log locations, local Run events and metrics |
| `/btw <question>` (`/side`) | Tool-free side question on the attached session; separate transcript, shared budget |
| `/changelog`, `/update` | Release notes, update the installation (then restart) |

CLI: `--print` returns one answer, `--json` emits events, `--continue` resumes the
latest session, `--resume <run-id>` resumes a specific session, and `--topology`
prints the topology. `--daemon` starts the control host; `--attach <run-id>` opens
a read-only TUI for a daemon session.

### Teto and Skills

New Runs start Teto by default. Interactive sessions, `--print`, and `--json`
use the same observer mechanism. Ask the primary Agent to stop or restart Teto
using `teto_stop` or `teto_start`; a stop remains effective when the same Run
restarts or resumes. Plan mode retains its read-only boundary and omits these
controls. To disable Teto when creating a Run, use `nausicaa --main-only` or set
`tetoEnabled: false`. Worker delegation is available on demand by default;
`--no-worker` disables it.

Teto receives public projections of subscribed `user.message`, `assistant.message`,
and `tool.requested` events, giving it a partial view of its owner's activity.
It watches for deviations from user intent and improvements to the current
solution. Its owner can be the root Nausicaa
or a Team member with its own name.

Teto stays quiet toward its owner by default and may keep brief observations
in its own transcript. It sends unsolicited A2A advice only when it has new,
high-value guidance. It may also give substantive replies to direct A2A
coordination requests. Subscribed content is observation material, not
a user task assigned to Teto.

Three Skills are bundled: `codebase-map`, `task-plan`, and `code-review`.
Same-name project or configured Skills take precedence. Discovery includes
project `.agents/skills`, `.pi/skills`, and `skills` directories. It does not
automatically scan `~/.agents/skills` or `~/.codex/skills`. Add project Skills at
`.agents/skills/<name>/SKILL.md`.

The primary Agent's context includes Skill names and descriptions. For matching
tasks, it uses `skill` to load instructions and then any referenced text files
it needs. Loaded results include the Skill directory for resolving script and
resource paths. `/skills` can also insert an explicit `/skill:name` invocation.
`/system-prompt` shows system text rather than the dynamic Skill catalog; use
`/skills` to inspect discovery. `--no-edges` disables Skill and MCP sources.

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
