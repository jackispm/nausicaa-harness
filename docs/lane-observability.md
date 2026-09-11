# Lane Observability

## Identity And Discovery

`agent_awareness` returns a host-bound `self` endpoint separately from its
bounded topology snapshot. Compare the complete workspace/session/run/lane
tuple, not a role name such as `main` or `teto`. Cross-Run messaging and
Awareness use the same authenticated sender identity when one is configured.
Team members use their host-issued spawn identity.

Discovery does not grant messaging permission. A string target such as `teto`
addresses the current Run. A cross-Run selector such as
`{ "relationship": "direct", "id": "session-id" }` addresses another reachable
session's Main, subject to the existing router's admission and authorization.
Seeing a foreign Teto does not make it the caller's observer or a direct target.

Live workspace observations are timestamped after disk reads, so a heartbeat
written during those reads is not mistaken for a future timestamp. Explicit
replay times retain strict clock semantics. Stale, invalid, inaccessible, and
out-of-bounds records can still be absent; absence does not prove nonexistence.
Live nodes receive capacity before diagnostic history, including when the
snapshot is redacted a second time. History uses only the remaining budget.

## State And Versions

Pre-registration is not activation. Unused Teto/Worker slots are excluded from
the live view; durable start, task admission, or execution evidence identifies
lanes that have actually been activated. Recovery preserves this distinction.

Main can be idle while its Teto finishes an observation. `teto_status.active`
means the observer is enabled, whereas topology `active` describes recorded
execution state. A session heartbeat proves host presence, not new progress on
every lane. Main's task summary follows Main's Turn lifecycle, not an auxiliary
lane's later legacy Turn events. Historical checkpoint serialization is unchanged.

An active Teto observes Main in completed-step order. User messages, assistant
outputs, tool requests, and bounded tool terminal states are queued while a Main
step is running; the queue is released when `step.completed` or `step.failed`
is durable. Completed steps stay intact and queued completed steps are coalesced
before the next inference. Teto never blocks Main, and a user message alone
does not start an observation. A one-shot host gives a released batch a short
dispatch handoff before closing the auxiliary lane; it does not wait for a slow
Teto response. Raw tool results remain outside the projection.

`/list-agents` displays a point-in-time snapshot with a timestamp. Each session
also displays its loaded build ID, or `unknown` for older/source-mode hosts.
The build pipeline hashes emitted JavaScript and dependency metadata into a
module constant. Rebuilding disk files does not upgrade running processes;
they must be restarted to load new code. Build IDs are diagnostic labels, not
integrity attestations or credentials.

## Visible Messages

Explicit same-Run `message.inform`, `question.ask`, and `question.answer` events
appear as Agent messages in both live and restored transcripts, with sender
and recipient. Both event and envelope must have `run` or `user` visibility.
Private/lane/sensitive auxiliary content and raw auxiliary assistant replies
are not promoted into Main's user transcript. Duplicate message IDs produce
one message block; a sent message is not proof that its recipient consumed it.

Ordinary cross-Run messages use the same live and restored presentation after
envelope identity validation. The sender's durable outbox entry is labelled
`Agent message submitted`, not delivered. The receiver's durable message is
labelled received. Endpoint labels distinguish sessions and non-Main lanes;
parent/child labels are interpreted from the local participant's perspective.
Main's derived input wrapper is deduplicated against the original message.
Legacy task/advice messages retain their live notices and are outside this
ordinary-message resume contract.

Private cross-Run messages remain available to their intended Main, but their
derived input admission, replacement, queue display, and replay remain private.
Historical wrappers mistakenly marked public are filtered using their durable
source message. This is a payload-visibility boundary, not semantic taint
tracking of anything Main might subsequently say. Ordinary message bodies
permit line breaks and tabs but reject unsafe terminal controls. A wrapper's
closing marker appearing within its body does not truncate the displayed text.

Run switching clears the previous transcript before attaching, restores it if
attachment is rejected, and fences stale events and slow history reads from a
superseded navigation. An old read cannot append its text to the newly attached
Run or resume a different Run by mistake.
Explicit resume also binds the requested Run inside the host's admission queue.
Rejected new/fork/import navigation rehydrates the still-attached Run so
invalidated reads cannot leave its history permanently absent.

New ordinary Runs give tool-using Teto a 1,024-token output cap instead of 64.
This is a ceiling, not a target response length. Explicit and persisted caps
remain authoritative: resuming an old 64-token Run does not silently change its
policy. Start a new Run to use the new default. Length-truncated tool calls
remain fail-closed, even when partial arguments happen to be valid JSON.

## Upstream Boundary

Reference inspected: Prime Agent 0.7.2, commit
`7787f07415d843b9a800f6a4720e0c739bd608e5`, MIT (Mario Zechner and Prime Intellect).
Its daemon session list derives child activity from runtime task tracking, not
assistant prose; its summarizer separates system instructions from conversation
data. These behaviors inform the boundary, but no Prime subsystem is copied.
Prime has no equivalent persistent Teto observer, and this inspected version's
loop is not an oracle for length-truncated tool rejection. Nausicaa retains its
stricter existing guard. Message rendering reuses the existing pi-tui-backed
`AgentMessageBlock` instead of adding a second transcript renderer.
