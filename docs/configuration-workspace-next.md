# Configuration Workspace After 0.1.1

User direction: keep this work out of the 0.1.1 release scope.

Unify Providers, Models, MCP Connections, and Skills in one centered configuration
surface. Keep `/login`, `/model`, `/mcp`, and `/skills` as direct entry points to
their respective views. Switching views should preserve search, selection, and
draft configuration without triggering authentication, writes, or connections.

Reference: Prime Agent's `configuration-menu.ts` at
7787f07415d843b9a800f6a4720e0c739bd608e5 (MIT), and the user's supplied screenshot
of the unified Models view. Preserve its convenient navigation while giving
Nausicaa a modestly distinct layout and visual hierarchy. Skills belong beside
provider/model/MCP configuration, not in a disconnected settings surface.

Design details and the subsequent version number are not yet decided. This note
does not claim the unified view is implemented in 0.1.1.
