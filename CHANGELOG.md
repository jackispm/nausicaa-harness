# Changelog

All notable changes to Nausicaa are documented here.

## [Unreleased]

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
