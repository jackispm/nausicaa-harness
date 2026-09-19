export function boundedJsonArrayLength<T>(
  items: readonly T[],
  maxBytes: number,
  itemJson: (item: T) => unknown,
  emptyOutput: (length: number) => object,
): number {
  const prefixBytes = [0];
  for (const item of items) {
    prefixBytes.push(prefixBytes.at(-1)! + Buffer.byteLength(JSON.stringify(itemJson(item)), "utf8"));
  }

  for (let length = items.length; length >= 0; length -= 1) {
    const fixedBytes = Buffer.byteLength(JSON.stringify(emptyOutput(length)), "utf8");
    const arrayBytes = prefixBytes[length]! + Math.max(0, length - 1);
    if (fixedBytes + arrayBytes <= maxBytes) return length;
  }
  return 0;
}
