# Team Collaboration Contract

Status: bounded one-task-per-member collaboration MVP implemented on
2026-09-07; collaboration checks passed, with one timing-sensitive verification
failure recorded below. This document records the implemented boundary and
remaining extensions. It does not claim that
every PRD phase has passed its acceptance gate.

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
contexts, a shared task board, dependency-aware assignment, direct permitted
messages, durable boundary notifications, and lead-owned synthesis. Nausicaa
keeps its existing Ledger, Inbox, task dispatch, and Mowe tool execution boundaries.
Its coordinator adds durable settlement and recovery to the lane collaboration
mechanism already owned by this runtime.

## Ownership And Names

| Term | Responsibility |
|---|---|
| Main / Team Lead | Defines work, coordinates members, judges sufficiency, synthesizes, and answers the user |
| Team | Durable coordination scope; has no separate model loop |
| TeamCoordinator | Host control logic for admission, dependencies, budgets, cancellation, deadlines, notifications, and join |
| Teammate / member | An independent lane assigned a bounded task |
| Worker | One bounded delegated task exposed by `delegate_task`; does not implicitly create a Team |
| Reducer | Optional read-only synthesis lane, started explicitly after join |
| Teto | An auxiliary observer owned by a Main lane; uses the same authorized messaging fabric |
| Run fork / branch | Historical lineage operation creating another Run, separate from Team membership |

Main is the default synthesizer. There is no hidden coordinator LLM, automatic
reviewer, fixed Planner/Executor/Reviewer chain, or rule promoting a member to
lead. A reducer does not replace Main or independently accept its own findings.

`members` and `memberId` are canonical immediately. Existing `branches`,
`branchId`, and `team:<teamId>:<branchId>` lane identities remain compatibility
forms. A request must supply exactly one of `members` or `branches`; matching
`memberId` and `branchId` aliases on one item are accepted. Explicit member
names use the existing normalized subagent naming rules.

Only `members` publishes the full model-facing member schema. The deprecated
`branches` schema is compact to avoid duplicating the tool catalog; both paths
still pass through identical strict normalization before host side effects.

## Model-Facing Operations

| Tool | Meaning |
|---|---|
| `team_create` | Admit members and their task definitions; return stable identities, not completed work |
| `team_status` | Read the durable board, outcomes, join, reduction, and presentation state |
| `team_cancel` | Cancel unfinished Team work, preserve settled results, and fence later work |
| `team_reduce` | Explicitly queue a bounded read-only synthesis lane after join |
| `team_present` | Record Main's `accepted` or `rejected` decision; Main still writes the answer |
| `agent_message` | Send a directed message to an authorized lane |

Join follows the declared policy automatically. There is no extra `team_join`
tool to poll or to declare success. Tool availability remains host-controlled;
Main-facing Team lifecycle controls are not implicitly delegated to members.

The in-Run `agent_message` arguments are `target`, `text`, optional `kind`
(`inform`, `request`, or `progress`), and optional `replyTo`. The host owns
correlation, expiry, sender identity, and permission checks. General model-set
`artifactRefs` or `correlationId` arguments are not exposed by this MVP tool.
Its `queued` response proves durable admission, not recipient consumption.
Ordinary messages are limited to 8,192 characters each, 64 pending messages
per sender by default (host-configurable up to 256), and 256 pending messages
per recipient. Expired/handled messages do not occupy these quotas; a repeated
operation retains its idempotent result even when capacity is full. Task
transport uses its existing separate admission bounds.

Canonical input uses flat task fields:

```json
{
  "teamId": "review",
  "members": [
    {
      "memberId": "security",
      "statement": "Review authentication boundaries",
      "successCriteria": ["Return concrete findings with evidence"],
      "hardConstraints": ["Read-only"],
      "maxModelTokens": 12000
    },
    {
      "memberId": "compatibility",
      "statement": "Check the security findings against existing clients",
      "dependsOn": ["security"],
      "required": true
    }
  ],
  "joinPolicy": "all-terminal",
  "peerMessaging": "team-members"
}
```

The `task` wrapper shown in earlier design sketches is not an accepted tool
argument. This keeps the current task input shape while improving membership
names. The runtime can store structured task records internally.

Creation accepts 1 through 16 members. All explicit identities and dependency
references are validated before admission: duplicate names after normalization,
unknown dependencies, self-dependencies, cycles, unsupported fields, and
invalid budgets fail before dispatch. Only members that are not referenced by
another task may rely on generated names. A dependent task starts after its
prerequisites succeed; partial or failed output cannot silently satisfy a
success dependency.

Every newly admitted member and reducer carries a scoped SpawnContext, even
without a custom host factory. It contains the actual permitted tool names,
the host-authorized peer targets, and only explicitly supplied project and
parent-summary references. Main's private history is not copied. Prerequisite
results enter dependent tasks as bounded, untrusted summaries and artifact
references. Attached text has a shared byte limit rather than an unlimited
context allowance per reference.

Reducer tools are restricted to explicitly classified Mowe `read`/`compute`
capabilities, plus topology inspection and authorized messaging. Write,
external, and unclassified custom member tools are not implicitly inherited;
the restriction is enforced by the execution catalog, not just its prompt.

Criteria and constraints describe the objective. They do not imply an
automatic semantic validator or a mandatory reviewer. Main interprets the
evidence and decides whether further work is necessary.

## Completion Is Several Different Facts

```text
member execution:  queued -> claimed -> running -> terminal
task outcome:      succeeded | partial | failed | cancelled | abandoned
Team join:         waiting -> joined | deadline-settled | cancelled
reduction:         not-started -> running -> completed | failed
Main presentation: pending -> accepted | rejected
```

A provider returning a final answer establishes an execution boundary. It does
not prove that the answer satisfies the task. A task outcome needs a validated
result or explicit settlement; `lane.status = completed` alone is insufficient
and must appear as an anomaly when its corresponding outcome is missing.

`partial` is terminal for that task attempt, but not success. Idle means the
lane is not currently executing work; it says nothing about semantic quality.
The current bounded member executor handles an assigned task, rather than a
fully resident Claude-style teammate that repeatedly self-claims new tasks.
Persistent reusable members and dynamic task-board editing remain separate
future extensions and must not be inferred from the `Team` name.

Join collects outcomes at a declared boundary. It does not perform synthesis.
Main may inspect results and answer directly, or explicitly request reduction:

```text
team_create -> member work -> durable settlements -> automatic team.joined
  -> Main synthesis -> team_present -> Main answer
  or
  -> team_reduce -> durable team.reduced -> Main review -> team_present -> Main answer
```

`team_present` is Main's recorded decision, not proof that text has already
reached the user. Accepting a Team result does not rewrite failed or partial
task outcomes. A notification is a delivery fact and cannot by itself settle a
task, join a Team, or complete reduction.

## Policies And Lifetime

- Default join policy: `all-terminal`, covering every `required` member.
- Default membership requirement: `required: true`.
- Optional join policy: `deadline-best-effort`; requires an absolute ISO
  timestamp with a timezone. The deadline is normalized to UTC and persisted.
- Default peer policy: `team-members`; authorized members can communicate
  directly within the Team. `lead-only` limits member conversations to Main.
- Default synthesis: Main; a Reducer exists only after explicit `team_reduce`.
- Reducer default model allowance: 12,000 tokens; the shared protocol ceiling
  is 1,000,000 model tokens and 30 minutes of wall-clock time. The effective
  allowance also respects the remaining Run budget and host policy.
- Default one-shot ownership: bounded wait for active admitted Team work and
  declared settlement boundaries. Expiry or shutdown must persist an explicit
  outcome; a short silent drain-and-stop is not Team completion.

Team definitions, member identities, dependency edges, policies, and outcomes
must reconstruct from durable facts after restart. Claims retain attempt and
ownership information. A stale claimant or a late message must not overwrite
a settled task or reopen cancelled work. Cancelling a Team preserves results
that already settled; stopping the Run must settle or explicitly transfer
remaining ownership before returning a completed presentation.

Run cancellation first aborts Main, then serializes Team cancellation with
pending admissions. Creation and reduction recheck cancellation at persistence
boundaries. Join waiting follows durable outcomes and does not await an
uncooperative tool forever; a timed-out or cancelled executor is fenced, and
an unknown external side effect still requires reconciliation.

Before a normal Main completion, both one-shot and interactive paths allow
live member questions and updates to reach Main before join. Without pending
ordinary collaboration messages, they wait for admitted Team work and an
explicitly requested reduction to settle. A finishing Main collects pure
terminal notifications together at join; its normal active steps can still
read individual results as they arrive. Result and join notices get another ordinary
boundary, subject to Main's existing step/token allowance. Deferred/next-turn
messages do not force empty steps, and a recovered uncommitted claim is allowed
to become deliverable before another model step is spent. The hook does not
silently raise that allowance or create another model loop. Exhaustion leaves
Main incomplete rather than claiming the Team evidence was incorporated.

Interactive members can still outlive a budget-stopped or interrupted Main
activation. Notifications remain durable until the next normal or explicitly
resumed Main boundary. This MVP does not autonomously reopen an idle Main turn
or bypass exhausted budgets, and it does not supply a detached daemon owner.
No status polling is required for delivery at an available boundary. Messages
stay bounded and directed; the host supplies sender identity and enforces the
current topology. Message text cannot grant tools, change permissions, or
impersonate Main.

## L0 Boundary

Team members currently reuse `MainLoop`; Worker has its own bounded task loop.
Both tool execution paths use Mowe. The standalone `L0AgentLoop` is presently
a tested behavior reference, not a replacement underlying both runtimes.
Extracting another abstraction is not required to implement the collaboration
contract.

One concrete parity correction is included: a provider response with
`stopReason: "aborted"` cannot execute tool calls or trigger another model
request in the same activation, even if the caller's AbortSignal is still
live. Main and Worker record rejected tool results so their durable transcript
remains paired; Main stays incomplete and Worker returns a partial outcome.
Provider usage still settles. Explicit later Main resume is allowed.

The broader Pi behavior gate, Worker continuation after length truncation,
complete capability-manifest parity, and lazy auxiliary initialization remain
separately reviewable work. This implementation does not claim that matching
Team terminology alone makes those behaviors identical.

## Deferred Extensions

Resident reusable teammates, member self-claim tools, task reassignment,
dynamic task-board editing, `quorum`, and `any-success` are not implemented.
The board and coordinator currently operate on the bounded member/task set
declared at creation. A member completing its task is not a resident worker
becoming idle and waiting for a new assignment.

Dedicated exhaustive crash-point/capacity testing and the separate Pi ecosystem
audit remain open. Focused recovery tests protect the implemented admission,
settlement, transport-loss, cancellation, and boundary contracts; they do not
prove every possible crash interleaving.

## Verification Progress

- [x] Canonical/legacy creation and strict direct-runtime normalization tests.
- [x] Lifecycle tool schemas, authenticated context forwarding, and errors.
- [x] Provider-aborted Main/Worker behavior and explicit Main resume tests.
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

Final verification on 2026-09-07:

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
