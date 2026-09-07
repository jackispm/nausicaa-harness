# Provider setup alignment

## Reuse decision

| Reference | Version / snapshot | License | Adopted boundary |
| --- | --- | --- | --- |
| Pi AI | `@earendil-works/pi-ai` 0.84.3 | MIT | Direct dependency for the complete catalog, provider transports, API-key/OAuth flows, and model refresh |
| Pi TUI | `@earendil-works/pi-tui` 0.84.4 | MIT | Direct dependency for editor, search, list rendering, and keyboard handling |
| Pi coding-agent | `1defa151e0c1dac87d38a2d0ac09d67f817b30f9` | MIT | `interactive-mode.ts`: connect successful login to model setup and retain cached models after refresh failures |
| Prime Agent | `7787f07415d843b9a800f6a4720e0c739bd608e5` | MIT | `interactive-mode.ts` and `auth-flows.ts`: `/login` opens Providers, `/model` opens Models; unconfigured model selection starts authentication; logout selects saved credentials |
| DeepSeek Harness | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | MIT | `docs/user/guide/providers.md`: separate credentials from settings, expose only safe metadata, respect provider-specific authentication |

The local TUI connects these behaviors to Nausicaa's SessionController. Importing
an upstream session runtime would replace the Lane and ledger contracts. The
DeepSeek Web configuration service is not needed for this terminal interface.
No provider wire protocol or OAuth implementation is copied into production code.

Pi's picker starts from locally configured providers. Prime's interactive caller
also supplies unconfigured catalog entries, sorts configured providers first, and
authenticates on selection. Nausicaa adopts a configured-provider default with an
explicit all-catalog facet, using pi-ai's own local authentication checks. This
is a thin UI adapter, not a second credential registry. Neither reference defines
a built-in `/providers` command; Nausicaa removes that redundant entry instead of
retaining another status-only screen or alias.

## User flow

- `/login` offers the registered providers, including dynamic providers with an
  initially empty catalog. Each provider supplies its available login methods.
- Secret prompts are separate from the composer and transcript. Cancelling any
  selector or prompt returns to the composer without saving a credential.
- If no model is selected, successful login opens that provider's models.
  Selecting a model is explicit; logging in never issues an inference request.
  A session with a model keeps its current selection.
- A failed catalog refresh retains the saved credential and cached models.
- `/login` is the provider connection and local-authentication status entry.
- `/model` defaults to models from all locally configured providers. The All
  facet exposes the full catalog and labels models requiring login. Selection
  rechecks credentials and completes login before changing the model; cancelling
  keeps the previous model. Local configuration does not verify remote access.
- Model counts follow both search and facets. `/model <search>` opens a filtered
  picker; an exact selector can be selected directly. Loading is dismissible and
  late authentication checks never reopen a cancelled selector.
- `/logout` lists saved credentials even when only one exists. An explicit
  `/logout <provider>` targets that account. Environment credentials remain in
  the environment.
- Closing the TUI settles pending authentication selectors so shutdown can drain.
- CLI tasks accept `--provider <id> --model <model>` and `provider:model`.
  Existing unqualified model IDs retain their OpenRouter compatibility default.

## Verification

- `test/unit/provider-routing.test.ts` exercises the installed OpenAI Responses,
  Anthropic Messages, DeepSeek, and OpenRouter transports with synthetic HTTP
  streams. It verifies endpoint routing, per-provider credentials, completion,
  streaming, and usage conversion without live keys or network access.
- `test/unit/interactive-tui.test.ts` covers provider search, hidden login,
  method cancellation, first-login model selection, keeping an existing model,
  cached-catalog fallback, saved-account logout, configured-provider model scope,
  model-to-login handoff, and shutdown at each selector.
- `test/unit/model-adapter.test.ts`, `auth-cli.test.ts`, `credentials.test.ts`,
  `onboarding.test.ts`, and `test/protocol/model-selection.test.ts` cover catalog
  discovery, provider-owned OAuth interaction, persistence, error classification,
  cancellation, and next-request model switching.

These are offline integration checks, not evidence that every remote account,
subscription, regional endpoint, or provider service has been tested live.
