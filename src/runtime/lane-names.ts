/** Model-facing names; durable lane IDs and permission grants stay canonical. */
export function publicLaneName(laneId: string): string {
  return laneId === "main" ? "nausicaa" : laneId;
}

/** A readable identity is separate from the full, unambiguous A2A address. */
export function publicAgentName(laneId: string): string {
  if (laneId === "main") return "Nausicaa";
  if (laneId === "teto" || laneId.endsWith(":teto")) return "Teto";
  if (laneId === "worker") return "worker 1";
  if (laneId.startsWith("team-reducer:")) return "reducer";
  const name = laneId.startsWith("team:") ? laneId.slice(laneId.lastIndexOf(":") + 1) : laneId;
  return /^worker-\d+$/u.test(name) ? name.replace("-", " ") : name;
}

/** Resolve a public name only within the host's authorized recipient set. */
export function resolveLaneTarget(name: string, targets: readonly string[]): string {
  if (targets.includes(name)) return name;
  return name === "nausicaa" && targets.includes("main") ? "main" : name;
}

export function publicLaneEndpoint<T extends { readonly laneId: string }>(endpoint: T): T {
  return { ...endpoint, laneId: publicLaneName(endpoint.laneId) };
}
