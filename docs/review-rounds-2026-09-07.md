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

Rounds 4 and 5 are pending.
