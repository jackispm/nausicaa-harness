# Nausicaa

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

当前版本：`0.1.0` beta。核心运行时有离线测试覆盖，provider、daemon、RPC 和
edge 集成仍在完善。

### 快速开始

已发布包（全局 CLI）：

```bash
npm install -g nausicaa-harness
nausicaa --help
```

模型与 provider：

Nausicaa 默认加载 `pi-ai` 的完整 provider/model 目录，OpenRouter 只是其中一个选项。
使用 `/login` 查看服务商及认证状态，选择 API key 或浏览器/设备 OAuth。
`/model` 默认显示已配置服务商的模型，支持搜索、服务商筛选和显式浏览全部目录；
选择尚未配置的模型会引导登录。非交互命令可用
`--provider <provider> --model <id>`，也兼容 `provider:model` 选择器。

```bash
# OpenAI
export OPENAI_API_KEY="..."
export NAUSICAA_MODEL="openai:gpt-5.4"

# Anthropic (API key or /login anthropic oauth)
export ANTHROPIC_API_KEY="..."
export NAUSICAA_MODEL="anthropic:claude-sonnet-4-5"

# OpenRouter (one of the available providers)
export OPENROUTER_API_KEY="..."
export NAUSICAA_MODEL="openrouter:openai/gpt-5-mini"
```

凭据也可以通过 `nausicaa auth login <provider> [api-key|oauth]` 或 TUI 的 `/login` 保存。
`nausicaa auth status <provider>` 只显示本地配置状态，不会验证或打印密钥。
尚未选择模型时，登录后会打开该 provider 的模型列表；`/logout` 选择并移除本地保存的凭据，不删除环境变量。

源码开发：

```bash
git clone https://github.com/jackispm/nausicaa-harness.git
cd nausicaa-harness
npm ci
npm run build
npm link

export OPENAI_API_KEY="..."
export NAUSICAA_MODEL="openai:gpt-5.4"
nausicaa "Summarize this workspace"
```

项目内的 `.agents/skills`、`.pi/skills` 和 `skills` 目录会默认进行元数据发现；首轮只向模型提供 Skill 名称和描述，完整 `SKILL.md` 由模型按需通过 `skill` 工具加载。MCP 等外部 Edge 仍需显式配置和授权，并通过配置或 `--edges` 开启；`--no-edges` 会关闭本地 Skill 发现。

常用入口：`--print`、`--json`、`--topology`、`--worker`、`--daemon`、
`--daemon-worker-command <path>`、`--attach <run-id>`；TUI 提供
`/model`、`/login`、`/logout`、`/list-agents`、`/permissions`、`/plan`、
`/skills` 和 `/edges`。

开发检查：`npm run typecheck`、`npm test`、`npm run test:smoke`、`npm run build`。

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

Current version: `0.1.0` beta. Core runtime contracts have offline test coverage;
provider, daemon, RPC, and edge integrations are still evolving.

### Quick start

Published package (global CLI):

```bash
npm install -g nausicaa-harness
nausicaa --help
```

Model and provider setup:

Nausicaa loads the complete `pi-ai` provider/model catalog by default; OpenRouter is
one option among many. Use `/login` to view provider authentication status and
connect with an API key or browser/device OAuth. `/model` defaults to configured
providers, with search, provider filtering, and an explicit all-catalog view.
Selecting an unconfigured model starts login. Non-interactive runs accept
`--provider <provider> --model <id>` as well as the `provider:model` selector form.

```bash
# OpenAI
export OPENAI_API_KEY="..."
export NAUSICAA_MODEL="openai:gpt-5.4"

# Anthropic (API key or /login anthropic oauth)
export ANTHROPIC_API_KEY="..."
export NAUSICAA_MODEL="anthropic:claude-sonnet-4-5"

# OpenRouter (one available provider)
export OPENROUTER_API_KEY="..."
export NAUSICAA_MODEL="openrouter:openai/gpt-5-mini"
```

Credentials can also be saved with `nausicaa auth login <provider> [api-key|oauth]`
or the TUI `/login` command. `nausicaa auth status <provider>` reports local
configuration only; it never verifies or prints a key.
When no model is selected, login opens that provider's model list. `/logout`
lets you choose a saved credential to remove; environment variables are unchanged.

Source checkout:

```bash
git clone https://github.com/jackispm/nausicaa-harness.git
cd nausicaa-harness
npm ci
npm run build
npm link

export OPENAI_API_KEY="..."
export NAUSICAA_MODEL="openai:gpt-5.4"
nausicaa "Summarize this workspace"
```

Project-local `.agents/skills`, `.pi/skills`, and `skills` directories are discovered by default at metadata level. The first request receives only Skill names and descriptions; the full `SKILL.md` is loaded on demand through the `skill` tool. External edges such as MCP still require explicit configuration and authorization, and are enabled through settings or `--edges`; `--no-edges` disables local Skill discovery.

Common entry points are `--print`, `--json`, `--topology`, `--worker`, `--daemon`,
`--daemon-worker-command <path>`, and `--attach <run-id>`. The TUI includes
`/model`, `/login`, `/logout`, `/list-agents`, `/permissions`, `/plan`,
`/skills`, and `/edges`.

Development checks: `npm run typecheck`, `npm test`, `npm run test:smoke`, and
`npm run build`.

Nausicaa uses [`pi-ai`](https://github.com/earendil-works/pi) for provider
transport and references Pi coding-agent, Prime Agent, and DeepSeek Harness for
selected boundaries. Teto, Lane topology, and Host-owned durability are Nausicaa's
own runtime contracts.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR. Report security issues
through [SECURITY.md](SECURITY.md). Nausicaa is released under the [MIT License](LICENSE);
third-party notices are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
