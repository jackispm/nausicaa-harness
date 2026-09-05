# Nausicaa

> 面向通用任务的多 Lane、多拓扑 Agent 执行运行时。
> An execution runtime for general-purpose agents that think and act as a topology.

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

凭据也可以通过 `nausicaa auth login` 或 TUI 的 `/login` 保存。

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

Credentials can also be saved with `nausicaa auth login` or the TUI `/login` command.

Development checks: `npm run typecheck`, `npm test`, `npm run test:smoke`, and
`npm run build`.

Nausicaa uses [`pi-ai`](https://github.com/earendil-works/pi) for provider
transport and references Pi coding-agent, Prime Agent, and DeepSeek Harness for
selected boundaries. Teto, Lane topology, and Host-owned durability are Nausicaa's
own runtime contracts.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR. Report security issues
through [SECURITY.md](SECURITY.md). Nausicaa is released under the [MIT License](LICENSE);
third-party notices are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
