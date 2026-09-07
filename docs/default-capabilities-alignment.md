# Default Capability Alignment

## Upstream Review

Reviewed local snapshots before changing capability defaults:

| Project | Commit | License | Reviewed boundary |
| --- | --- | --- | --- |
| Pi | `1defa151e0c1dac87d38a2d0ac09d67f817b30f9` | MIT | `packages/coding-agent/src/core/settings-manager.ts`: compaction enabled unless explicitly disabled |
| Prime Agent | `7787f07415d843b9a800f6a4720e0c739bd608e5` | MIT | `packages/coding-agent/src/core/settings-manager.ts`: compaction enabled unless explicitly disabled |
| DeepSeek Harness | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | MIT | `docs/subsystems/skills.md`: capability discovery and invocation are separate |

This change adopts the default-on, on-demand behavior, not upstream runtime
code. Nausicaa already depends on Pi's model layer and owns durable Run policy,
Fukai compaction, and lane scheduling. Importing another harness runtime would
replace those ownership boundaries rather than supply a missing primitive. No
new runtime, discovery implementation, or dependency is introduced here.

## Default Decisions

- A new normal CLI session enables Fukai compaction with the `pi-ai` provider.
  Existing thresholds, request limits, failure handling, and token accounting
  remain unchanged. Enabling the capability does not issue a startup model call.
- Explicit `fukaiCompaction.enabled: false` remains an opt-out. An explicit
  legacy `provider: "none"` without `enabled` also remains disabled; an explicit
  `enabled: true` with `provider: "none"` remains invalid.
- New Run policy makes Worker delegation available. It does not start a Worker
  until requested, and does not widen the delegated lane's permissions.
  `--no-worker` explicitly disables the capability for a CLI invocation.
- Configured external sources are enabled and refreshed at startup by default.
  No servers are synthesized or scanned. Before an MCP adapter is constructed,
  a matching, validated source-specific host grant is required. The registry
  continues to enforce that grant's effects, scopes, and approval requirement.
- The global source opt-out, per-source `enabled: false`, and explicit startup
  refresh opt-out remain effective. Native plugin sources remain unsupported.
- Default project Skill discovery remains metadata-only. The existing distinction
  between the local Skill source and the external source enablement gate remains
  intact; a global CLI opt-out still disables both.

## Compatibility

Persisted Run policy is durable history, not a new default. Resuming a Run must
not silently overwrite an explicitly disabled compaction or Worker policy.
Callers that intentionally want isolated/single-lane behavior must now pass
`workerEnabled: false` explicitly.

Compaction defaults are resolved in the normal CLI's settings composition. The
embedding APIs (`SessionController.open` and `executeRun`) still require callers
to supply a compaction policy and do not synthesize a provider policy when none
was passed. This preserves their existing model-dependency contract. Worker
availability is instead a Run policy default shared by the CLI and embedding APIs.

Previously a configured MCP without a grant could still be started for discovery,
with tools later quarantined behind approval. It now remains unconstructed and
reports `missing-host-grant`, preventing executable or network side effects before
authorization. Adding a matching grant makes the configured server available on
the next composition startup.

## Verification Contract

Focused settings, Run policy, Skill discovery, and edge factory tests cover new
defaults, explicit opt-outs, no implicit server discovery, no-grant and wrong-grant
MCP startup rejection, preservation of tool grants, and plugin rejection.
