# Changelog

All notable changes to Nausicaa are documented here.

## [Unreleased]

## [0.1.7] - 2026-09-11

- Show Team member phases, current tools, and time since activity in both TUI
  modes. Render public group messages and reports while the lead is interrupted.
- Cache session and Team activity projections by Ledger revision so animation
  frames do not repeatedly clone and project a growing event log.
- Keep transcript margins at a stable render width so TUI animation does not
  repeatedly invalidate historical tool and Markdown layouts and stall work.
- Make the default agent prompt explicitly require performing authorized
  actions before ending a turn instead of stopping at a promise to act.
- Yield active task waits for new Team collaboration and other member reports;
  preserve the original task, avoid repeated delivery, and reject circular waits.
  Deliver nested-Team reports through the member lead's ordinary boundaries.
- Record forced cancellation of explicitly read/compute tools as cancelled
  failures; retain unknown outcomes for uncertain side effects.
- Give Teto an observer-specific A2A schema without progress updates and clarify
  that missing observations do not prove the owner skipped an action. Separate
  its current observation objective from quoted owner requests; keep silent
  notes as ordinary text. Add real-provider replays of recorded observations.

## [0.1.6] - 2026-09-11

- Preserve the current Run, conversation, and asynchronous Team work when
  Escape or Ctrl+C interrupts the lead. Keep member reports for the next user
  input; `/stop` still cancels Team work.
- Release cancelled executions after their grace period and fence late runtime
  writes. Distinguish unstarted tools from unknown side effects without
  detaching the session or losing its history.
- Deliver Team group mentions to the recipient's next context boundary and
  wake normally idle leads. Support `nausicaa` and full lane addresses, preserve
  nested-Team isolation, and recover unread mentions without replaying receipts.
- Coalesce queued Teto observations, preserve each source fact, and suppress
  exact repeated unsolicited notes. Keep its two core tasks and reserve A2A
  for concrete new findings or direct replies.
- Correct the compaction evaluation fixture so its control keeps full history;
  retain the requirement that measured savings exceed summarization cost.

## [0.1.5] - 2026-09-10

- Replace model-facing dependency graphs with incremental Team assignment:
  add new members when their work is ready and reuse the same members for
  follow-up work, with concise handoffs and the original permission boundary.
- Make `task_wait` wait on durable task events without repeated model calls.
  Keep `team_status` as the immediate status query.
- Continue the lead across default 24-step scheduling slices, retaining
  cancellation, output truncation, and explicit legacy hard-limit recovery.
  Reject tool calls from unsupported provider stop reasons before execution.
- Publish initial task reports into the same shared threads as later reports.
  Give members bounded group context and reserve A2A for private coordination.
- Preserve actual tool grants through nested Teams and allow a new acceptance
  decision after members complete reassigned work.
- Wake the lead after terminal handoff commits and repair missing terminal
  messages after restart without rerunning completed member work.
- Route member status and waiting tools to the Team they belong to or manage,
  including members without permission to create nested Teams.
- Add a natural-language calendar/Todo live probe without prefilled tool
  arguments or instructions telling the model how to wait.

## [0.1.4] - 2026-09-10

- Remove model-controlled task budgets, attempt counts, deadlines, success
  criteria, and hard-constraint fields from delegation and Team tools. New
  tasks have no implicit total token, duration, or model-call cap; cancellation,
  provider timeouts, usage accounting, and explicit legacy host limits remain.
- Keep Team members working after the interactive lead finishes a turn. Wake
  the lead when durable reports arrive, including during execution cleanup and
  after resume, without reviving cancelled or interrupted work.
- Fix Team admission with the full workspace tool catalog: summarize capability
  metadata to its declared bounds while retaining complete tool descriptions,
  schemas, and permission checks for execution.
- Add shared Team messages, cursor history, reusable member assignments, task
  reports, and explicit close. Members inherit host-authorized tools unless
  the lead narrows their grant; nested Teams remain limited to depth three.
- Make `task_wait` accept the initial task IDs returned by `team_create` as
  well as later assignments, using durable outcomes without restarting work.
- Preserve parent-Team group tools when reusing or recovering member lanes,
  including older task manifests that omitted those runtime capabilities.
  Keep workspace grants and nested-Team authorization separate.
- Validate follow-up task transport against its own assignment so Team status
  does not flag legitimate member reports as mismatched initial-task replies.
- Use Nausicaa as the root public identity and named workers as Team members.
  Clarify Teto's auxiliary role and reserve unsolicited A2A for valuable advice
  about user intent and better solutions.

## [0.1.3] - 2026-09-09

- Start Teto automatically for new Runs. Explicit stops remain effective after
  restart and resume; the owner can restart observation through `teto_start`.
- Use Nausicaa as the public Agent identity across runtime roles, shorten the
  Teto introduction, and align lifecycle guidance with the actual tool catalog.
- Preserve Skill resource directories when loading instructions on demand and
  clarify metadata discovery and loading in the bilingual README.
- Add `/traces [status|preview]` for local Run events and metrics. Keep legacy
  command spellings executable without duplicating public help or autocomplete,
  and reject surplus arguments on control commands.
- Persist Main and Worker tool results as each call settles while preserving
  source order in model context, including after recovery. A terminal-write
  failure cancels the batch and drains its remaining result handlers.
- Run each Worker tool batch through one Mowe scheduler so declared concurrency
  limits apply to the whole batch. Restore committed tool evidence in recovered
  Worker results and account for provider-reported usage on failed requests.
- Recheck cancellation after Main completion hooks and tool deadlines before
  adapter execution. Enforce root object schema `const` and `enum` constraints.
- Fixed Teto treating temporary shared-budget reservations as permanent
  exhaustion; later owner events can resume observation without losing
  already-persisted context.
- Made cancellation evaluations distinguish admitted requests from dispatched
  provider calls, with explicit evidence and deterministic boundary tests.
- Synchronized the TUI transcript-isolation test with durable lane completion
  and added failure diagnostics and guaranteed session cleanup.

## [0.1.2] - 2026-09-08

- Added `/settings`, `/system-prompt`, `/logs`, `/changelog`, and `/update`
  as local interactive commands.
- Added isolated `/btw` (`/side`) questions with follow-ups and cancellation;
  their text stays outside the main transcript, but usage counts against the
  attached Run budget and remains accounted across recovery. Closing or changing
  sessions cancels outstanding side requests.
- Added `/clone`, plus `/clear` as the compatibility alias for starting a new
  session while preserving the previous Run.
- Unified Providers, Models, MCP, and Skills in one full-screen configuration
  workspace with retained tab state, centered pale-pink menus, and a pink logo.
- Improved light/dark menu contrast, narrow-terminal layout, thinking-level
  descriptions, and `model • medium` labels without assuming a universal default.
- Made updates cancellable with bounded process lifetime and output; sanitized
  terminal control sequences in displayed diagnostics.
- Encouraged Main to start Teto early for complex work, reuse an active observer,
  and continue working while independently evaluating its feedback.
- Rejected provider-aborted Teto and reflection responses while preserving
  their reported usage. Documented the production loop baseline without a
  wholesale migration to the standalone L0 kernel.

## [0.1.1] - 2026-09-08

- Added a centered, searchable Prime-style `/login` menu with provider and
  authentication-method choices.
- Distinguished OpenAI API access from ChatGPT subscription login and displayed
  only authentication methods supported by each provider.
- Preserved saved credentials after successful login; cancelling returns to the
  previous menu without saving an account or changing the selected model.
- Kept model selection on the same centered surface as provider authentication.
- Rendered provider-owned authentication choices as selectable prompts.
- Added `/thinking` (`/effort`) with model-supported reasoning levels, retained
  with the current session and applied to subsequent Main requests.
- Added centered MCP configuration for HTTP/stdio servers with explicit access
  grants; configuration changes take effect after restart.
- Bundled three data-only Skills for codebase mapping, planning, and review,
  with project/configured overrides and on-demand instruction loading.
- Fixed release installers to use their published version instead of npm latest.

## [0.1.0] - 2026-09-06

- Initial beta release of the durable multi-lane agent runtime.
- Added Main, Teto, optional Worker, and local daemon execution paths.
- Added bounded workspace tools, explicit capability profiles, and resumable
  Run/Ledger state.
