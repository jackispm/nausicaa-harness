# Thinking Levels

## Reuse Boundary

- Dependency: `@earendil-works/pi-ai` 0.84.3, MIT.
- Reference: Pi coding-agent, commit
  `1defa151e0c1dac87d38a2d0ac09d67f817b30f9`, MIT,
  `packages/coding-agent/src/core/agent-session.ts` thinking-level management
  and `packages/agent/src/agent.ts` request construction.
- Adopted directly: Pi's `ModelThinkingLevel` type,
  `getSupportedThinkingLevels(model)`, and the provider-neutral `reasoning`
  request option. Provider-specific effort mappings and token budgets remain
  inside Pi. No model-name heuristics or separate provider protocol is added.
- Nausicaa does not adopt Pi's session manager because its existing Ledger
  owns Run persistence, forks, and request snapshots. The integration is a
  thin adapter around that boundary.

## Session Contract

`SessionController.thinkingLevel` is the Main lane's explicit preference.
`undefined` leaves the existing provider default unchanged. The available
levels come from local provider metadata; custom model ports without that
metadata offer only the default choice. Explicit unsupported values are
rejected instead of silently changing the user's request.

`setThinkingLevel(level)` persists changes in `thinking.selected` before
publishing state. It affects the next model-request snapshot, not an already
captured call or its retries. `model.requested` and its request hash record
the chosen level. Both completion and streaming forward the same value.

Pi represents `off` by omitting the simple API's `reasoning` option. Nausicaa
follows that exact contract; it does not promise to disable reasoning that
a provider requires internally. The default choice also omits that option,
but remains distinct session state from an explicit `off` preference.

Switching models retains an explicit level only when the new model supports
it; otherwise the selection returns to the provider default. That decision
is recorded atomically with `model.selected`. Resume and historical forks
restore the recorded value, subject to the current provider capabilities.
Imported conversations do not import model or thinking preferences.

The preference is local to the current Main session/Run. It does not change
global defaults or implicitly alter Teto, Worker, or Team model requests.

## Selector Descriptions

The descriptions in `src/cli/thinking-options.ts` minimally adapt Pi's
`packages/coding-agent/src/modes/interactive/components/thinking-selector.ts`.
This UI reference was checked against `@earendil-works/pi-coding-agent` 0.85.0
and upstream commit `9767ba275f3e9a5ee0f5c5342249b629ab1b2282`, both MIT,
Copyright (c) 2025 Mario Zechner. This is a later UI reference than the
0.84.3 runtime integration recorded above; the runtime dependency and its
defaults are unchanged.

`thinkingLevelChoices({ levels, current, defaultLevel })` returns only the
provider-supported concrete levels plus the existing Provider default row.
The descriptions retain Pi's qualitative scale: no, very brief, light,
moderate, deep, extra-high, and maximum reasoning. A concrete level receives
a default marker only when the caller explicitly supplies `defaultLevel`.
`formatModelThinkingLabel(model, level)` adds the selected explicit level
beside a display name, including `off`; an unset level leaves the name
unchanged. It does not normalize or mutate the provider/model selector.

Pi's `core/defaults.ts` uses `medium` as its harness default, and its selector
marks the configured global default. Nausicaa does not infer that an unset
preference means medium: its Provider default row remains separate.

Pi's selector also prints approximate token counts, but those are not a
portable provider contract. The inspected `api/simple-options.ts` maps
minimal/low/medium/high to 1024/2048/8192/16384 tokens for budget-based
providers; that helper clamps xhigh/max to high and permits custom budgets
and model-limit adjustments. Other paths, including OpenAI Responses, use
effort values and model-specific mappings rather than those fixed budgets.
Nausicaa therefore omits token estimates from the generic selector instead
of promising the same token allowance for every model.
