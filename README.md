# Nausicaa

Nausicaa is a local-first agent runtime for long-running software work.

It keeps a Pi-compatible coding loop at its core, then adds a durable Run
model and a native multi-lane fabric around it. The main lane can execute a
task, an independent Teto lane can observe and advise, and bounded Worker or
Team lanes can handle delegated work. The whole topology is inspectable,
resumable, and owned by the host runtime rather than hidden in prompt text.

> **Status:** `0.1.0` beta. Nausicaa is source-first and experimental. Runtime
> contracts are covered by offline tests, while provider, daemon, and edge
> integrations are still being expanded before a stable release.

## Why Nausicaa?

Most coding agents are organized around one conversation and one execution
loop. Nausicaa keeps that simple path available, but treats long-running work
as a durable system with explicit actors and boundaries:

```text
L0  Provider-neutral agent loop
    streaming · tool calls · bounded parallelism · abort · usage

L1  Durable Run runtime
    Ledger · artifacts · permissions · retry · checkpoint · recovery

L2  Lane fabric
    Main · Teto · Worker · Team · A2A · topology · daemon
```

The layers are additive. A simple Main-only task does not require Teto, Team,
Fukai, A2A, or a resident daemon.

## The lane model

### Main

Main is the executing agent. It receives the task, chooses tools, edits the
workspace when authorized, and produces the user-visible result. Its loop is
provider-neutral and follows the familiar coding-agent shape: build context,
request the model, validate tool calls, execute bounded effects, and continue
at the next boundary.

### Teto

Teto is a separate observation lane, not a second hidden Main and not a
chain-of-thought store.

- A new Run may expose Teto as an available capability, but it starts dormant.
- Main can open, stop, or inspect it with the `teto_start`, `teto_stop`, and
  `teto_status` tools.
- Teto receives user-visible Main output, tool requests, and their arguments;
  it does not receive tool results or Main's private context.
- Teto has its own transcript, context, budget, and lifecycle, and can send
  bounded advisory voice back to Main.
- Teto does not modify the workspace or execute tools.

This makes a second line of observation explicit and auditable. It can be used
for contradiction checks, risk signals, task navigation, or a second opinion
without turning every request into an unbounded swarm.

### Worker and Team

`--worker` explicitly enables a bounded Worker lane for task-scoped delegated
work. Main can also create a Team of independent task branches. Each Team
branch is an ordinary lane with its own context, budget, lifecycle, and result;
a branch may have its own Teto. Delegation is bounded by policy and depth, and
does not imply a shared mutable workspace or an arbitrary agent graph.

### Topology and A2A

The host owns lane identity and relationships. `/list-agents` and
`--topology` provide a read-only topology projection, while
`/tree` shows the durable Run tree and checkpoints. Cross-Run agent messages use
the `agent_message` tool with typed A2A routes, admission, receipts, and
idempotency rather than ambient agent-to-agent access.

## Durable Runs, not just transcripts

Every Run has a durable Ledger and content-addressed artifacts. The Ledger is
the source of truth for user inputs, lane messages, model attempts, tool
lifecycles, checkpoints, and recovery facts.

Tool effects follow an explicit lifecycle:

```text
requested -> admitted -> started -> terminal
```

Operations have stable identities and idempotency keys. If a process stops
after an external side effect may have happened, recovery records an unknown
outcome instead of guessing success and silently running it again.

Use `/resume` or `--resume <run-id>` to continue an interrupted Run. Use
`/fork` to create an independent child Run from a committed checkpoint; the
parent remains read-only and the child receives its own effect identity.

## Context, goals, and recovery

- **Fukai** is the context boundary. It projects a bounded request from the
  durable history and can optionally create a verified compaction capsule. It
  never replaces the full Ledger, and compaction is opt-in with
  `--fukai-compaction`.
- **Goals** are explicit. Ordinary requests do not silently create a persistent
  long-running goal. Use `/goal` to create, inspect, edit, pause, resume, or
  clear one.
- **Recovery** is host-owned. Sessions, queue state, checkpoints, artifacts,
  lane lifecycle, and daemon observations are reconstructed from durable facts,
  not from a UI-only cache.

## Safety and capabilities

Nausicaa keeps authorization in the host runtime. A capability profile controls
what effects are available:

- `read-only` for inspection;
- `workspace` for authorized edits in the current workspace;
- `full-access` for the normal interactive user session (the default).

Workspace writes, host shell access, and public network tools are available by
default for a normal CLI session. Use `/permissions read-only` or
`/permissions workspace` to narrow a session; the same profile can be selected
from a settings file. Shell and external edge sources remain subject to host
admission and OS boundaries; prompt text cannot grant a permission.

When a selected profile or the outer OS denies an operation, the interactive
TUI opens a permission request. Approving it switches this session to
`full-access` and retries the operation once. Rejecting it leaves the failure
durable. Non-interactive `--print` and `--json` runs have no approval UI and
fail closed with a structured diagnostic.

The `workspace` profile deliberately keeps repository metadata protected: the
`git_status`, `git_log`, `git_show`, and `git_diff` tools provide bounded,
read-only inspection, while Bash operations such as `git add` and `git commit`
require `/permissions full-access` (or `--allow-shell`). If full-access still
reports `Operation not permitted` while creating `.git/index.lock`, the outer
host or OS sandbox owns that restriction and must grant the repository write
access; Git flags cannot bypass it.

For untrusted repositories, use a disposable clone and an externally managed
container or VM. Review changes before accepting them.

## Quick start from source

Requirements: Node.js `>=22.19.0`.

```bash
git clone <repository-url>
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

The CLI uses the `pi-ai` provider adapter. OpenRouter is the default supported
provider path; `--all-providers` exposes the complete built-in provider/model
catalog, and `provider:model` selectors can be passed with `--model`.

Credentials can be saved locally through a hidden prompt:

```bash
nausicaa auth login
nausicaa auth status
```

In the interactive TUI, `/login` and `/logout` use the same credential store.
Only masked status is displayed, and credentials are never written to a Run
transcript. Authentication status is local and does not claim that a provider
request has succeeded.

## Common ways to run

One-shot output for scripts and CI:

```bash
nausicaa --print "Summarize the package scripts"
nausicaa --json "Check the repository status"
```

Interactive and multi-lane runs:

```bash
nausicaa --model openrouter:openai/gpt-5-mini
nausicaa --worker "Break this migration into bounded implementation tasks"
nausicaa --teto-model openrouter:openai/gpt-5-mini
nausicaa --main-only "Run without the Teto lane"
```

Durable local host and read-only attachment:

```bash
nausicaa --daemon
nausicaa --attach <run-id>
nausicaa --topology --print
```

Useful options include:

```text
--resume <run-id>              resume an interrupted Run
--continue                     resume the latest Run in this workspace
--fukai-compaction             opt into Fukai compaction
--allow-write                  allow workspace writes (default)
--allow-shell                  allow host-level shell access (default)
--allow-network                allow web fetch/search tools (default)
--edges                        enable configured Skills/MCP/plugin edges
--daemon-worker-command <path> opt into a detached worker command
--max-steps <number>           bound Main model steps
--max-output-tokens <number>   bound one Main model response
```

Interactive commands:

```text
/login, /logout                manage local provider credentials
/model                         choose a model from the local catalog
/list-agents                   inspect the Agent Family and relationships
/goal                          manage the optional persistent goal
/resume, /fork, /tree          navigate durable Runs and checkpoints
/permissions, /plan            change execution mode and permissions
/skills, /edges                inspect configured extension sources
/compact                       commit an optional verified context capsule
! <command>                    run Bash; queue bounded output for the next prompt
!! <command>                   run Bash without adding output to model context
```

The prefixes use the current permission boundary. `workspace` uses the OS
sandbox and keeps `.git` metadata protected; `full-access` uses the host shell;
`read-only` and Plan mode reject Bash before a process is spawned.

Run `nausicaa --help` for the complete command and option reference.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run eval
npm run test:smoke
npm run build
```

`npm run check` runs the standard offline gate. Live provider evaluations are
opt-in and are never part of the default test command. The current beta does
not claim complete provider, OAuth, daemon takeover, RPC, or edge-product
parity; those surfaces are being verified independently.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
Security reports should follow [SECURITY.md](SECURITY.md).

## Acknowledgements

Nausicaa uses [`pi-ai`](https://github.com/earendil-works/pi) for provider
transport and follows the single-lane behavior of Pi's coding-agent runtime as
its L0 reference. Its session, goal, and long-running-agent comparisons also
draw on Prime Agent, while its modular edge boundary was evaluated against
DeepSeek Harness. These projects remain separate implementations; Nausicaa's
Ledger, lane topology, Teto observer, and host-owned permissions are its own
runtime contracts.

## License

Nausicaa is released under the [MIT License](LICENSE). Notices for adapted
third-party code and direct dependencies are in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
