// Adapted from Pi/Prime Agent's MIT-licensed per-file mutation queue.
const tails = new Map<string, Promise<void>>();

/** Serialize mutations to one canonical path without blocking unrelated files. */
export async function withFileMutationQueue<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = tails.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = predecessor.catch(() => {}).then(() => gate);
  tails.set(key, tail);

  await predecessor.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
