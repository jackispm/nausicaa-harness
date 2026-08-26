// Minimally adapted from Prime Agent commit 7787f07415d843b9a800f6a4720e0c739bd608e5 (MIT).

const IMAGE_MARKER_REGEX = /\[image #(\d+)\]/g;

export function formatImageMarker(id: number): string {
  return `[image #${id}]`;
}

export function imageMarkerIds(text: string): number[] {
  return [...text.matchAll(IMAGE_MARKER_REGEX)]
    .map((match) => Number(match[1]))
    .filter((id) => Number.isSafeInteger(id));
}

export function remapImageMarkers(
  text: string,
  remaps: ReadonlyMap<number, number>,
): string {
  return text.replace(IMAGE_MARKER_REGEX, (marker, id: string) => {
    const replacement = remaps.get(Number(id));
    return replacement === undefined ? marker : formatImageMarker(replacement);
  });
}

export function collectMarkedImages<T>(
  pending: ReadonlyMap<number, T>,
  text: string,
): T[] {
  if (pending.size === 0) return [];

  const present = new Set(imageMarkerIds(text));
  const images: T[] = [];
  for (const [id, image] of pending) {
    if (present.has(id)) images.push(image);
  }
  return images;
}

export function evictImagesToBudget<T>(
  images: Map<number, T>,
  sizeOf: (value: T) => number,
  maxBytes: number,
  keep: ReadonlySet<number>,
): void {
  let total = 0;
  let protectedTotal = 0;
  for (const [key, value] of images) {
    const size = sizeOf(value);
    total += size;
    if (keep.has(key)) protectedTotal += size;
  }

  if (protectedTotal > maxBytes) {
    throw new RangeError("Protected images exceed the registry budget");
  }

  for (const key of [...images.keys()]) {
    if (total <= maxBytes) break;
    if (keep.has(key)) continue;

    const value = images.get(key);
    if (value !== undefined) {
      total -= sizeOf(value);
      images.delete(key);
    }
  }
}
