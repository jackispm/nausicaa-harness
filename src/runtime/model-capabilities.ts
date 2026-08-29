import type { ModelPort } from "../domain/ports.js";

/**
 * Decide whether a default workspace catalog should advertise image tools.
 *
 * ModelPort capabilities are intentionally optional for custom ports.  Keep
 * those ports on the historical permissive path, while honoring an explicit
 * text-only declaration so Main/Worker do not offer a tool the provider will
 * reject at the next boundary.
 */
export function resolveImageInputCapability(
  model: ModelPort | undefined,
  selector: string,
): boolean | undefined {
  if (model?.capabilities === undefined) return undefined;
  try {
    return model.capabilities(selector).imageInput;
  } catch {
    return undefined;
  }
}

export function shouldIncludeImageContent(
  model: ModelPort | undefined,
  selector: string,
): boolean {
  // Capability discovery is advisory. Unknown custom selectors remain on the
  // permissive compatibility path; the adapter is still the final guard.
  return resolveImageInputCapability(model, selector) !== false;
}

export function shouldAdvertiseImageTools(
  model: ModelPort | undefined,
  selector: string,
): boolean {
  return shouldIncludeImageContent(model, selector);
}
