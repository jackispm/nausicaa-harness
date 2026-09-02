# Upstream Live Task Matrix

Status: research baseline, 2026-09-03

This document records what was inspected in Pi, Prime Agent, DeepSeek Harness,
and Codex. It separates real-model work from adapter, process, and UI checks.
The source checkouts and revisions are recorded in the two inventory files under
`/private/tmp`; no source checkout is modified by this document.

## Three test classes

| Class | What is exercised | What a pass means |
| --- | --- | --- |
| `workflow-live` | A real model chooses tools, reads state, edits state, or coordinates a lane. | The selected model completed the observable task in this harness. |
| `provider-live` | A real provider is called to check streaming, usage, cache, images, or error mapping. | The adapter accepted the provider behavior for that model and account. |
| `protocol-ui-only` | RPC, ACP, daemon, browser replay, snapshots, or a provider-specific wire contract. | The protocol or UI contract works; it is not a model capability score. |

Offline tests are kept separately. They use deterministic providers and are the
release gate for state, path, cancellation, and serialization contracts.

## Pi

| Source family | Class | Portable Nausicaa task |
| --- | --- | --- |
| `packages/evals/src/smoke.eval.ts` | workflow-live | `pi-smoke` |
| `packages/evals/src/extensions.eval.ts` | workflow-live | `pi-extension` |
| `packages/agent/test/harness/tools.test.ts` | workflow-live wrapper + offline contract | `pi-read-window`, `pi-parallel-tools`, `pi-edit-disjoint`, `pi-bash-tail`, `pi-delete-action` |
| `packages/coding-agent/test/suite/regressions/3302-find-path-glob.test.ts` | workflow-live wrapper + offline contract | `pi-find-scope` |
| agent loop, abort, queue, and settlement suites | offline contract | Mowe executor tests; no provider spend |
| session tree, branch, compaction, RPC, and client suites | protocol-ui-only or offline | Future Fukai/daemon/awareness tasks |
| provider stream, retry, image, cache, and token suites | provider-live | Mowe adapter matrix, separate from task score |

Pi has more deterministic tool and session tests than model-backed coding
questions. The eight Pi-derived behavior tasks in the beta catalog are the
portable subset; the rest should not be counted as missing live tasks.

## Prime Agent

| Source family | Class | Portable Nausicaa task |
| --- | --- | --- |
| coding-agent goal/autonomous/action suites | workflow-live + offline | Goal continuation and Teto observation, once the host boundary is fixed |
| session tree/navigation and RPC prompt/response | workflow-live or protocol-ui-only | Daemon attach, branch continuity, and printable awareness topology |
| daemon, owned worker, heartbeat, and recovery suites | protocol-ui-only + offline | Daemon lifecycle and Worker recovery contracts |
| session bus, recursion, dynamic tools, queue, and cancellation | offline contract | A2A and Mowe regression suites |
| IPython, kernel, and RLM suites | Prime-specific | Deferred; not a Mowe/Fukai beta requirement |
| provider stream, images, token accounting, overflow, and cache suites | provider-live | Adapter compatibility only |

The earlier Prime run exercised a small provider selection: streaming/thinking,
image-bearing results, token accounting, and overflow. Anthropic-only session
tests were skipped when the matching account was unavailable; that is not a
Prime failure. Codex account probes were blocked before a model request and are
also not a Nausicaa quality result.

## DeepSeek Harness

| Source family | Class | Portable Nausicaa task |
| --- | --- | --- |
| `examples/headless-agent/tests/coding-task.e2e.ts` | workflow-live | `bugfix` |
| `examples/headless-agent/tests/full-loop.e2e.ts` | workflow-live | `bash-roundtrip` |
| `examples/headless-agent/tests/real-model.e2e.ts` | workflow-live | `file-rewrite` |
| `examples/headless-agent/tests/resume.e2e.ts` | workflow-live | `resume` with host-controlled pause |
| `packages/fs/tool-fs/tests/fs-tools.e2e.ts` | workflow-live | `deepseek-fs-cwd` |
| `packages/context/agent-instructions/tests/agent-instructions.e2e.ts` | workflow-live | `deepseek-instructions` |
| `examples/headless-agent/tests/compaction.e2e.ts` | workflow-live | `fukai-compaction` |
| `packages/subagent/subagent-spawn-in-process/tests/spawn-in-process.e2e.ts` | workflow-live | `multi-agent` |
| `examples/acp-agent/tests/escalation.e2e.ts` | workflow-live | `permission-boundary` |
| todo, code-mode, cache, and worker-thread suites | adapted or deferred | Add only when the corresponding Nausicaa capability is public |
| native LLM adapter, pi-ai adapter, web search, E2B, and external search suites | provider-live or protocol-ui-only | Keep as integration probes, never as core task scores |

The web `record` suites can call a real model, but most assertions are browser
or replay assertions. They are not additional portable coding tasks.

## Codex

Codex supplied useful permission and process ideas, but its OAuth/account probes
and native protocol tests are not provider-neutral workflow tasks. They remain
reference material unless Nausicaa deliberately exposes the same account or
wire contract.

## Current Nausicaa coverage

The beta capability catalog now contains 19 enabled tasks:

- basic evidence reading and exact response;
- file repair, rewrite, nested-path handling, and resume;
- shell round trip and bounded large output;
- read continuation, parallel reads, disjoint edits, scoped discovery, and
  structured path operations;
- workspace instruction loading, Worker delegation, Fukai compaction, and a
  denied out-of-scope mutation.

Use `NAUSICAA_BETA_CASES=all` to select every enabled task. A single batch still
shares one request meter and one wall-clock deadline; `NAUSICAA_EVAL_MAX_REQUESTS`
is the global ceiling, not a per-task multiplier.

## What has not been run

The inventories are source audits, not claims that every upstream live test was
executed. Missing provider accounts, model availability, browser/daemon setup,
and provider-specific protocols explain the unrun groups. The next live run
should use the Nausicaa catalog and record its own artifact; it must not label a
source-only or replay test as a successful real-model run.

For the next portable additions and their acceptance boundaries, see
[`portable-gap-audit.md`](./portable-gap-audit.md). It deliberately keeps
session-tree, attach continuity, goal continuation, awareness, and daemon
restart work distinct from the current 19-case capability batch.
