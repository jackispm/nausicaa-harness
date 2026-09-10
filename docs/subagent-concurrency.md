# Independent Subagent Admission

Status: implemented, 2026-09-10.

## Requested behavior

Ordinary `delegate_task` creates an independent task lane. One Main may have
up to 16 unfinished subagents at once. Finished tasks release capacity; 16 is
not a lifetime task limit. Admission returns a stable task/lane identity and
does not wait for the answer. Independent children may execute concurrently
with each other and Main. Each retains its own bounded context, host safety
boundary, failure outcome, and durable result delivery.

Subagents remain distinct from Team membership. Creating a subagent does not
create a hidden Team, task dependency board, reducer, or additional Main.

## Reference and reuse decision

Reference: Prime Agent v0.7.2, revision
`7787f07415d843b9a800f6a4720e0c739bd608e5`, MIT. Inspected
`packages/coding-agent/src/core/prompts/rlm.ts` and the runtime subagent
registry contract. Adopt the independent child handle, immediate admission,
parent-scoped discovery, and asynchronous result boundary. Do not adopt its
Python/RLM execution surface or daemon process composition: Nausicaa already
owns those boundaries through Ledger, Inbox, WorkerTaskExecutor, and
WorkerLaneScheduler. No upstream source is copied. This change composes those
existing executors and schedulers into separately addressed child lanes.

## Runtime boundary

- Serialize child admission and count durable unfinished requests, so racing
  calls and recovery cannot exceed 16 children. Duplicate admission returns
  the existing identity without another slot or model call.
- Persist task intent and register only admitted lanes; reconstruct a missing
  registration after interruption. Never populate discovery with empty slots.
- Start a separate existing Worker executor/scheduler for each child. Keep
  shared Run accounting and existing read-only Worker restrictions; the model
  does not choose a child token, attempt, or wall-clock budget.
- Deliver results from each child at normal Main boundaries and acknowledge
  only committed consumption. A finishing Main allows admitted children to
  settle before incorporating their results, within its existing allowance.
- Preserve legacy requests addressed to `worker` on recovery and the frozen
  single-Worker evaluation composition when `auxiliaryMode` is explicit.
- Use `agent_awareness` for current lane states; admission returns `laneId`
  as well as `taskId` and `messageId`.

## Team coordination and permissions

Current Team members are independently named lanes with MainLoop
instances. `team_status`, directed A2A messages, result notifications, and join
notifications inform the lead at normal execution boundaries. `team_assign`
reuses a settled member for a later task. Durable Team reports wake a normally
completed lead in an open interactive session; ordinary private messages do
not themselves assign a new task to a settled member.

Default delegated Workers remain read-only. Team members inherit the current
host-authorized workspace catalog, including writes and shell when granted;
the lead may narrow each member's capabilities during creation. A child can
never gain permissions beyond its creating lane's authorized catalog. See
[Team collaboration](team-collaboration.md) for that separate lifecycle.

## Verification requirements

Exercise real overlapping scripted provider intervals; 16 admitted children
and rejection of a racing 17th; capacity reuse after settlement; duplicate
admission; restart and partial admission repair; per-child result routing;
cross-child context isolation; cancellation; no phantom live agents; and
Main consumption of terminal results. Keep existing Worker recovery, Team,
Teto, permission, and deterministic evaluation gates.
