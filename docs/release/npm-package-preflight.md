# npm Package Preflight

Status: audit only. This note does not publish, install globally, reserve a
name, or change registry state.

Baseline audited: `main@c9bf684` (`update beta documentation status`).

## Current package contract

| Field | Current value | Readiness note |
| --- | --- | --- |
| `name` | `nausicaa` | The registry name must be checked by the release owner at release time; this audit did not query the registry. |
| `version` | `0.1.0` | Keep this version until a release owner chooses a semver release. No bump is made by this preflight. |
| `private` | `true` | Deliberate safety lock. A public `npx nausicaa` flow is impossible until the owner changes this explicitly. |
| `license` | `UNLICENSED` | Public distribution is blocked until the project selects and documents a license. |
| `engines.node` | `>=22.19.0` | Must remain aligned with the supported runtime and CI image. |
| `bin.nausicaa` | `dist/cli.js` | Built CLI entrypoint; `postbuild` marks it executable. |
| `exports["."]` | `dist/index.js` and `dist/index.d.ts` | Runtime and type entrypoints are emitted by the build. |
| `files` | `dist`, `README.md`, `THIRD_PARTY_NOTICES` | Allow-list keeps source, tests, local state, and design material out of the package. |

Runtime dependencies are in `dependencies`; the clipboard integration is an
optional dependency. `package-lock.json` is intentionally not included in the
published artifact. The `prepack` hook runs the build, while the package smoke
test uses `--ignore-scripts` with an isolated npm cache to inspect the allow-list
without invoking another build.

## Offline audit

The reproducible local command is:

```bash
pack_cache_dir="$(mktemp -d)"
npm_config_cache="$pack_cache_dir" npm pack --dry-run --json --ignore-scripts
pack_status="$?"
rm -rf "$pack_cache_dir"
exit "$pack_status"
```

The audited artifact was `nausicaa@0.1.0`, with an executable `dist/cli.js`,
`dist/**`, `README.md`,
`THIRD_PARTY_NOTICES`, and `package.json` only. It contained no
`package-lock.json`, `.env*`, `.nausicaa`, `.local`, `.git`, `docs`, `test`,
`src`, `AGENTS.md`, `node_modules`, or TypeScript source files. The automated
assertion is [test/smoke/package.test.ts](../../test/smoke/package.test.ts).

The dry-run is not a publication test and does not prove that dependencies can
be installed on every platform. It does prove the local npm file selection and
the built entrypoint contract. `npm pack` may create a local tarball when a
release owner wants to inspect it; that file is ignored and must be removed
after inspection.

## Future npx path

After a release owner resolves the license, changes `private` deliberately,
confirms the package name, and publishes a tagged version from trusted CI, the
expected consumer command is:

```bash
npx --yes nausicaa@<version> --help
```

The current package is private, so this command must not be run as a release
claim today. Before the first public release, verify from a clean checkout that
the tarball contains `bin.nausicaa`, starts on Node `>=22.19.0`, and can import
the `exports["."]` entry. A temporary package install or `npx` check should be
performed only after publication approval; this repository's preflight does not
perform either operation.

## Release prerequisites

1. Choose a real SPDX license and replace `UNLICENSED`; review the existing
   `THIRD_PARTY_NOTICES` against the selected distribution terms.
2. Have the release owner explicitly set `private: false`, confirm ownership of
   the npm name, and select a semver version. Do not combine these decisions
   with an unrelated feature change.
3. From a clean, reviewed commit run `npm run typecheck`, `npm run build`,
   `npm test`, `npm run test:smoke`, `npm pack --dry-run`, and `git diff --check`.
4. Inspect the generated package file list and checksum. Keep API keys,
   `.env` files, Ledger state, eval traces, and local design documents outside
   the checkout used for release.
5. Prefer a trusted CI publish with npm provenance/attestation enabled when the
   project has configured an OIDC-capable workflow. Decide whether provenance is
   required before publishing; this local audit does not request a token or
   enable a workflow.
6. Publish the exact reviewed tag, then perform one low-risk `npx
   --yes nausicaa@<version> --help` smoke from a clean temporary directory and
   record the version and exit status.

No step above authorizes `npm publish`, `npm login`, registry name reservation,
or a version bump during this task.

## Versioning decision

The package remains at `0.1.0` for this beta preflight. The release owner must
choose the next semver explicitly: use a patch increment for a compatible beta
fix, a minor increment for a new compatible beta surface, and reserve a major
increment for the post-`1.0.0` stability contract. Do not infer a version from
the git commit or let `npm version` run as part of the preflight.

## Homebrew is separate

Homebrew is a later distribution channel, not an npm flag. The project can
choose either:

- an official tap formula that downloads a reviewed release tarball, verifies a
  checksum, and installs the CLI wrapper; or
- an npm-wrapper formula that delegates to the public npm package and its
  dependencies.

Either option needs its own formula review, platform checks, upgrade and
rollback story, and tap ownership. Neither is implemented or validated by this
preflight.
