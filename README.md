# Nausicaa

> 面向通用任务的多 Lane、多拓扑 Agent 运行时。
> A general-purpose Agent runtime built from multiple Lanes and dynamic topologies.

[![CI](https://github.com/jackispm/nausicaa-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/jackispm/nausicaa-harness/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/nausicaa-harness)](https://www.npmjs.com/package/nausicaa-harness)
[![Release](https://img.shields.io/github/v/release/jackispm/nausicaa-harness)](https://github.com/jackispm/nausicaa-harness/releases)

[中文](#中文) | [English](#english)

## 中文

Nausicaa 把一次 Agent 执行看成一个由多个 Lane 组成的动态拓扑，而不是一个固定的线性循环。模型可以按任务需要决定何时观察、并行、委派或跨 Run 协作；Host 负责守住身份、权限、持久化和恢复这些事实边界。

### 核心抽象

- **Teto**：独立的感知与思考 Lane，按需由 Main 开启。它只观察 Main 的公开行为，不执行工具，也不暴露隐藏思维链。
- **Lane**：每个执行单位拥有独立上下文、生命周期和地址，可暂停、恢复和单独审计。
- **多拓扑**：Main、Teto、Worker、Team branch 和跨 Run A2A 可以组合；Team branch 也可以拥有自己的 Teto。
- **Durable Run**：Ledger 记录请求、准入、执行和终态；daemon、resume、fork 和远程 attach 都围绕同一份可恢复状态工作。

```text
Main
|- observes Teto
|- delegates Team:research
|  `- observes Teto
|- delegates Worker:tests
`- A2A -> another Run
```

当前版本为 `0.1.0` beta，面向通用任务，不限定为长期软件工程。核心运行时有离线测试覆盖；provider、daemon、RPC 和 edge 集成仍在演进。

### 安装与开始

安装 npm CLI：

```bash
npm install -g nausicaa-harness
nausicaa --help
```

macOS/Linux 一键安装：

```bash
curl -fsSL https://github.com/jackispm/nausicaa-harness/releases/latest/download/install.sh | sh
```

Windows PowerShell：

```powershell
irm https://github.com/jackispm/nausicaa-harness/releases/latest/download/install.ps1 | iex
```

需要 Node.js `>=22.19.0`。每个版本发布页还提供 npm tarball、源码归档和 `SHA256SUMS`。

从源码运行：

```bash
git clone https://github.com/jackispm/nausicaa-harness.git
cd nausicaa-harness
npm ci
npm run build
npm link

export OPENROUTER_API_KEY="..."
export NAUSICAA_MODEL="openrouter:openai/gpt-5-mini"
nausicaa "Summarize this workspace"
```

凭据可以用 `nausicaa auth login` 或 TUI 的 `/login` 保存；`nausicaa config set-model <provider:model>` 可以保存用户级默认模型。

### 常用入口

CLI：`--print`、`--json`、`--topology`、`--worker`、`--daemon`、`--daemon-worker-command <path>`、`--attach <run-id>`、`--resume <run-id>`。

TUI：`/list-agents`、`/permissions`、`/plan`、`/skills`、`/edges`、`/goal`、`/compact`、`/tree`、`/resume`、`/stop` 和 `/quit`。

### 权限边界

Nausicaa 会按当前 capability profile 执行模型请求的工具。它不是用来运行不受信任代码的安全沙箱；在重要目录中运行前，请审查模型、提示词、工具权限和待应用的变更。需要更严格的边界时，使用 `/permissions` 切换 profile，或在隔离的 checkout/worktree 中运行。

## English

Nausicaa treats an Agent run as a dynamic topology of Lanes rather than one fixed linear loop. The model can decide when to observe, fan out, delegate, or collaborate across Runs; the Host keeps identity, permissions, durability, and recovery as explicit facts.

### Core abstractions

- **Teto**: an independent sensing and thinking Lane that Main can open when useful. It observes Main's public behavior, does not execute tools, and does not expose hidden chain-of-thought.
- **Lane**: an addressable execution unit with its own context and lifecycle; it can be paused, resumed, and audited independently.
- **Multi-topology**: Main, Teto, Worker, Team branches, and cross-Run A2A compose as the task evolves; a Team branch may own its own Teto.
- **Durable Run**: a Ledger records request, admission, execution, and terminal facts. Daemon operation, resume, fork, and remote attach use the same recoverable state.

```text
Main
|- observes Teto
|- delegates Team:research
|  `- observes Teto
|- delegates Worker:tests
`- A2A -> another Run
```

The current release is `0.1.0` beta. Nausicaa is for general-purpose tasks, not only long-running software engineering. Core runtime contracts have offline test coverage; provider, daemon, RPC, and edge integrations are still evolving.

### Install and start

Install the npm CLI:

```bash
npm install -g nausicaa-harness
nausicaa --help
```

One-line install on macOS/Linux:

```bash
curl -fsSL https://github.com/jackispm/nausicaa-harness/releases/latest/download/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/jackispm/nausicaa-harness/releases/latest/download/install.ps1 | iex
```

Node.js `>=22.19.0` is required. Each release also includes the npm tarball, a clean source archive, and `SHA256SUMS`.

Run from source:

```bash
git clone https://github.com/jackispm/nausicaa-harness.git
cd nausicaa-harness
npm ci
npm run build
npm link

export OPENROUTER_API_KEY="..."
export NAUSICAA_MODEL="openrouter:openai/gpt-5-mini"
nausicaa "Summarize this workspace"
```

Save credentials with `nausicaa auth login` or the TUI `/login` command. Save a user-level default model with `nausicaa config set-model <provider:model>`.

### Useful entry points

CLI: `--print`, `--json`, `--topology`, `--worker`, `--daemon`, `--daemon-worker-command <path>`, `--attach <run-id>`, and `--resume <run-id>`.

TUI: `/list-agents`, `/permissions`, `/plan`, `/skills`, `/edges`, `/goal`, `/compact`, `/tree`, `/resume`, `/stop`, and `/quit`.

### Trust boundary

Nausicaa executes model-requested tools according to the active capability profile. It is not a security sandbox for untrusted code or instructions; review the model, prompts, permissions, and proposed changes before running in an important directory. Use `/permissions` to change the profile, or run in a disposable checkout/worktree when a stricter boundary is needed.

## Releases and development

Tagged releases are published at [GitHub Releases](https://github.com/jackispm/nausicaa-harness/releases). A release tag runs the test gate and uploads the npm tarball, source archive, platform installer scripts, and checksums.

Development checks:

```bash
npm run typecheck
npm test
npm run eval
npm run test:smoke
npm run build
```

Nausicaa uses [`pi-ai`](https://github.com/earendil-works/pi) for provider transport and adopts selected boundaries from Pi coding-agent, Prime Agent, and DeepSeek Harness. Teto, Lane topology, and Host-owned durability are Nausicaa runtime contracts.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR. Report vulnerabilities through [SECURITY.md](SECURITY.md). Nausicaa is released under the [MIT License](LICENSE); third-party notices are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
