# Pi TUI Presentation Adoption

Nausicaa adopts presentation behavior from Pi coding-agent `0.84.4` under its
MIT license. The adopted boundary is the interactive terminal presentation:
startup header, palette roles, message spacing, transparent editor, working
indicator, and footer geometry.

Nausicaa retains its own session, Teto, Worker, permission, and multi-lane
runtime behavior. Those states occupy Pi-compatible presentation slots where
possible, but are not imported from Pi.

We rejected a wholesale import of Pi's `InteractiveMode`: its runtime and
session contracts are coupled to Pi's agent/session implementation. The local
adapter instead keeps Nausicaa's controller and uses the already shared
`@earendil-works/pi-tui` component library.
