# Everyday CLI command alignment

## Reuse decision

- Pi coding-agent local snapshot `1defa151e`, MIT: adopt `/name`, `/export`,
  `/import`, `/hotkeys`, `/reload`, and explicit `/skill:name` semantics.
- Prime Agent local snapshot `7787f0741`, MIT: adopt the `/mcp` connection
  inspection boundary and separate Skill invocation from resource management.
- Existing direct dependency `@earendil-works/pi-tui` 0.84.4, MIT: continue using
  its editor, autocomplete, selector, and keybinding manager.
- Do not import either upstream session runtime: Nausicaa's committed ledger,
  content store, execution admission, and recovery are not compatible with
  their session formats. Use small adapters to the existing local contracts.

## Approved scope

- Make automatic compaction and bounded delegation available by default.
- Discover/connect configured MCP sources only after the existing source grant;
  never infer permission from a project file or start arbitrary servers.
- Present `/mcp`; retain `/edges` only as a compatibility spelling.
- Add local session naming and explicit, non-overwriting HTML/JSONL exports.
  Import into a fresh Run without replaying tools or importing permissions/goals.
- `/hotkeys` reports real active bindings. `/reload` reloads supported runtime
  resources; it must identify failures and must not claim unsupported reloads.
- `/skills` browses Skills and inserts an explicit invocation into the prompt.
  Automatic model discovery remains metadata-only and independent of selection.

## Separate concerns

Tool `/permissions` does not authorize loading executable project configuration.
The existing project-trust boundary remains in place. A general `/settings` menu
and reasoning/model-configuration expansion need a separate implementation scope;
the current request asks what belongs in that settings menu.

## Verification

Protect command help/completion/dispatch agreement, default opt-outs, cancelled
and failed resource loads, manual-only Skills, portable history integrity,
non-executing imports, and non-overwriting exports with focused local tests.
