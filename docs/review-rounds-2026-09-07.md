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

Rounds 2 through 5 are pending.
