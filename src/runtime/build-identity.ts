// The build pipeline replaces this emitted module with an immutable artifact hash.
// Source-mode processes have no build identity and must report it as unknown.
export const RUNTIME_BUILD_ID: string | undefined = undefined;
