# Session Portability Alignment

## Upstream Boundary

Reviewed before implementation:

- Pi coding agent, commit `1defa151e0c1dac87d38a2d0ac09d67f817b30f9`, MIT,
  `packages/coding-agent/src/core/session-export.ts`, session-manager and the
  interactive `/import` handler.
- Prime Agent, commit `7787f07415d843b9a800f6a4720e0c739bd608e5`, MIT,
  session export/name methods in `packages/coding-agent/src/core/agent-session.ts`.

Adopted contract: `/name` names the current session, `/export` defaults to a
readable HTML document, a `.jsonl` destination selects portable history, and
`/import` creates independent local history. Nausicaa JSONL is explicitly its
own versioned format, not a claim of Pi or Prime format compatibility.

Direct dependency or a source port would require replacing Nausicaa's Ledger,
artifact store, and Run lineage. The thin adapter therefore reuses local
Ledger validation, content-addressed artifacts, transcript projection and the
existing fork implementation. No upstream source is copied.

## Safety And Scope

- Naming uses private per-Run metadata; it does not rewrite conversation facts.
- Exports contain Main conversation history, including images and completed
  tool calls/results. They do not include provider settings, credentials,
  system prompts, MCP configuration, auxiliary lanes or active Goal state.
- Conversation content can itself contain private data or pasted secrets.
  Exporting locally does not make it safe to share publicly.
- JSONL contains a format header, validated events, and referenced artifacts.
  The adapter regenerates a verified checkpoint through the existing Ledger
  API after limiting the event set to portable history.
- Unfinished turns, queued input, or unresolved tool operations are rejected,
  not silently dropped or replayed. HTML remains a read-only transcript.
- Import validates event schemas, ordering, checksums, artifact hashes and
  conversation/tool pairing before creating a Run. Imported history does not
  execute tools or contact a provider. A new Run uses the current workspace,
  model and policy; previous active Goals are not resumed.
- Local paths are workspace-relative unless an explicit absolute path is
  supplied. Symlink path components, non-regular files and overwriting export
  targets are rejected. Exports use mode `0600`; import is bounded to 64 MiB.
- HTML is a standalone escaped document without JavaScript, remote media,
  active links, or raw Markdown/HTML injection.

## Integration

`SessionController.portableSessionSource()` supplies a consistent idle source.
`exportSessionFile()` writes HTML or JSONL. `readSessionImportFile()` returns
verified history in an in-memory artifact store; the controller then creates
an independent Run through its existing fork boundary.

`readSessionName()` and `writeSessionName()` live in runtime metadata so both
the TUI and workspace session listing can use names without importing CLI code.
