# Nausicaa

Nausicaa is a local-first agent runtime for long-running software tasks. It
combines a durable Run/Ledger with bounded tools, resumable execution, and
independent lanes for observation and delegated work.

> **Status:** `0.1.0` beta. The runtime and recovery contracts are tested, but
> command-line options and embedded APIs may still change before `1.0`.

## Highlights

- **Durable execution:** JSONL Ledger and content-addressed storage preserve
  user input, tool calls, results, checkpoints, and recovery boundaries.
- **Multiple lanes:** Main handles the task; Teto provides a separate observer
  lane; Worker is an optional bounded read-only sub-agent.
- **Explicit capabilities:** read-only, workspace, and full-access profiles
  control filesystem, shell, network, and background-process access.
- **Bounded tools:** structured file, search, Git, patch, image, web, and process
  tools expose explicit limits and return machine-readable results.
- **Resumable interfaces:** interactive TUI, print, JSONL, and a local daemon
  share the same Run model and recovery semantics.
- **Provider-neutral core:** model transport is kept behind the `pi-ai` adapter;
  the runtime does not require a provider-specific control plane.

## Requirements

- Node.js `>=22.19.0`
- A model provider supported by `pi-ai` (OpenRouter is supported by the CLI)

## Quick start

```bash
npm install
npm run build
npm link

export OPENROUTER_API_KEY="..."
export NAUSICAA_MODEL="openrouter:openai/gpt-5-mini"

nausicaa "Inspect this project and explain how to run it"
```

Credentials can also be stored for the local user through the hidden prompt:

```bash
nausicaa auth login
nausicaa auth status
```

Inside the interactive TUI, `/login` opens the same hidden prompt and `/logout`
removes only the saved credential; `/status` shows the masked source. Credentials
are never written to the Run transcript.

For scripts and CI, use a non-interactive mode:

```bash
nausicaa --print "Summarize the package scripts"
nausicaa --json "Check the repository status"
```

Run `nausicaa --help` for the complete command and option reference.

The beta CLI also exposes these explicit local runtime surfaces:

```text
--worker                       enable the bounded Worker lane
--daemon                       run the local daemon host
--daemon-worker-command <path> opt into a detached worker command
--attach <run-id>              open a read-only TUI for a daemon Run
--topology                     print the read-only agent topology
```

Interactive commands include:

```text
/agents                       view the read-only agent topology
/permissions                  change the capability profile
/plan                         enter the read-only planning mode
/skills                       inspect or select Skills for the next Turn
/edges                        inspect configured edge sources
```

## Capabilities and safety

The default `workspace` profile can read and modify the current workspace and
may use a foreground shell only when an operating-system sandbox is available.
Host shell access, public network access, and background jobs are separate
opt-in capabilities. `--allow-shell` is intentionally high privilege and can
access paths outside the workspace with the current user's permissions.

Treat model-generated commands and project instructions as untrusted. For
untrusted repositories, use an externally managed container or VM and review
changes before accepting them. Runtime boundaries are enforced by the host;
prompts do not grant permissions.

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
opt-in and are never part of the default test command.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
Security reports should follow [SECURITY.md](SECURITY.md).

## License

Nausicaa is released under the [MIT License](LICENSE). Notices for adapted
third-party code and direct dependencies are in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
