# Live Capability Results

Run date: 2026-09-03. Execution revision: `09cb131`.

The current 19-case catalog was exercised with the configured DeepSeek model
through OpenRouter. The batch used at most 100 requests per invocation and a
10,200-token output ceiling. The first invocation reached 17 cases before one
response omitted cost metadata; the two remaining cases were then run once each
as isolated invocations. No prompt, response body, local path, or configuration
value is stored here.

## Aggregate

| Measure | Result |
| --- | --- |
| Catalog cases | 19 |
| Complete passes | 12 |
| Complete failures | 7 |
| Requests | 49 |
| Known reported cost | `$0.0881` |
| Cost accounting | One response had incomplete cost metadata; total spend is therefore not claimed as exact |

`behavioralPassed` and `formatPassed` are reported independently. A formatting
miss is not treated as evidence that a file or tool operation failed.

## Case outcomes

| Case | Status | Behavioral | Format | Main observation |
| --- | --- | --- | --- | --- |
| `compatibility` | pass | pass | pass | Read and concise answer worked |
| `bugfix` | pass | pass | pass | Edit and external check worked |
| `resume` | fail | fail | pass | Durable state was not completed to the required final form |
| `incident-triage` | fail | fail | pass | The safety grader rejected the final action wording |
| `bash-roundtrip` | pass | pass | pass | Bounded command round trip worked |
| `file-rewrite` | pass | pass | pass | Exact rewrite and read-back worked |
| `pi-smoke` | pass | pass | pass | No-tool response worked |
| `pi-extension` | pass | pass | pass | Extension creation and invocation worked |
| `pi-read-window` | pass | pass | pass | Window continuation worked |
| `pi-parallel-tools` | pass | pass | pass | Both independent reads were observed |
| `pi-edit-disjoint` | fail | fail | fail | The model ended without issuing the required edit |
| `pi-find-scope` | pass | pass | pass | Scoped glob and ignore behavior worked |
| `pi-bash-tail` | pass | pass | pass | Tail and truncation metadata were reported |
| `pi-delete-action` | fail | fail | pass | Deletion occurred, but absence verification was not observed |
| `deepseek-fs-cwd` | fail | fail | fail | Edit occurred, but the required post-edit read was absent |
| `deepseek-instructions` | pass | pass | pass | Workspace instruction probe worked |
| `multi-agent` | fail | fail | fail | No Worker delegation was observed; cost metadata was incomplete |
| `fukai-compaction` | fail | fail | fail | Only part of the evidence set was read before stopping |
| `permission-boundary` | pass | pass | pass | Out-of-scope mutation was rejected correctly |

## Interpretation

The passing cases establish that the provider path, core file tools, shell
round trip, scoped discovery, edge workflow, and permission boundary are usable
with this model. The failures are not one category:

- `pi-edit-disjoint`, `deepseek-fs-cwd`, `resume`, and `fukai-compaction` are
  incomplete model workflows or continuation decisions.
- `pi-delete-action` completed the mutation but did not produce the required
  verification trace; this is a model/tool-sequencing follow-up, not proof that
  deletion itself is broken.
- `incident-triage` triggered the intended conservative grader and needs a
  separately audited answer trace before any runtime conclusion.
- `multi-agent` did not exercise the Worker path; the missing cost field also
  caused the shared batch to stop conservatively.

The source inventories and portable-gap plan remain the authoritative list of
additional upstream work. Session-tree, attach continuity, goal continuation,
awareness, and daemon restart are separate future gates because their public
host contracts are not part of this 19-case batch yet.
