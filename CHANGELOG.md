# Changelog

All notable changes to Nausicaa are documented here.

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
