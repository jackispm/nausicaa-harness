# Runtime Loop Baseline

Source audit for the 0.1.3 work, updated 2026-09-09. This records the current execution
paths, not a promise that every Lane already runs through one generic kernel.
Existing private design notes remain historical; their proposed L0 integration
must not be mistaken for a completed production migration.

## Production Entry Points

- Interactive CLI opens `SessionController`; it composes Main, optional Worker,
  ordinary Teto (enabled and started by default), and Team runtimes
  ([CLI](../src/cli.ts#L546), [composition](../src/runtime/session-controller.ts#L2690)).
- Non-interactive CLI calls `executeRun` with `maxMainStepsPerActivation`,
  using the same ordinary Teto observer and lifecycle controls as interactive
  sessions ([CLI](../src/cli.ts#L709)). Embedders that explicitly supply legacy
  `maxMainSteps`, recovered legacy policies, and explicit evaluation
  `auxiliaryMode` still use the compatibility path
  ([selection](../src/runtime/run-runtime.ts#L328)).
- The default daemon runtime factory also opens `SessionController`
  ([factory](../src/runtime/daemon-runtime.ts#L153)).

## Execution Paths

| Runtime | Model and tool execution | Distinct ownership |
| --- | --- | --- |
| Main | `MainLoop`, with Fukai context and Mowe tools | Main Run/Turn settlement and boundary hooks |
| Team member and reducer | `TeamBranchExecutor` creates `MainLoop` | Task claim, member result, Team lifecycle; optional member Teto |
| Ordinary Teto | `TetoLaneController` starts `TetoLaneScheduler`, which creates `MainLoop` | Public-event observations and its own transcript; one model step per observation activation |
| Worker | `WorkerTaskExecutor` has a bounded model/tool loop; `WorkerToolExecutor` uses Mowe | Read-only tool allowlist, task deadline, attempts, result and recovery |
| Legacy Teto | `TetoScheduler` invokes `IntentNavigator.observe` | One no-tool model request per admitted observation; structured Advice |
| Reflection | `ReflectionScheduler.process` | One no-tool model request per admitted observation; structured silent/revise output |
| Standalone L0 | Exported `L0AgentLoop` / `runL0AgentLoop` | Materialized messages and injected ports; no production runtime currently calls it |

Implementation evidence: [Main](../src/runtime/main-loop.ts#L358),
[Team](../src/runtime/team-branch-executor.ts#L422),
[ordinary Teto](../src/runtime/teto-lane-scheduler.ts#L518),
[Teto activation bound](../src/runtime/teto-lane-scheduler.ts#L588),
[Worker loop](../src/runtime/worker-task-executor.ts#L443),
[Worker tool authority](../src/runtime/worker-tool-executor.ts#L68),
[legacy observation](../src/teto/navigator.ts#L65),
[Reflection request](../src/runtime/reflection-scheduler.ts#L277),
[L0](../src/runtime/l0-agent-loop.ts#L93).

Reflection is not a deterministic projection, but it is also not a second
general-purpose model/tool loop. Its serialized observation queue can make
multiple independent model calls over a Run; every individual call has
`tools: []` and tool calls in the response are rejected. Legacy Teto follows
the same one-request, no-tool shape with a different observation/output contract.

Conversely, ordinary Teto is not universally tool-free: its default capability
is `agent_message` to its owner
([catalog](../src/runtime/teto-lane-scheduler.ts#L244)). This does not grant it
Main's shell or workspace-write authority. The explicit legacy/evaluation
no-tool contract must not be generalized to every Teto implementation.

## Shared Contracts And Real Differences

The production lane paths above use the same `ModelPort` types and prepared
request boundary. `PreparedModelPort` freezes request data and method bindings; it is
not an execution scheduler, permission authority, or shared transcript
([boundary](../src/model/prepared-model.ts#L58)). Main's default wrapper also
installs provider retries; that does not make retry behavior identical for
every directly injected auxiliary model
([Main wrapper](../src/runtime/main-loop.ts#L387)).

Main/Team/ordinary Teto share `MainLoop`, and Main and Worker both use Mowe for
tool admission. They still intentionally differ in context construction,
available tools, budgets, and terminal facts. Concrete differences include:

- Main consumes provider streaming when available; Worker explicitly calls
  `complete`, even when its port also supports streaming
  ([Main](../src/runtime/main-loop.ts#L1542), [Worker](../src/runtime/worker-task-executor.ts#L548)).
- Length-truncated tool calls never execute in either path. Main can request
  a continuation; Worker currently returns a partial result rather than
  continuing that truncated tool loop
  ([Main](../src/runtime/main-loop.ts#L1078), [Worker](../src/runtime/worker-task-executor.ts#L733)).
- Worker recovery after a durable tool-call response fails closed and requires
  a fresh dispatch; it does not yet reconstruct an arbitrary ongoing task
  conversation ([recovery](../src/runtime/worker-task-executor.ts#L336)).
- L0 has its own validation and tool executor, not Mowe. L0 unit tests alone
  cannot establish production permission, settlement, or recovery parity
  ([executor](../src/runtime/l0-agent-loop.ts#L288)).

## Admission Is Not One Operation

| Admission boundary | Existing owner and contract |
| --- | --- |
| User input to Main | `SessionController.submit`: serialized input identity, duplicate checking, pending-input capacity, steering/follow-up and Turn promotion |
| Delegated Worker task | `TaskDispatcher`: canonical task/deadline/context, idempotent Inbox send and per-destination outstanding-task capacity; Worker later claims the request |
| Team task | The same `TaskDispatcher`, inside additional Team owner/depth/budget/lifecycle checks; member claims and terminal settlement are fenced by the Team board |
| Teto observation | Owner-controlled lifecycle plus serialized public-event observation and mailbox delivery; not a delegated task request |
| Tool effect | Mowe validates advertised capabilities, arguments, effects and approval; a task dispatch receipt does not grant tool authority |

Evidence: [Main admission](../src/runtime/session-controller.ts#L1683),
[dispatcher](../src/runtime/task-dispatcher.ts#L160),
[Worker claim](../src/runtime/worker-task-executor.ts#L200),
[Team dispatch](../src/runtime/team-runtime.ts#L446),
[Team claim fence](../src/runtime/team-branch-executor.ts#L603),
[Teto start](../src/runtime/teto-lane-controller.ts#L110).

`TaskDispatcher` serializes capacity checks for callers sharing one Inbox
object. This is explicitly a single-process boundary, not a distributed
transaction or a universal lane admission layer
([scope](../src/runtime/task-dispatcher.ts#L30)). Different admission paths are
not evidence that Main or Teto is missing a dispatcher.

## Scope For 0.1.3

The L0 API contract exists: typed input, result and events, independent ports,
streaming, cancellation, validation and bounded execution. It is exported and
has focused tests. What remains deferred is the durable adapter that would
let existing production runtimes use it without duplicating conversations or
losing operation identity, context rebuilding, approval, budget settlement,
boundary delivery, and crash recovery.

For this release, preserve and clarify the existing paths. Teto is enabled and
started automatically for a new Run unless the policy explicitly chooses
`tetoEnabled: false` or `tetoActivation: "manual"`; an explicit `teto_stop`
control remains authoritative across recovery. Focused regression
tests should pin the behavior that matters: provider-aborted responses cannot
execute tools or produce observer advice; usage still settles; a cancelled
task cannot start a model; committed terminal results are not replayed; and
interactive versus legacy/evaluation Teto selection is explicit.

The narrow observer correction in this release rejects provider-aborted
Reflection and legacy Teto output even when the caller's AbortSignal is still
live. Valid-looking silent/revise/advise JSON must not become a successful
observation. Reported usage remains chargeable and recoverable
([Reflection guard](../src/runtime/reflection-scheduler.ts#L303),
[Teto guard](../src/teto/navigator.ts#L88)). This does not change their loop shape.

Do not bundle a wholesale MainLoop-to-L0 migration, Worker-to-MainLoop rewrite,
new universal dispatcher, or removal of legacy evaluation paths into TUI work.
A later extraction needs differential tests through the actual production
wrappers, including interrupted durable operations. A common class name or
more passing standalone-kernel tests is not sufficient evidence.

Existing focused gates:

- `test/protocol/l0-agent-loop-parity.test.ts`: standalone kernel mechanics.
- `test/protocol/pi-l0-oracle.test.ts`: Main/Session observable behavior slices.
- `test/unit/model-prepared.test.ts`: immutable provider request boundary.
- `test/unit/worker-task-executor.test.ts`: bounded Worker, tool/recovery behavior.
- `test/unit/task-dispatcher.test.ts`: admission, idempotency, deadlines and capacity.
- `test/protocol/team-cancellation-admission.test.ts`: cancellation around durable admission writes.
- `test/protocol/teto-team-architecture.test.ts`: ordinary Teto and Team composition.
- `test/unit/teto-navigator.test.ts` and `test/unit/reflection-scheduler.test.ts`: one-pass observers.

These are local contract tests, not a claim of complete upstream Pi parity or
live-provider coverage. The existing [Team L0 boundary](team-collaboration.md#l0-boundary)
already makes the same distinction between an available kernel and completed
runtime reuse.

## Tool and completion contracts in 0.1.3

Main and Worker use the existing Mowe scheduler for each complete tool batch.
The new optional `onResult(result, index)` hook runs after a call's output has
been bounded and retained. Each runtime commits that call's artifact and
terminal event there, while indexing model messages by source call order.
Replay uses the durable `tool.requested` order; older records without a request
retain their previous event-order fallback. Worker recovery also restores
committed tool evidence in source order.

A result recorder failure aborts the batch and waits for active adapters and
all result callbacks before propagating the original error. Queued calls are
cancelled without invoking their adapters. Ordinary tool errors remain local
to their calls. This preserves existing cooperative cancellation: an adapter
that ignores its signal cannot be forcibly stopped by an in-process promise.
The runtime does not report a fully drained batch while that adapter is active.

Main checks cancellation after `beforeCompletion` and before admitting its
terminal append. Once that append begins, its durable outcome decides
completion. Tool invocation checks its own deadline after the asynchronous
`started` write, and argument admission applies root `const`/`enum` constraints.

Worker and Main share the existing provider-failure usage extraction contract.
Reported usage is charged under the request's stable budget key even when the
model fails; recovery uses the durable charge without billing it twice.
An existing limitation remains when cancellation wins the provider race:
Worker's `withAbort(model.complete(...), signal)` returns the cancellation
reason, so usage attached to a subsequent provider rejection is not reconciled.
This can also happen when a provider rejects from its abort listener. Handling
late accounting needs a separate contract for provider cleanup and host lifetime;
the 0.1.3 failure-usage fix covers failures observed before cancellation wins.
These changes extend the existing execution and accounting boundaries; no new
loop kernel, scheduler hierarchy, or storage format is introduced.

Regression gates include `test/protocol/main-terminal-contracts.test.ts`,
`test/protocol/worker-terminal-contract.test.ts`,
`test/unit/mowe-result-lifecycle.test.ts`, and `test/unit/mowe-boundaries.test.ts`.
