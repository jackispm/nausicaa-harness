# Portable Workflow Gap Audit

Baseline: beta capability catalog at `6e8e9c3` (the catalog changes in this
worktree are tracked separately). This is a planning document: it distinguishes
model-backed workflows from deterministic protocol and presentation checks.

## Already Covered

The unified catalog has 19 cases covering read, batch read, search, exact
mutation, shell round trips, bounded output, scoped discovery, edge/skill
activation, workspace instructions, Worker delegation, Run recovery,
compaction, and capability denial. Each case records objective state and the
final answer outcome independently.

## High-value gaps

| Priority | Proposed case | Upstream basis | Observable contract | State |
| --- | --- | --- | --- | --- |
| P0 | `session-tree-branch` | Pi session branching/tree navigation; Prime tree tests | Create two descendants from one checkpoint, switch between them, and verify parent/child metadata and isolated state | Add after the public branch contract is frozen |
| P0 | `rpc-attach-continuity` | Pi JSONL RPC/client tests; Prime remote attach tests | Submit through daemon, detach, reattach, continue the same Run, and preserve cursor/event order | Add after attach submission semantics are public |
| P0 | `goal-continuation` | Prime goal/autonomous/action tests | Continue while objective state is incomplete, stop only after host verification, and reject a text-only completion claim | Can be added with existing host verifier |
| P1 | `steering-follow-up-order` | Pi steering/follow-up queue tests; Prime queue tests | Inject steering and follow-up while a Run is active and verify deterministic delivery order | Add with a deterministic timing harness |
| P1 | `cross-run-a2a-awareness` | Prime bus/observe/topology tests | Multiple Runs exchange typed messages, receive receipts, and render a stable awareness topology | Keep as a separate collaboration gate |
| P1 | `daemon-restart-recovery` | Prime daemon/supervisor/recovery tests | Restart the host and recover pending durable inputs without claiming that an unknown side effect ran | Keep as a separate daemon gate |

## Do not mix into the capability score

- Provider-specific payload, reasoning, cache, image, and account checks.
- RPC framing, terminal snapshots, browser replay, and other presentation-only
  checks.
- Python/kernel execution environments that belong to a particular upstream
  harness.
- External search or sandbox services whose availability is independent of the
  Nausicaa runtime.

These remain useful integration probes, but a skipped provider or unavailable
daemon must not become a model-quality failure.

## Execution order

1. Add the three P0 workflows with host-controlled boundaries and objective
   graders.
2. Add steering/follow-up after the queue timing contract is deterministic.
3. Add cross-Run awareness and restart recovery as separate gates once daemon
   topology and roster composition are public.

The inventories in `/private/tmp` contain the upstream source paths and license
notes. `docs/testing/upstream-live-task-matrix.md` remains the authoritative
classification of what is workflow-live, provider-live, or protocol/UI-only.
