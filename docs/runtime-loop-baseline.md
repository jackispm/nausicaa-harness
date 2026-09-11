# Runtime Loop Baseline

Current execution contracts for 0.1.8, updated 2026-09-11. Historical proposals
for a universal L0 kernel are not production integration claims.

## Execution paths

Interactive CLI and the daemon use `SessionController`; the one-shot CLI uses
`executeRun`. New ordinary Runs start Teto unless disabled or configured for
manual activation. An explicit `teto_stop` remains authoritative after recovery.
Legacy policies and evaluation `auxiliaryMode` retain their compatibility paths.

| Lane | Execution | Ownership |
| --- | --- | --- |
| Nausicaa | `MainLoop`, Fukai context, Mowe tools | Run/Turn completion and boundary hooks |
| Team member/reducer | `TeamBranchExecutor` creates `MainLoop` | Task claim, report, Team lifecycle and optional member Teto |
| Ordinary Teto | `TetoLaneController` → `TetoLaneScheduler` → `MainLoop` | Completed owner steps, private transcript, one inference per released batch |
| Delegated Worker | `WorkerTaskExecutor`, `WorkerToolExecutor`, Mowe | Task result/recovery and the existing read-only tool allowlist |
| Legacy Teto / reflection | `TetoScheduler` / `ReflectionScheduler` | One no-tool request per admitted observation |
| Standalone L0 | Exported `L0AgentLoop` | Injected ports and materialized messages; no production lane uses it |

Sources: [session](../src/runtime/session-controller.ts),
[one-shot](../src/runtime/run-runtime.ts), [Main](../src/runtime/main-loop.ts),
[Team](../src/runtime/team-branch-executor.ts),
[Teto](../src/runtime/teto-lane-scheduler.ts),
[Worker](../src/runtime/worker-task-executor.ts), [L0](../src/runtime/l0-agent-loop.ts).

New Team and delegated tasks have no implicit total token, duration, or
model-call cap. Models cannot set task budgets. Usage accounting, per-provider
request timeouts, explicit tool timeouts, cancellation, and legacy host limits
remain. A provider request timeout is not a timeout on `task_wait` or a Team.
Team members inherit authorized capabilities unless their lead narrows them;
the delegated Worker's read-only defaults do not describe Team members.

## Shared contracts

Main, Team, Teto, Worker, and L0 use the same `ModelPort` interface. Main consumes
streams when available; Worker calls `complete`. The shared
[response validator](../src/runtime/model-response-validation.ts) rejects invalid
response fields, usage, and tool calls before response billing or persistence.
Main and L0 also validate stream envelopes. Provider stream closure is forwarded
through the retry adapter, including when a consumer rejects an event.

Main and Worker give each complete tool batch to Mowe. A per-result callback
persists each tool's artifact and terminal event when it settles, while model
messages remain in source call order. A result-recorder failure cancels the
batch and waits for result handlers; ordinary tool errors remain local to their
calls. Tool invocation checks the merged deadline after the asynchronous
`tool.started` write. Admission validates root object `const`/`enum` constraints.

Main checks cancellation while preparing individual tool requests and after
asynchronous completion hooks. Its terminal append is the completion boundary.
Workspace file replacement rechecks cancellation after final path validation;
`rename` is the commit boundary, so cancellation after that call does not turn
a committed replacement into an unexecuted write.

Length-truncated tool calls cannot execute. Main can continue a truncated
response; Worker returns a partial result. Worker restores persisted evidence
refs on completion recovery. Recovering an interrupted tool-using Worker task
still fails closed and requires a fresh dispatch rather than reconstructing
an arbitrary in-flight conversation.

Reported provider-failure usage is charged under stable request identities;
recovery does not charge it twice. Token aggregation rejects unsafe integers.
Tool recovery classifies lifecycle support per operation, so a completed modern
operation cannot hide a legacy request with an uncertain outcome.

## Observation and admission

Teto buffers public owner messages, tool requests, and bounded tool outcomes
until `step.completed` or `step.failed`. Completed steps stay intact; queued
completed steps are coalesced before inference. A new user message alone does
not start Teto. Raw tool results and the owner's full context remain excluded.
See [lane observability](lane-observability.md) for visibility, delivery, and
one-shot shutdown behavior.

Task admission serializes capacity checks per `(Run, destination lane)` for
callers sharing one Inbox. Unrelated destinations can proceed independently.
This remains a single-process contract; a multi-process Inbox would need an
atomic repository check. Team ownership, nesting, capabilities, task claims,
and report delivery are separate boundaries described in
[Team collaboration](team-collaboration.md).

## Cancellation limits

In-process tools must cooperate with their AbortSignal. L0 directly awaits
tools; an uncooperative tool can prevent it from returning. Production hosts
bound scheduler shutdown waits and reject writes after their event sink closes.
Those protections cannot forcibly stop an external effect. A started operation
without a durable result blocks automatic recovery and requires reconciliation.

When cancellation wins a provider race, usage attached only to a later
rejection may not be reconciled. Solving late accounting requires a provider
cleanup/lifetime contract; closing a promise is not proof of zero provider cost.

Moving production lanes to L0 remains deferred. It needs differential tests
for permissions, operation identity, context reconstruction, terminal delivery,
and recovery through the actual wrappers. Standalone kernel tests do not prove
production parity.

## Focused verification

- `test/protocol/main-terminal-contracts.test.ts` and `worker-terminal-contract.test.ts`:
  cancellation, terminal persistence, provider response rejection.
- `test/unit/mowe-result-lifecycle.test.ts` and `mowe-boundaries.test.ts`:
  batch cleanup, concurrency, deadline and schema boundaries.
- `test/unit/teto-lane-scheduler.test.ts` and `test/protocol/teto-activation-recovery.test.ts`:
  completed-step cadence, coalescing, projection and recovery.
- `test/unit/task-dispatcher.test.ts`, `workspace-write.test.ts`,
  `usage-recovery-overflow.test.ts`, and `model-retry.test.ts`: admission,
  file commit boundaries, accounting and stream cleanup.

These are local contract tests. Live provider probes and their limitations are
documented in [OpenRouter topology smoke](openrouter-topology-smoke.md).
