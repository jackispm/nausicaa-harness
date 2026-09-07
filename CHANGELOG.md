# Changelog

All notable changes to Nausicaa are documented here.

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
