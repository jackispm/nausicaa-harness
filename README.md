# Nausicaa

> 面向通用任务、多 Lane、多拓扑 Agent 的执行运行时。
> An execution runtime for general-purpose agents that think and act as a topology.

[中文说明](#中文说明) | [English](#english)

## 中文说明

Nausicaa 是一个面向通用任务的 Agent runtime。任务可以是代码、研究、文档、数据
处理，或任何需要多步协作的自动化工作。它保留熟悉的单 Agent coding loop，同时
把 Agent 组织成可寻址、可恢复、可观察的多条 Lane。

> **状态：** `0.1.0` beta。核心运行时合同有离线测试覆盖；provider、daemon、
> RPC 和 edge 集成仍在持续收口，命令行和嵌入式 API 可能在 `1.0` 前变化。

### 我们的判断

我们相信 LLM 的智能会持续提高，越来越多的模型计算会在云端完成。我们的判断是，
未来的 Agent 将天然具有多拓扑结构：它不应永远是一个窗口、一个上下文、一个固定
的线性流程，而应当是多个具有不同职责、上下文和节奏的 Agent，通过明确关系组成
一个动态拓扑。

因此 Nausicaa 采取几个简单的立场：

- **把决策权留给模型。** 模型足够强时，运行时没有必要把每一个判断预先写成
  复杂的工作流、路由规则或提示词约束。Main 可以判断什么时候需要第二条思路、
  什么时候拆分任务、什么时候合并结果。
- **保留少量不可妥协的运行时事实。** 身份、授权、资源归属、持久化、恢复、
  成本和时间边界必须由 Host 负责。这些边界保护的是副作用和责任，不是替模型
  思考。
- **让计算可以分布，让状态保持可靠。** 模型调用可以在云端，Lane 可以并行；
  Host 负责 durable Ledger、artifact、权限、拓扑和恢复，使 Agent 不会因为
  一个进程或一个网络连接消失就丢失工作状态。
- **拓扑应当动态而不是固定。** 树形父子关系只是起点。一个 Run 可以拥有
  Main、Teto、Team 和 Worker；Team branch 可以拥有自己的 Teto；不同 Run 之间
  也可以通过受 Host 授权的 A2A 路由通信。

这也是我们对“更聪明的 Agent”系统的取舍：减少过度规定行为的代码，增加能够
让模型自由协作、同时让结果可追踪和可恢复的基础设施。通用任务仍然从简单的
Main-only 路径开始；只有任务需要时，拓扑才会展开。

### Teto：独立的感知与思考 Lane

Teto 是 Nausicaa 的核心差异。它不是藏在 Main prompt 里的另一段指令，也不是
把隐藏 chain-of-thought 暴露出来的接口；它是一条拥有独立身份和生命周期的
observation lane。

- 新 Run 默认让 Teto 作为可用能力保持 dormant，由 Main 或 Host 策略决定是否
  打开，而不是强制每个任务都多跑一个模型。是否开启是运行时能力选择，不是写死
  在 prompt 里的流程。
- Main 可以使用 `teto_start`、`teto_stop`、`teto_status` 控制 Teto，也可以在
  任务中完全不启动它。
- Teto 接收用户可见的输入、Main 输出、工具请求及其参数；不会接收 Main 的
  私有上下文或完整工具结果。
- Teto 有自己的上下文、预算、事件和状态，可以通过受控的 A2A voice 向 Main
  发送观察、疑问和风险信号。
- Teto 不修改工作区，也不直接执行工具。它的价值在于独立视角、矛盾检测、
  风险提示和导航，而不是替 Main 再执行一遍相同流程。
- 每个 Team branch 都可以拥有自己的 Teto。Teto 因此不是单一的全局监督者，
  而是可以随着拓扑一起生长的 Lane。

Teto 的节奏也可以独立于 Main：它可以稀疏运行、在安全边界交付建议，或者只在
Main 明确需要时启动。这让第二条思路成为一种可组合的能力，而不是固定税收。

### Lane：Agent 的可寻址执行单位

Lane 不只是线程名或 UI 标签。每条 Lane 都有 Host 管理的身份，以及自己的：

- 上下文投影和可见性；
- 模型预算、时间和取消边界；
- Ledger 事件、artifact 引用和恢复位置；
- Inbox、A2A 关系和生命周期状态；
- 能力清单，而不是一份可以自行扩权的工具列表。

当前主要 Lane 包括：

| Lane | 职责 |
| --- | --- |
| **Main** | 接收用户任务、选择行动、调用工具并产出最终结果。 |
| **Teto** | 观察 Main 的公开表面，提供独立意见和风险信号。 |
| **Worker** | 由 `--worker` 显式启用的有界、任务级 delegated lane。 |
| **Team** | 由 Main 创建的多个独立 branch；每个 branch 有自己的上下文和结果。 |

Lane 的边界让我们不必把所有协作逻辑塞进一个超长 prompt。模型可以自由判断，
Host 仍然知道“谁在做什么、谁授权了什么、结果在哪里、失败后如何继续”。

### 多拓扑：未来 Agent 的组织方式

Nausicaa 不把 Agent 假设成一个固定的主从树，而是把拓扑作为运行时的一等事实。
关系由 Host 创建和校验，例如 `owns`、`observes`、`delegates`、`member-of`
和受控的 `peer`/`direct` A2A 路由。

一个 Run 可以呈现为：

```text
Main
├─ observes   Teto
├─ delegates  Team:research
│              └─ observes   Team:research:Teto
├─ delegates  Worker:tests
└─ A2A/direct Main@another-Run
```

这不是要求每个任务都创建完整图，而是让系统能够在任务需要时自然展开。拓扑
投影、Lane manifest 和 A2A receipt 使这种协作可见、可审计、可恢复；模型不需要
也不能伪造另一个 Lane 的身份或权限。

当未来的模型调用主要发生在云端时，Host 更像一个 durable control plane：
它不限制每个模型应该如何思考，而是记录拓扑、授予能力、保存证据，并在网络或
进程中断后恢复正确的边界。

### 运行时分层

```text
L0  Provider-neutral agent loop
    streaming · tool calls · bounded parallelism · abort · usage

L1  Durable Run runtime
    Ledger · artifacts · permissions · retry · checkpoint · recovery

L2  Lane topology
    Main · Teto · Worker · Team · A2A · awareness · daemon
```

简单的 Main-only 任务仍然是简单路径，不需要 Teto、Team、Fukai、A2A 或常驻
daemon。复杂拓扑是能力，而不是每次运行的仪式。

### Durable Run 与恢复

每个 Run 都有 JSONL Ledger 和 content-addressed artifact store。Ledger 保存用户
输入、模型请求、Lane 状态、工具生命周期、A2A 消息、checkpoint 和恢复事实。
工具副作用遵循：

```text
requested -> admitted -> started -> terminal
```

每个 operation 有稳定身份和幂等键。进程在外部副作用之后中断时，恢复逻辑会保留
`unknown` 状态，而不是猜测成功并重复执行。`/resume`、`--resume <run-id>` 和
`/fork` 用于继续或从已提交 checkpoint 创建独立 Run。

Fukai 是上下文边界和可选的 compaction capsule，不替代 Ledger。普通交互不会
静默创建持久 Goal；需要长期目标时使用 `/goal` 显式管理。

### 权限与能力

授权由 Host runtime 管理，而不是由 prompt 文字授予：

- `read-only`：只读检查；
- `workspace`：在当前工作区内进行受控修改，并使用 OS sandbox；
- `full-access`：普通交互会话的完整能力，默认配置。

遇到权限或外层 OS 拒绝时，交互 TUI 会显示权限申请；批准后才会切换到更高
能力并重试一次。`--print` 和 `--json` 没有交互式申请，会以结构化错误失败。
`workspace` profile 会保护 `.git` 写入；需要 `git add` 或 `git commit` 时使用
`/permissions full-access` 或 `--allow-shell`。

### 快速开始

要求：Node.js `>=22.19.0`。

```bash
git clone https://github.com/jackispm/nausicaa-harness.git
cd Nausicaa
npm ci
npm run build
npm link
```

使用环境变量配置模型：

```bash
export OPENROUTER_API_KEY="..."
export NAUSICAA_MODEL="openrouter:openai/gpt-5-mini"
nausicaa "Inspect this project and explain how to run it"
```

也可以保存本地凭据：

```bash
nausicaa auth login
nausicaa auth status
```

凭据只保存到本地 credential store，TUI 的 `/login`、`/logout` 与 CLI 共用；界面
只显示脱敏状态，不会把 key 写入 Run transcript。

### 常用运行方式

```bash
# 脚本和 CI
nausicaa --print "Summarize the package scripts"
nausicaa --json "Check the repository status"

# 多 Lane
nausicaa --worker "Break this migration into bounded implementation tasks"
nausicaa --teto-model openrouter:openai/gpt-5-mini
nausicaa --main-only "Run without the Teto lane"

# daemon 与只读拓扑
nausicaa --daemon
nausicaa --topology --print
```

交互命令：

```text
/login, /logout                管理本地 provider 凭据
/model                         选择模型
/list-agents                   查看 Agent Family 和拓扑
/goal                          管理可选的持久 Goal
/resume, /fork, /tree          导航 Run 与 checkpoint
/permissions, /plan            调整权限和执行模式
/compact                       创建已验证的上下文 capsule
! <command>                    执行 Bash，并把有界输出放入下一次上下文
!! <command>                   执行 Bash，但不放入模型上下文
```

### 开发与参考

```bash
npm ci
npm run typecheck
npm test
npm run eval
npm run test:smoke
npm run build
```

`npm run check` 是标准离线门禁；需要真实 provider 的评估不会进入默认测试。

Nausicaa 使用 [`pi-ai`](https://github.com/earendil-works/pi) 作为 provider
transport，并参考 Pi coding-agent 的单 Lane 行为构建 L0；会话和长期 Agent
语义参考 Prime Agent；模块化 edge 边界参考 DeepSeek Harness。Ledger、Teto、
Lane topology 和 Host-owned permissions 是 Nausicaa 自己的运行时合同。

请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 后再提交 PR。安全问题请按
[SECURITY.md](SECURITY.md) 报告。

## English

Nausicaa is an execution runtime for general-purpose tasks. A task may involve
code, research, documents, data processing, or any multi-step automation. It
keeps the familiar single-agent coding loop, then makes agents addressable,
resumable, and observable as independent Lanes in a durable topology.

> **Status:** `0.1.0` beta. The core runtime contracts are covered by offline
> tests. Provider, daemon, RPC, and edge integrations are still being closed
> out, and the CLI and embedding APIs may change before `1.0`.

### Our thesis

We expect LLM capability to keep increasing while more model computation moves
to the cloud. Our bet is that future Agents will naturally be multi-topological.
That changes the natural shape of an Agent: it should not remain one window, one
context, and one fixed linear workflow forever. It should be a dynamic topology
of agents with different responsibilities, contexts, and cadences, connected by
explicit relationships.

Nausicaa follows a few simple principles:

- **Leave decisions to the model.** As models become more capable, there is less
  value in encoding every judgment as a workflow, router rule, or prompt
  constraint. Main can decide when it needs another line of thought, when to
  split a task, and when to join results.
- **Keep a small set of non-negotiable runtime facts.** Identity, authority,
  ownership, durability, recovery, cost, and time limits belong to the Host.
  These boundaries protect side effects and accountability; they do not replace
  model reasoning.
- **Distribute compute while keeping state reliable.** Model calls may run in
  the cloud and Lanes may run in parallel. The Host owns the durable
  Ledger, artifacts, permissions, topology, and recovery, so a lost process or
  network connection does not erase the work state.
- **Make topology dynamic, not predetermined.** A parent-child tree is only a
  starting point. A Run can own Main, Teto, Team, and Worker lanes; a Team branch
  can own its own Teto; and separate Runs can communicate over Host-authorized
  A2A routes.

The result is a deliberate trade: less code that prescribes behavior, more
infrastructure that lets capable models collaborate freely while keeping work
traceable and recoverable. A general-purpose task still starts on the simple
Main-only path; the topology expands only when the task calls for it.

### Teto: an independent sensing and thinking Lane

Teto is Nausicaa's central differentiator. It is not another hidden instruction
inside Main's prompt, and it is not an interface for exposing hidden
chain-of-thought. It is an observation Lane with its own identity and lifecycle.

- A new Run exposes Teto as an available capability but leaves it dormant by
  default. Main or Host policy decides whether to open it; every task does not
  pay for a second model by default. Opening Teto is a runtime capability
  choice, not a workflow hard-coded into the prompt.
- Main can use `teto_start`, `teto_stop`, and `teto_status`, or leave Teto closed.
- Teto receives user-visible input, Main output, tool requests, and their
  arguments. It does not receive Main's private context or complete tool
  results.
- Teto has its own context, budget, events, and state. It can send observations,
  questions, and risk signals back to Main through bounded A2A voice.
- Teto does not modify the workspace or execute tools. Its value is an
  independent perspective, contradiction detection, risk sensing, and
  navigation, not a duplicate Main loop.
- Every Team branch may own a Teto. Teto is therefore not one global supervisor;
  it can grow with the topology.

Teto's cadence can also be independent from Main: it can run sparsely, deliver
advice at a safe boundary, or start only when Main explicitly needs it. A second
line of thought becomes a composable capability rather than a mandatory tax.

### Lane: an addressable execution unit

A Lane is more than a thread name or UI label. Each Lane has a Host-managed
identity and its own:

- context projection and visibility;
- model budget, time, and cancellation boundaries;
- Ledger events, artifact references, and recovery position;
- Inbox, A2A relationships, and lifecycle state;
- capability manifest, rather than a tool list that can grant itself access.

The main Lane kinds are:

| Lane | Responsibility |
| --- | --- |
| **Main** | Receives the user task, chooses actions, uses tools, and produces the result. |
| **Teto** | Observes Main's public surface and supplies an independent view. |
| **Worker** | A bounded task-level delegated lane enabled with `--worker`. |
| **Team** | Independent branches created by Main, each with its own context and result. |

Lane boundaries keep collaboration logic out of one oversized prompt. The model
can decide freely while the Host can still answer: who is acting, who authorized
it, where the evidence is, and how to continue after failure.

### Multi-topology: how future Agents organize

Nausicaa treats topology as a first-class runtime fact instead of assuming one
fixed master-worker tree. The Host creates and validates relationships such as
`owns`, `observes`, `delegates`, `member-of`, and controlled `peer`/`direct` A2A
routes.

One Run might look like this:

```text
Main
├─ observes   Teto
├─ delegates  Team:research
│              └─ observes   Team:research:Teto
├─ delegates  Worker:tests
└─ A2A/direct Main@another-Run
```

This does not require every task to create a full graph. It lets the system
expand naturally when the task calls for it. Topology projections, Lane
manifests, and A2A receipts make collaboration visible, auditable, and
recoverable; a model cannot forge another Lane's identity or authority.

As model calls move further into the cloud, the Host becomes a durable
control plane. It does not dictate how each model should think; it records the
topology, grants capabilities, preserves evidence, and restores the correct
boundaries after a network or process interruption.

### Runtime layers

```text
L0  Provider-neutral agent loop
    streaming · tool calls · bounded parallelism · abort · usage

L1  Durable Run runtime
    Ledger · artifacts · permissions · retry · checkpoint · recovery

L2  Lane topology
    Main · Teto · Worker · Team · A2A · awareness · daemon
```

A simple Main-only task remains the simple path. It does not require Teto, Team,
Fukai, A2A, or a resident daemon. A richer topology is an available capability,
not ceremony required for every run.

### Durable Runs and recovery

Every Run has a JSONL Ledger and a content-addressed artifact store. The Ledger
records user input, model requests, Lane state, tool lifecycles, A2A messages,
checkpoints, and recovery facts. Tool side effects follow:

```text
requested -> admitted -> started -> terminal
```

Operations have stable identities and idempotency keys. If a process stops after
an external side effect may have happened, recovery preserves an `unknown`
outcome instead of guessing success and running it again. Use `/resume`,
`--resume <run-id>`, or `/fork` to continue or create an independent Run from a
committed checkpoint.

Fukai is the context boundary and an optional verified compaction capsule; it
does not replace the Ledger. Ordinary interaction does not silently create a
persistent Goal; use `/goal` when a long-running objective is intentional.

### Permissions and capabilities

The Host runtime owns authorization; prompt text cannot grant access:

- `read-only` for inspection;
- `workspace` for controlled edits inside the workspace with an OS sandbox;
- `full-access` for the normal interactive session, the default configuration.

When a permission or outer OS boundary rejects an operation, the interactive TUI
opens a permission request. Approval switches to the higher capability and
retries once; rejection remains a durable failure. Non-interactive `--print` and
`--json` runs have no approval UI and fail with a structured diagnostic. The
`workspace` profile protects `.git` writes, so use `/permissions full-access` or
`--allow-shell` for `git add` and `git commit`.

### Quick start

Requirements: Node.js `>=22.19.0`.

```bash
git clone https://github.com/jackispm/nausicaa-harness.git
cd Nausicaa
npm ci
npm run build
npm link
```

Configure a model through the environment:

```bash
export OPENROUTER_API_KEY="..."
export NAUSICAA_MODEL="openrouter:openai/gpt-5-mini"
nausicaa "Inspect this project and explain how to run it"
```

Or save a local credential:

```bash
nausicaa auth login
nausicaa auth status
```

Credentials stay in the local credential store. TUI `/login` and `/logout` use
the same store, show only masked status, and never write keys to a Run
transcript.

### Common runs

```bash
# Scripts and CI
nausicaa --print "Summarize the package scripts"
nausicaa --json "Check the repository status"

# Multiple Lanes
nausicaa --worker "Break this migration into bounded implementation tasks"
nausicaa --teto-model openrouter:openai/gpt-5-mini
nausicaa --main-only "Run without the Teto lane"

# Daemon and read-only topology
nausicaa --daemon
nausicaa --topology --print
```

Interactive commands:

```text
/login, /logout                manage local provider credentials
/model                         choose a model
/list-agents                   inspect the Agent Family and topology
/goal                          manage the optional persistent Goal
/resume, /fork, /tree          navigate Runs and checkpoints
/permissions, /plan            change permissions and execution mode
/compact                       create a verified context capsule
! <command>                    run Bash and queue bounded output for context
!! <command>                   run Bash without adding output to model context
```

### Development and references

```bash
npm ci
npm run typecheck
npm test
npm run eval
npm run test:smoke
npm run build
```

`npm run check` is the standard offline gate. Live provider evaluations are
opt-in and are not part of the default test command.

Nausicaa uses [`pi-ai`](https://github.com/earendil-works/pi) for provider
transport and takes Pi coding-agent's single-Lane behavior as its L0 reference.
Its session and long-running-Agent comparisons draw on Prime Agent, while its
modular edge boundary was evaluated against DeepSeek Harness. The Ledger, Teto,
Lane topology, and Host-owned permissions are Nausicaa's own runtime contracts.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
Security reports should follow [SECURITY.md](SECURITY.md).

## License

Nausicaa is released under the [MIT License](LICENSE). Notices for adapted
third-party code and direct dependencies are in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
