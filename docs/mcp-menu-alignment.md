# MCP Management

The configuration surface follows Prime Agent 0.7.2 (MIT), commit
7787f07415d843b9a800f6a4720e0c739bd608e5, particularly
`packages/coding-agent/src/modes/interactive/components/configuration-menu.ts`.
The shared centered menu is the minimal attributed port recorded in
THIRD_PARTY_NOTICES. Transport remains the existing MCP SDK adapter.

Nausicaa keeps its existing source declarations and host grants. Browsing never
starts a process or connects to a server. Adding an HTTP or stdio source requires
explicit selection of read/compute or full tool access. The confirmation applies
to the configured server, not arbitrary future sources. Runtime permission
profiles still bound admitted tools.

Settings use the existing serialized atomic user-settings writer. Adding,
disabling or removing a source takes effect after restart. The menu reports that
fact explicitly; refresh only refreshes existing connections. This avoids
replacing transports captured by active Main, Teto or Worker snapshots. Generic
MCP OAuth and hot reconfiguration are not implemented in this release.
