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

Rounds 3 through 5 are pending.
