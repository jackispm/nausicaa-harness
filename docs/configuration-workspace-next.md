# Configuration Workspace

Initial decision: keep this work out of the 0.1.1 release scope. Implemented in
0.1.2 following the user's request to combine the subsequent configuration work.

Unify Providers, Models, MCP Connections, and Skills in one centered configuration
surface. Keep `/login`, `/model`, `/mcp`, and `/skills` as direct entry points to
their respective views. Switching views should preserve search, selection, and
draft configuration without triggering authentication, writes, or connections.

Reference: Prime Agent's `configuration-menu.ts` at
7787f07415d843b9a800f6a4720e0c739bd608e5 (MIT), and the user's supplied screenshot
of the unified Models view. Preserve its convenient navigation while giving
Nausicaa a modestly distinct layout and visual hierarchy. Skills belong beside
provider/model/MCP configuration, not in a disconnected settings surface.

## 0.1.2 Boundary

`ConfigurationMenu` retains lazily created provider, model, MCP, and Skill pages.
`FullScreenMenuPage` owns complete viewport coverage and centering. Ctrl+Left/Right
switches pages; Tab/Shift+Tab and plain arrows retain the model facet controls.
Child components keep their search, selected row, filter, and unsaved MCP draft
while switching. Browsing never authenticates, saves, or starts a connection.
Provider and model local-status checks may run in the background; disposed pages
cannot reopen from a late result. Secrets remain in the existing exclusive auth
flow, never in cached page state.

The layout/focus code is a narrow attributed port because Prime's private
configuration components depend on its own AuthStorage and ModelRegistry.
Nausicaa uses pi-tui directly for input, focusable components, ANSI widths, and
overlays; it keeps the existing credential, model, MCP, and Skill owners.
Full-page centering additionally references Prime v0.9.2 centered-overlay.ts at
9c54a35dac3a2ad17910074d66664859ea175666 (MIT).

Menus use independent light/dark surface and text tokens, so their pale-pink
palette does not recolor diagnostic semantics or the conversation. The retained
tab host and actual overlay compositor have unit and interactive tests; rendered
ANSI cells are also checked at wide and narrow terminal sizes.
