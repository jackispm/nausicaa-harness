# Five-Round Reliability Review

Scope: Teto, lane discovery, A2A presentation, delegated work, and the tests
used to establish that those paths work. Existing unrelated README, selector,
and TUI-mode edits remain outside these commits.

## Round 1: Observer Isolation

The observer subscription accepted an owner's event type without checking its
visibility. That also allowed recovery to reintroduce a private source event
as observation data. Six new regressions failed before the fix.

Only explicitly `run`/`user` events can now enter observer projection; private,
sensitive, and missing-visibility inputs are rejected before reading source
artifacts. Recovery and tool-intent deduplication use the same boundary.
This commit also records the already-reviewed observer identity/quoted-input
contract and tool-capable output default, including the CLI policy correction.

Validation: 53 focused tests passed across observer projection, scheduling,
runtime activation parity, runtime lane contracts, and Run policy;
`npm run typecheck` passed. Stored historical artifacts are not rewritten.

The first commit also passed the same typecheck and 53 tests from an isolated
`git archive`, without using uncommitted runtime changes.

## Round 2: Truthful, Bounded Discovery

Five new regressions exposed historical Runs consuming the live-node budget
(including a second truncation during redaction), and historical registry
observations being expired against today's clock. Live nodes now receive
capacity before diagnostic history; output ordering and limits are preserved.
An explicit observation time is also passed to registry freshness checks.

This commit records the earlier activation-evidence filtering, host-bound
Awareness identity, independent Main status, checkpoint compatibility, and
process-loaded build identity. Unused capabilities are not live agents; a
rebuild does not silently relabel an old process with the new build.

Validation: the five new tests failed before the fix; 86 focused tests across
10 discovery, registry, activation, status, identity, and build suites passed.
`npm run typecheck` and `git diff --check` passed.

## Round 3: A2A Visibility And Session Isolation

Ordinary public A2A messages now appear in live, resumed, and remotely attached
transcripts. Both endpoints and envelope identity are checked; sender outbox
records say submitted, not delivered. Private cross-Run inputs retain private
visibility through admission, steering, replacement, queue projection, and
recovery. Legacy public wrappers cannot revive rejected/private source messages.
Message bodies accept normal whitespace without accepting unsafe controls, and
an embedded closing marker no longer truncates their display.

Run navigation fences old events and slow history reads, restores current
history after rejected attachment/fork, and binds explicit resume to its Run
inside admission. Three new navigation races were reproduced before correction,
including a command for X incorrectly resuming A and a failed fork blanking
the still-attached history. The same failure recovery is shared by new/import
navigation without changing their business semantics.

Validation: an isolated candidate containing only these selected changes passed
`npm run typecheck` and the complete `npm test`: 188 files, 2,060 tests. This
includes 93 interactive TUI tests and 58 session protocol tests. Uncommitted
selector, startup-logo, margin, and TUI-mode changes were excluded from the
candidate; they were not reverted in the shared workspace.

## Round 4: Cancellation Before Task Admission

A cancelled delegate call could still persist optional input and enqueue work,
including while waiting behind another admission. Cancellation is now checked
before input persistence, after it, inside the shared admission queue, and
immediately before Inbox send. Once send persistence has started, the caller
receives the actual queued outcome rather than a false claim of rollback.
Task fields are validated before optional input storage. Cancellation during a
store write may leave a bounded orphan artifact, but cannot admit a new task.

Validation: regressions failed before the fix; 42 delegate/dispatcher tests
passed in the root gate, with 54 additional related tests passed independently.
`npm run typecheck` and `git diff --check` passed. The optional dispatch signal
preserves existing callers and does not cancel already-admitted work.

## Round 5: Team Completion, Recovery, And Evidence

Restored members now deduct every durable model request from their attempt
allowance, including failed and unfinished calls. Available final responses
are still reused without another paid call, unless ready collaboration mail
requires a new boundary. Unknown tool effects remain fail-closed.

The live probes exposed further issues and informed focused regressions:

- `team_status` repeated admission/spawn context and legacy branch aliases.
  A model-facing projection reduced the same real snapshot from 20,771 to
  1,914 bytes (90.8%) without changing the durable board or dropping outcome
  evidence, errors, join, reduction, and Lead acceptance.
- A peer message arriving during a final response was missed before member
  settlement. The existing completion hook now checks already-claimable mail,
  in both active and recovery paths, without waiting for future messages or
  exceeding the task allowance. Budget-exhausted mail is not marked consumed.
- A reducer exhausting its allowance on tools could produce an illegal empty
  partial summary. Empty/whitespace reports now fail with an explicit reason.
  `team_reduce` accepts a bounded optional `maxAttempts`; its default stays 2.
- The live evaluator could mistake a consumed greeting for consumed evidence.
  It now requires correctly scoped numeric JSON, a prior successful read,
  and the exact evidence ID in a later committed recipient step. Cancellation
  facts are checked even if the final provider response fails. Meter deadlines
  clear their timers and uncertain provider cost stops further paid calls.

Validation: 177 tests passed in the root focused gate and 212 related tests
passed independently. The final isolated candidate passed typecheck, the
complete 190-file / 2,140-test suite, and build. A new Node process loaded
build ID `bd2ba351c449`. The source/test tree in the final commit is checked
against this validated candidate; subsequent edits only record these results.

Live validation remains deliberately separate from those offline gates:

| Report suffix | Result |
| --- | --- |
| `15-22-36-490Z-mLM9AX` | Main repeatedly read the large Team board and exhausted Run tokens; cleanup aborted member calls. Known cost $0.04943 is incomplete. |
| `15-43-02-396Z-6UVMCP` | Teto passed all 12 communication/presentation checks. Team exposed the completion-mail and empty-summary issues fixed above. 34 calls, $0.07310, complete reported cost. |
| `16-01-07-163Z-3jMKE5` | Reducer, Lead acceptance, and the correct answer succeeded. The strict Team case still failed: items used `grand_total` instead of required `subtotal`, and invalid `agent_message` kinds consumed its six-step allowance, leaving it partial. 23 calls, $0.05155, complete reported cost. |

Reports are retained under `.local/live-topology/2026-09-07T<suffix>/` and are
not committed. The last Team failure is not a lost-message diagnosis or a
successful all-member run. Its remaining model choices are not hidden by
loosening the evaluator or reclassifying partial results. One Teto pass does
not prove consistent adoption of its advice; see the smoke contract for limits.

## Publication CI Follow-Up

The first pushed revision, `22728b4`, did not pass GitHub CI. Local unit and
protocol tests alone were not the complete publication gate. Inspection of
runs `34124458557`, `34135759765`, and `34142151765` identified these causes:

- The Goal TUI fixture used an empty scripted model even though creating a
  Goal starts autonomous execution. Its model failure added progress/blocked
  revisions before the edit assertion. Failed assertions then skipped normal
  shutdown, so recursive cleanup raced a still-open Session and could obscure
  the original failure with `ENOTEMPTY`. The fixture now waits for a controlled
  model request, preserves the exact create/edit assertions, and closes the
  TUI and Session even on failure. Deliberate assertion failure was checked
  separately to verify this cleanup path.
- The compaction benefit fixture required an entire 10,000-character filler
  message to survive a 4,096-token input allowance. Host tool schemas and
  stable context legitimately left less room than that. The fixture now
  checks the same explicit fact in raw history and the actual capsule;
  filler-only and header-only inputs must fail. The 8,192-token model window,
  output reservation, request counts, token/byte savings, and no-fallback
  assertions are unchanged. The fake summarizer cannot invent the fact when
  it is absent from its input.
- The offline Worker overlap probe depended on fixed 25/250 ms sleeps. Its
  scripted model now waits for both real provider calls to start, with abort
  handling and a bounded failure deadline. Overlap is still measured from
  actual request intervals; neither timestamps nor successful outcomes are
  fabricated. Ready, cancelled, and timed-out waits all release their timer
  and listener.
- A later local parallel evaluation run hit widespread wall-clock failures
  under concurrent host load. The unchanged 104 evaluations passed when run
  by file serially. The `eval` script now follows the existing unit/smoke
  file-isolation policy; Main/Worker overlap inside each test remains real.
- Revision `70af941` passed all 2,140 tests in both remote environments but
  exposed one more evaluator gap. A 20 ms deadline could expire after the
  provider started on CI, while slower local startup often ended before any
  request. Main correctly recorded `model.cancelled`, which the old verifier
  did not recognize. Verification now requires exactly one matching terminal,
  checks the cancellation's request identity and ordering, and treats the
  cancelled physical invocation as failed, never as a successful arm.

The older Run-switch transcript failure already has the controlled attachment
and stale-event regressions recorded in Round 3. No production behavior,
workflow step, or supported Node version is removed by these CI fixture fixes.

Publication requires typecheck, the full test suite, deterministic evaluations,
CLI/PTY/package smoke tests, and package inspection from the selected revision.
Both GitHub CI matrix jobs (`22.19.0` and `24.x`) must report success for that
same pushed SHA before publication is described as complete. Other agents'
uncommitted UI changes remain outside this validation and these commits.
