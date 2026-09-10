# Team Collaboration Contract

This contract covers shared Team channels, A2G, reusable members, task reports,
cursor history, and structured waiting, including current limitations and
compatibility behavior.

Status: Shared Team channels with incremental membership, reusable assignments,
cursor history, explicit close, and restart-safe claim recovery. Member admission
is limited to 16 members per Team. `team_assign` admits a new named member or
assigns further work to an existing one; `task_wait` waits for a durable task
result or new collaboration without spending model calls on polling. Initial
and follow-up reports are persisted and published to the task thread. The TUI
shows member activity and public group reports. Full artifact-derived change-set
extraction and an editable task board remain follow-up work.

The model-facing `team_create`, `team_assign`,
and `team_reduce` tools do not accept per-member token, attempt, wall-clock,
success-criteria, hard-constraint, Team-deadline, or `dependsOn` fields. The host keeps
claim leases, cancellation, provider timeouts, and Run-level usage accounting.
New tasks have no default aggregate token, duration, or model-call limit.
Finite scheduling slices continue the same task instead of marking it partial.
Legacy task facts and direct host calls may still carry old fields for replay compatibility;
they are not part of the model contract.

## Reference And Adopted Boundary

The behavioral reference is the public
[Claude Code Agent Teams documentation](https://code.claude.com/docs/en/agent-teams),
consulted on 2026-09-07, together with its
[Subagents](https://code.claude.com/docs/en/sub-agents) and
[Hooks](https://code.claude.com/docs/en/hooks) documentation. Claude Code's
private implementation and filesystem layout are not imported or emulated.
There is no source revision or open-source license to attribute for this
public-documentation reference; no Claude Code source is copied.

The adopted collaboration behavior is one fixed lead, independent teammate
contexts, a shared task board, incremental assignment, direct permitted
messages, durable boundary notifications, and lead-owned synthesis. Nausicaa
keeps its existing Ledger, Inbox, task dispatch, and Mowe tool execution boundaries.
Its coordinator adds durable settlement and recovery to the lane collaboration
mechanism already owned by this runtime.

The Team activity display uses the existing pi-tui 0.84.4 components (MIT).
Prime Agent 0.9.1's `subagent-summary-line.js` (MIT) was inspected for its
compact status presentation and cheap render contract. Its private daemon
roster cannot project Nausicaa's Ledger facts, so the adopted boundary is a
small presentation adapter over cached local activity metadata; no roster,
session manager, or polling framework is copied. Rendering must never scan
or clone the conversation history, and elapsed time must not imply progress.

The fixed horizontal margin retains pi-tui's HStack layout node for viewport
and dock coordinates, but uses its Box renderer at one content width. HStack's
intrinsic-size render alternated full and inset widths, invalidating every
historical Markdown/tool cache on each animation frame. A thin render override
avoids that unnecessary measurement without changing upstream code. Completed
assistant and expanded message layouts are reused until content, width or
display settings change. Idle tool rows do not request animation frames;
active Team elapsed-time labels refresh once per second even after lead interruption.

## Ownership And Names

| Term | Responsibility |
|---|---|
| Nausicaa | The root agent that handles the user's request; public in-Run A2A address `nausicaa` |
| Team Lead | The lane that creates a particular Team; defines work, coordinates members, judges sufficiency, and synthesizes |
| Team | Durable coordination scope; has no separate model loop |
| TeamCoordinator | Host control logic for admission, dependencies, safety boundaries, cancellation, deadlines, notifications, and join |
| Teammate / member | An independent named lane with assigned work |
| Worker | One asynchronous delegated task exposed by `delegate_task`; does not implicitly create a Team |
| Reducer | Optional read-only synthesis lane, started explicitly after join |
| Teto | An auxiliary observer attached to an owner lane; uses the same authorized messaging fabric |
| Run fork / branch | Historical lineage operation creating another Run, separate from Team membership |

Only the root agent calls itself Nausicaa. Team members identify themselves by
their own names; Teto identifies itself as Teto. A Team Lead is an ownership
relationship, not another agent named Nausicaa. The lead is the default
synthesizer. There is no hidden coordinator LLM, automatic
reviewer, fixed Planner/Executor/Reviewer chain, or rule promoting a member to
lead. A reducer does not replace its lead or independently accept its own findings.

Ownership follows the actual creator. For a nested Team, members report to that
Team's creating lane rather than the root agent. A member's Teto likewise
reports to that member. Prompts and authorized targets use these actual owner
identities. A normal member may receive the nested Team control catalog when
the lead's grant allows it and the current depth is below three. The nested
lead's `team_message` addresses its parent Team; `child_team_message` and
`child_team_history` address the nested Team so the two group channels cannot
collide. Nested Team controls never expand the creating lane's host permissions.

`members` and `memberId` are canonical immediately. Existing `branches`,
`branchId`, and `team:<teamId>:<branchId>` lane identities remain compatibility
forms. A request must supply exactly one of `members` or `branches`; matching
`memberId` and `branchId` aliases on one item are accepted. Explicit member
names are chosen by the lead through `members[].memberId` and use the existing
normalized subagent naming rules. Omitted names receive available sequential
IDs `worker-1`, `worker-2`, and so on, displayed as `worker 1`, `worker 2`.
Explicit names such as `researcher` and `reviewer` become the members' identities.
Names are unique within a Team after normalization but can repeat across Teams.
Always use the full returned `laneId`, such as `team:review:researcher`, for A2A
routing rather than a display name alone.

The model-facing root address within a Run is `nausicaa`. Its existing durable
lane ID remains `main`: the host resolves the public alias within the current
authorized target set before checking routing and `replyTo`. Legacy `main`
targets remain compatible.
Tool receipts, public endpoint metadata, and observation headers show `nausicaa`;
ledger identities, message IDs, permission grants, and user-provided text retain
their original values. A nested owner's address remains its own full `laneId`.

Only `members` publishes the full model-facing member schema. The deprecated
`branches` schema is compact to avoid duplicating the tool catalog; both paths
still pass through identical strict normalization before host side effects.

## Teto's Auxiliary Role

Teto has its own context and tools and must be attached to an owner: either the
root Nausicaa or a Team member with its own name. The root agent's Teto starts
by default and can be stopped or restarted through the authorized `teto_stop`
and `teto_start` controls. A Team member may start its own Teto for its assigned
task.

Teto receives bounded public projections of subscribed `user.message`,
`assistant.message`, and `tool.requested` events. These reveal part of the owner's
activity, not the owner's complete context or every action. Its prompt assigns
two core tasks:

1. Notice deviations from the user's intent or constraints.
2. Offer improvements when the current solution is inadequate or a
   materially better approach is available.

Teto stays silent toward its owner by default. It may record brief observations
in its own lane transcript without sending them to the owner. Unsolicited
`agent_message` advice is reserved for a new, concrete finding that would change
the owner's next action. Teto may also answer direct A2A requests. There is no
per-request message cap: a long task may reveal several independent problems.
Its observer-specific message schema accepts `inform` and `request`, including
direct replies, and rejects `progress`. Missing or truncated observations are
not evidence that the owner skipped work. Other lanes retain generic A2A kinds.

When there is nothing useful to record or suggest, the prompt asks for ordinary
assistant text `NO_UPDATE` with no tool calls. The runtime treats that text as
part of Teto's transcript, just like its brief observation notes. Ordinary
assistant text is not an A2A delivery; an explicit `agent_message` call sends a
message to the owner. The guidance does not add a host-side semantic judge of
each suggestion's value.

Each observer request ends with a separate current-turn objective: evaluate
the observations and direct A2A requests; when no response is needed, output
`NO_UPDATE` as plain assistant text with no tool calls. This keeps the actual
observation task distinct from quoted owner requests and from private A2A.

The scheduler combines already queued observations in batches of up to 32,
preserving every source event in its transcript. It does not insert a timer or
run an inference for every fact in an accumulated backlog. Exact repeated
unsolicited notes are suppressed against durable A2A history, after permission
and argument validation. Direct replies and retries of an already admitted
operation retain the ordinary A2A contract.

Subscribed content is reference material, not instructions assigning the owner's
task to Teto. Direct A2A messages addressed to Teto are separate coordination
requests, handled within its auxiliary role and existing permissions. The system
prompt states the owner and routing address; event headers supply the observation
boundary and subscription metadata. The shared runtime retains
its untrusted-data rule.

## Model-Facing Operations

| Tool | Meaning |
|---|---|
| `team_create` | Create a Team and admit members whose work is ready to start |
| `team_assign` | Assign ready work to a new or existing named member in the same Team |
| `task_wait` | Wait for an initial or follow-up task's durable result; cancellation releases the wait |
| `team_status` | Read a compact snapshot of durable member outcomes, join, reduction, and presentation state; not a wait operation |
| `team_cancel` | Cancel unfinished Team work, preserve settled results, and fence later work |
| `team_reduce` | Explicitly queue a read-only synthesis lane after join |
| `team_present` | Record the lead's `accepted` or `rejected` decision; the lead still writes the synthesis |
| `agent_message` | Send a directed message to an authorized lane |

Join follows the declared policy automatically. There is no extra `team_join`
tool to poll or to declare success. Tool availability remains host-controlled;
Lead-facing Team lifecycle controls are not implicitly delegated to members.

The in-Run `agent_message` arguments are `target`, `text`, optional `kind`
(`inform`, `request`, or `progress`), and optional `replyTo`. The host owns
correlation, expiry, sender identity, and permission checks. General model-set
`artifactRefs` or `correlationId` arguments are not exposed by this MVP tool.
Its `queued` response proves durable admission, not recipient consumption.
Ordinary messages are limited to 8,192 characters each, 64 pending messages
per sender by default (host-configurable up to 256), and 256 pending messages
per recipient. Expired/handled messages do not occupy these quotas; a repeated
operation retains its idempotent result even when capacity is full, subject to
fresh authorization. Switching between `nausicaa` and the compatible `main`
target does not create a second message for the same operation. Revoking the
recipient grant rejects subsequent sends and operation retries. Task transport
uses its existing separate admission bounds.

Canonical creation input uses flat task fields:

```json
{
  "teamId": "review",
  "members": [
    {
      "memberId": "security",
      "statement": "Review authentication boundaries",
      "capabilities": {
        "tools": ["read_file", "git_diff"],
        "allowNestedTeam": false
      }
    }
  ],
  "peerMessaging": "team-members"
}
```

The `task` wrapper shown in earlier design sketches is not an accepted tool
argument. This keeps the current task input shape while improving membership
names. The runtime can store structured task records internally.

Creation accepts 1 through 16 members, with the same total limit when adding
members later. Names and capability grants are validated before admission.
Only start work whose inputs exist. When later work needs an earlier result,
the lead receives that result and supplies the useful parts in a new assignment:

```json
{
  "teamId": "review",
  "memberId": "compatibility",
  "statement": "Check the security findings against existing clients",
  "input": "Security review is complete. Inspect the reported authentication changes in src/auth.ts and verify compatibility with existing clients."
}
```

This `team_assign` call adds `compatibility` if it is new, or reuses its lane if
it already belongs to the Team. Existing members retain their permissions;
`capabilities` can narrow a new member's inherited grant. No static dependency
graph is required. Legacy durable dependency facts remain readable for recovery.
Model-facing Team creation does not accept member budgets,
success criteria, hard constraints, or Team deadlines. There are no implicit
total task limits; cancellation, request timeouts, and ownership leases remain
host responsibilities. Failed or partial work requires a lead decision before
it is used as input to further work.

Every newly admitted member and reducer carries a scoped SpawnContext, even
without a custom host factory. It contains the actual permitted tool names,
the host-authorized peer targets, and only explicitly supplied project and
parent-summary references. The lead's private history is not copied. Handoffs
carry concise results and artifact references; shared Team history is paginated
and loaded when needed. Attached text has a shared byte limit rather than an unlimited
context allowance per reference.

Reducer tools are restricted to explicitly classified Mowe `read`/`compute`
capabilities, plus topology inspection and authorized messaging. Write,
external, and unclassified custom member tools are not implicitly inherited;
the restriction is enforced by the execution catalog, not just its prompt.

The member statement describes the objective. It does not imply an automatic
semantic validator or a mandatory reviewer. The lead interprets the evidence
and decides whether further work is necessary.

`capabilities` is an optional host-enforced narrowing grant. When omitted, a
member inherits the Team Lead's currently authorized workspace catalog. When
`tools` is present, every name must already exist in that catalog; an unknown
name fails admission rather than granting a new capability. `allowNestedTeam`
controls whether that member receives nested Team controls. These fields are
permissions, not prompt instructions, and the same grant is restored from the
durable Team definition. The root host still decides whether the inherited
catalog includes writes, shell, network, or other external effects.

Parent-Team `team_message` and `team_history` are member communication
capabilities, separate from that workspace grant. They remain available after
reuse and recovery, including for older task manifests that omitted them;
membership, cancellation, and close checks still apply. Nested-Team controls
remain subject to `allowNestedTeam` and the depth limit.

### Resident follow-up Tasks

`team_assign` takes a Team, member name, statement, optional input, and optional
capability narrowing for a new member. A new member is durably admitted into the
existing group; the immutable original `team.created` fact is preserved. An
existing member receives another Task on its own lane. A member cannot have two active follow-up
Tasks. The assignment has a monotonically increasing `assignmentVersion`, so a
late reply from an older Run cannot be accepted as the current Task.

At the terminal boundary the host writes one `team.run.reported` fact with the
Task result or failure, including initial tasks admitted by `team_create`.
The same handoff is published in the shared task thread. `team_status` exposes
the reports, and `task_wait` returns after its task has a durable outcome.
The report wakes an idle lead;
the member's full transcript remains private and can be inspected only through
the existing lane history boundaries.

`task_wait` also accepts the initial task IDs returned by `team_create`. These
return the same member status, outcome, result, and failure as `team_status`.
A completed lane status alone cannot make the task complete. Waiting never
starts, retries, or consumes work; it subscribes to runtime state changes and
can be cancelled. `team_status` remains an immediate snapshot. If the lead has
other ready work, it can continue that work or end the current turn for automatic
report-driven continuation instead of calling `task_wait`.

New consumable Team A2A, group mentions, or other member reports release an
active wait with `waiting: true` and `wakeReason: "collaboration"`. The task
continues; the next ordinary model boundary delivers the messages. Already
delivered messages, including the current uncommitted step, cannot trigger
repeated returns. Terminal task results take precedence. Subscriptions are
removed on return or cancellation. An Inbox lease can schedule a wake at its
actual expiry; there is no model polling or task-duration cap.

Members use these same read tools for their own Team and any nested Teams
they lead. `task_wait` routes by Team ID and rejects waiting for the caller's
own unfinished task or forming a circular wait between members. Permission to create nested Teams is independent of
reading the member's shared task board.

The TUI displays bounded rows of actual Team members with their current phase,
tool names, completed tool count, and elapsed time since activity. Elapsed time
does not imply progress. Public group messages and automatic reports share
the expandable transcript, without exposing private member turns. Cached
projections are invalidated by Ledger revision, including cache replacement;
animation frames do not clone or project the whole event history. Terminal
lane status alone is not labelled as a report.

Group chat enters context through explicit `team_message.mentions`: use a
member ID, its full lane ID, or `nausicaa` for the root lead. An idle lead may
resume; an active member receives the message at its next natural boundary.
A completed member stays idle until `team_assign` gives it more work.
Unmentioned chat remains available through `team_history`.

Each boundary includes at most eight group mentions with bounded excerpts and
history cursors. Committed step receipts mark them consumed, so restart restores
unread mentions without replaying those already consumed. Group messages stay
in their own Team, including nested Teams; they do not create an A2A copy.
Closed or cancelled Teams do not deliver new mentions or wake a lane.

On restore, an assignment without a report is re-admitted idempotently and its
member lane is rebuilt in dynamic-task mode. A reported assignment is never
run a second time. If its terminal notification or request acknowledgement is
missing, recovery repairs the handoff from the verified report and wakes the
lead after the message is durable. Closing a Team fences new assignment and wakeup admission;
existing reports remain readable.

## Completion Is Several Different Facts

```text
member execution:  queued -> claimed -> running -> terminal
task outcome:      succeeded | partial | failed | cancelled | abandoned
Team join:         waiting -> joined | deadline-settled | cancelled
reduction:         not-started -> running -> completed | failed
Lead presentation: pending -> accepted | rejected
```

A provider returning a final answer establishes an execution boundary. It does
not prove that the answer satisfies the task. A task outcome needs a validated
result or explicit settlement; `lane.status = completed` alone is insufficient
and must appear as an anomaly when its corresponding outcome is missing.

`partial` is terminal for that task attempt, but not success. Idle means the
lane is not currently executing work; it says nothing about semantic quality.
The member executor handles one assignment at a time. The lead can reuse a
settled member through `team_assign`; members do not self-claim new tasks.
Dynamic task-board editing remains a separate extension.

Join collects outcomes at a declared boundary. It does not perform synthesis.
The lead may assign a repair to the responsible member, request another review
when useful, inspect results and synthesize directly, or request reduction:

```text
team_create -> member work -> durable settlements -> automatic team.joined
  -> Lead synthesis -> team_present -> Lead answer
  or
  -> team_reduce -> durable team.reduced -> Lead review -> team_present -> Lead answer
```

`team_present` requires admitted work to have settled, including new members
and follow-up assignments. It is the lead's recorded decision, not proof that text has already
reached the user. Accepting a Team result does not rewrite failed or partial
task outcomes. A notification is a delivery fact and cannot by itself settle a
task, join a Team, or complete reduction.

## Policies And Lifetime

- Default join policy: `all-terminal`, covering every `required` member.
- Default membership requirement: `required: true`.
- Model-facing Team creation always uses the durable `all-terminal` join
  boundary. Legacy deadline settlement facts remain readable for recovery, but
  the model cannot choose a Team deadline or abandon active members through a
  per-call time budget.
- Default peer policy: `team-members`; authorized members can communicate
  directly within the Team. `lead-only` limits member conversations to their lead.
- Default synthesis: the lead; a Reducer exists only after explicit `team_reduce`.
- `team_reduce` has no implicit task token, duration, or attempt cap. Explicit
  host limits in legacy requests retain their original recovery semantics.
- Default one-shot ownership: wait for active admitted Team work and
  declared settlement boundaries, subject to explicit host cancellation or
  limits. Expiry or shutdown must persist an explicit
  outcome; a short silent drain-and-stop is not Team completion.

Team definitions, added member identities, legacy dependency edges, policies, and outcomes
must reconstruct from durable facts after restart. Claims retain attempt and
ownership information. A stale claimant or a late message must not overwrite
a settled task or reopen cancelled work. Cancelling a Team preserves results
that already settled; stopping the Run must settle or explicitly transfer
remaining ownership before returning a completed presentation.

Run cancellation first aborts Nausicaa, then serializes Team cancellation with
pending admissions. Creation and reduction recheck cancellation at persistence
boundaries. Join waiting follows durable outcomes and does not await an
uncooperative tool forever; a timed-out or cancelled executor is fenced, and
an unknown external side effect still requires reconciliation.

Interactive `Esc` or `Ctrl+C` during execution interrupts the current lead turn
and preserves the Run, history, and Team. Members can finish and report into the
same Run, but reports do not automatically undo a user's interruption: the next
user input resumes coordination with those reports available. A normally
completed lead turn still resumes automatically for arriving reports.
`/stop` and direct `SessionController.cancel()` calls cancel Team work too;
`team_cancel` cancels the selected Team.

Forced interruption records explicitly annotated read/compute tools, including
`task_wait`, as cancelled failures. Started write, external, or unannotated
tools retain an unknown outcome if their result cannot be established. Old
unknown outcomes still require the existing `/resolve` path; tool names alone
cannot establish a historical extension's effects.

If a provider or tool ignores cancellation beyond the grace period, the host
fences that old execution and releases its slot while preserving the attachment.
Unstarted tools receive explicit cancelled results. Started tools with unknown
outcomes retain the existing resolution boundary; late results cannot overwrite
a subsequent turn. This fencing prevents stale runtime commits, not external
side effects from an adapter that ignores its cancellation signal.

Both entry points allow member questions and updates to reach the lead before
join. The one-shot path waits for admitted Team work and an explicitly
requested reduction to settle before presenting the final answer. Interactive
sessions instead allow the current lead turn to complete while members work;
durable reports schedule a new continuation. Active steps can read individual
results as they arrive. Result and join notices use an ordinary model boundary,
subject to any explicit host allowance. Deferred/next-turn
messages do not force empty steps, and a recovered uncommitted claim is allowed
to become deliverable before another model step is spent. The hook does not
silently raise an explicit legacy hard allowance. The default 24-step activation
is a scheduling slice: the lead yields to the event loop, checks cancellation,
and continues the same task and context. Slice exhaustion alone does not require
the user to type `/resume`. Provider truncation, interruption, and unknown tool
effects retain their explicit recovery boundaries.

Members also check their mailbox before accepting a no-tool final response.
An authorized message that arrived during that response gets another ordinary
step when it is already claimable. This uses the existing completion hook,
does not wait for future mail, and never raises the model budget. Expired,
deferred, next-turn, and still-leased messages do not force extra requests.
Messages arriving after settlement do not reopen a task. A lane that stops
without any report produces an explicit failure, not an invalid empty result.

The `team_status` tool omits admission context, leases, and the duplicate
legacy `branches` representation. It retains canonical members, their result
and failure evidence, and join/reduction/Lead acceptance. The host's durable
TeamBoard and legacy input aliases are unchanged.

In an open interactive session, a member report automatically starts a new
lead turn after normal completion. Reports arriving while the lead is busy or
releasing its execution slot remain pending and are coalesced at a safe boundary.
Attach/resume checks persisted reports too. Cancellation, interruption, failure,
explicit waiting, and session closure do not trigger this automatic continuation;
those boundaries retain their normal recovery paths. This does not provide a
detached daemon owner. No status polling is required. Messages
stay bounded and directed; the host supplies sender identity and enforces the
current topology. Message text cannot grant tools, change permissions, or
impersonate Nausicaa or another lane.

## L0 Boundary

Team members currently reuse `MainLoop`; Worker has its own task loop.
Both tool execution paths use Mowe. The standalone `L0AgentLoop` is presently
a tested behavior reference, not a replacement underlying both runtimes.
Extracting another abstraction is not required to implement the collaboration
contract.

One concrete parity correction is included: a provider response with
`stopReason: "aborted"` cannot execute tool calls or trigger another model
request in the same activation, even if the caller's AbortSignal is still
live. Nausicaa and Worker record rejected tool results so their durable transcript
remains paired; Nausicaa stays incomplete and Worker returns a partial outcome.
Provider usage still settles. Explicit later Nausicaa resume is allowed.

The broader Pi behavior gate, Worker continuation after length truncation,
complete capability-manifest parity, and lazy auxiliary initialization remain
separately reviewable work. This implementation does not claim that matching
Team terminology alone makes those behaviors identical.

## Deferred Extensions

Member self-claim tools, `quorum`, and `any-success` are not implemented.
The lead controls task order through incremental `team_assign` calls.
Nested Team creation is available to an authorized member while its depth is
below three. A nested member becomes that child Team's Lead; the parent Team
remains responsible for its own report and the child Team remains responsible
for its own synthesis. At depth three the host omits `team_create` and rejects
further admission. Nested Team state uses the same Ledger, Inbox, channel and
recovery boundaries as its parent and is stopped recursively when the parent
Team closes or is cancelled.
Membership can grow while the Team is open. A member completing its task remains
available for an explicit assignment while the Team is open; a message alone
does not start a new task.

Dedicated exhaustive crash-point/capacity testing and the separate Pi ecosystem
audit remain open. Focused recovery tests protect the implemented admission,
settlement, transport-loss, cancellation, and boundary contracts; they do not
prove every possible crash interleaving.

## Original Implementation Verification (2026-09-07)

- [x] Canonical/legacy creation and strict direct-runtime normalization tests.
- [x] Lifecycle tool schemas, authenticated context forwarding, and errors.
- [x] Provider-aborted Nausicaa/Worker behavior and explicit Nausicaa resume tests.
- [x] Integrated durable board, dependency, cancellation, join, and reduction tests.
- [x] Integrated peer A2A, safe-boundary delivery, and one-shot lifetime tests.
- [x] Compact compatibility schema retains strict parsing and compaction recovery.
- [x] Scoped member/reducer context, tool-manifest agreement, and read-only reducer enforcement.
- [x] Cancellation during admission, uncooperative tool deadlines, and clean/unknown-effect recovery.
- [ ] Broader Pi parity audit, exhaustive crash/capacity gate, and simple-path laziness.
- [x] Integrated typecheck, build, and collaboration regression tests.
- [ ] Completely green repository test gate: one timeout-recovery case failed in the full run and passed in isolation.

Focused suites include `team-tool.test.ts`, `team-collaboration.test.ts`,
`team-completion-boundary.test.ts`, and `agent-loop-abort-parity.test.ts`.
Additional suites cover admission cancellation, uncooperative tool deadlines,
pre-join questions, terminal-notification batching, leased-message recovery,
and unknown tool outcomes.

Verification recorded on 2026-09-07:

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test -- --reporter=dot`: 1,937 passed, 1 failed across 180 files.
- `git diff --check`: passed.

The initial collaboration-only run failed the existing `interactive-tui.test.ts`
case "clears the previous transcript when an attached Run cannot hydrate its
artifacts". That case examines raw terminal output during an asynchronous
switch; isolated runs produced both failures and passes.

The subsequent pre-commit integration includes fullscreen TUI and selector
lifecycle changes. Selection callbacks settle their chosen value before
disposal can cancel the pending operation. Its verification results were:

- `npm test`: 1,937 passed, 1 failed across 180 files; all 87 TUI tests passed.
- The sole failure was `session-controller.test.ts`, "uses distinct recovery
  boundaries when the same Turn times out repeatedly". With its 100 ms request
  timeout, the model had not been called at the first assertion; failed cleanup
  also reported `ENOTEMPTY`. The unchanged case passed when rerun alone.
- Six focused login, logout, and permission tests passed.
- `npm run test:smoke`: build and all 15 tests passed, including the real PTY.

The isolated rerun does not erase the integrated failure. The repository-wide
gate is not claimed green.

The standard suite excludes live, eval, and smoke tests. No live provider or
online Claude Code comparison was run as part of this implementation gate.
