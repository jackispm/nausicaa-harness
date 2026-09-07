# Explicit Skill Invocation Alignment

## Reuse Decision

The CLI adopts Pi/Prime's `/skill:name [request]` behavior: resolve a discovered
Skill, load its instructions at submission, and include those instructions in
that user request. The selection does not persist into future requests.

Reviewed upstream snapshots:

| Project | Commit | License | Adopted boundary |
| --- | --- | --- | --- |
| Pi coding agent | `1defa151e0c1dac87d38a2d0ac09d67f817b30f9` | MIT, copyright 2025 Mario Zechner | `AgentSession._expandSkillCommand`, request-local Skill wrapper and relative-reference location |
| Prime Agent | `7787f07415d843b9a800f6a4720e0c739bd608e5` | MIT, copyright 2025 Mario Zechner and 2026 Prime Intellect | Same command and explicit invocation of Skills that disable model invocation |

These session methods are not independently exported APIs. Importing an entire
upstream session would replace unrelated runtime ownership. A thin local
adapter therefore reuses the behavior while retaining Nausicaa's existing
registry and bounded filesystem loader; it does not copy the session framework.

## Local Contract

- `/skills` browses metadata and inserts an explicit command into the composer.
- `EdgeSelectionController.expandSkillInvocation` expands only `/skill:` input.
- Lookup accepts a discovered name or exact source-qualified contribution ID,
  never an arbitrary filesystem path. Ambiguous names fail with an explanation.
- Loading uses the captured registry snapshot and existing file-identity,
  symlink, workspace-boundary and byte-limit checks. Cancellation fails without
  starting a model request, and failure must leave the original composer input.
- Expanded instructions are capped at 64 KiB. The model receives the complete
  request-local block; the transcript displays the compact original command.
- The wrapper includes an instruction-length attribute so literal closing tags
  inside either instructions or the user's arguments cannot confuse display.
- Reference paths originate from the adapter's discovered canonical file and
  directory. The command cannot supply or override those paths.
- `disabled` continues to prohibit model invocation and legacy automatic
  preloading. A separate `userInvocable` flag allows a discovered local Skill
  with `disable-model-invocation: true` to be explicitly invoked by the user.
- Only a host-side loader call can pass `invocation: "user"`. The model Skill
  tool has no such argument, and its catalog continues to omit disabled Skills.
- Existing `select`/`deselect` APIs remain compatible but are not the new picker
  workflow; explicit commands do not mutate that legacy persistent selection.

Unlike the upstream fallback, unknown or unreadable Skills fail before sending
the request instead of silently forwarding an unresolved command to the model.
This keeps a user-requested workflow from accidentally running without its
instructions.
