import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const filesystemRace = vi.hoisted(() => ({
  lateDestination: undefined as undefined | {
    path: string;
    triggerAt: number;
    misses: number;
    content: string;
    type?: "file" | "directory";
  },
  afterCopy: undefined as undefined | ((source: string, destination: string) => Promise<void>),
  afterLink: undefined as undefined | {
    path: string;
    run: (destination: string) => Promise<void>;
  },
  afterMkdir: undefined as undefined | {
    path: string;
    run: (directory: string) => Promise<void>;
  },
  afterDirectoryRead: undefined as undefined | {
    matches: (directory: string) => boolean;
    run: (directory: string) => Promise<void>;
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (candidate: string) => {
      try {
        return await actual.lstat(candidate);
      } catch (error: unknown) {
        const race = filesystemRace.lateDestination;
        if (race !== undefined
          && path.resolve(candidate) === race.path
          && isNotFound(error)) {
          race.misses += 1;
          if (race.misses === race.triggerAt) {
            if (race.type === "directory") {
              await actual.mkdir(candidate);
            } else {
              await actual.writeFile(candidate, race.content, { flag: "wx" });
            }
          }
        }
        throw error;
      }
    },
    cp: async (source: string, destination: string, options: object) => {
      await actual.cp(source, destination, options);
      const hook = filesystemRace.afterCopy;
      filesystemRace.afterCopy = undefined;
      await hook?.(source, destination);
    },
    link: async (source: string, destination: string) => {
      await actual.link(source, destination);
      const hook = filesystemRace.afterLink;
      if (hook !== undefined && path.resolve(destination) === hook.path) {
        filesystemRace.afterLink = undefined;
        await hook.run(destination);
      }
    },
    mkdir: async (directory: string, options?: object) => {
      const result = await actual.mkdir(directory, options);
      const hook = filesystemRace.afterMkdir;
      if (hook !== undefined && path.resolve(directory) === hook.path) {
        filesystemRace.afterMkdir = undefined;
        await hook.run(directory);
      }
      return result;
    },
    readdir: async (directory: string) => {
      const entries = await actual.readdir(directory);
      const hook = filesystemRace.afterDirectoryRead;
      if (hook?.matches(directory) === true) {
        filesystemRace.afterDirectoryRead = undefined;
        await hook.run(directory);
      }
      return entries;
    },
  };
});

import {
  createPathCopyTool,
  createPathDeleteTool,
  createPathMoveTool,
} from "../../src/tools/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  filesystemRace.lateDestination = undefined;
  filesystemRace.afterCopy = undefined;
  filesystemRace.afterLink = undefined;
  filesystemRace.afterMkdir = undefined;
  filesystemRace.afterDirectoryRead = undefined;
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("workspace path operation race boundaries", () => {
  it("does not overwrite a file created after the final no-overwrite move check", async () => {
    const workspace = await temporaryDirectory("nausicaa-move-race-");
    const source = path.join(workspace, "source.txt");
    const destination = path.join(workspace, "destination.txt");
    await writeFile(source, "source", "utf8");
    filesystemRace.lateDestination = {
      path: destination,
      triggerAt: 3,
      misses: 0,
      content: "external",
    };

    const result = await createPathMoveTool().execute(
      { from: "source.txt", to: "destination.txt" },
      { runId: "run-1", workspace, operationId: "op-1" },
    );

    expect(filesystemRace.lateDestination.misses).toBe(3);
    filesystemRace.lateDestination = undefined;
    expect(result.isError).toBe(true);
    await expect(readFile(destination, "utf8")).resolves.toBe("external");
    await expect(readFile(source, "utf8")).resolves.toBe("source");
  });

  it("does not overwrite a file created after the final no-overwrite copy check", async () => {
    const workspace = await temporaryDirectory("nausicaa-copy-race-");
    const destination = path.join(workspace, "destination.txt");
    await writeFile(path.join(workspace, "source.txt"), "source", "utf8");
    filesystemRace.lateDestination = {
      path: destination,
      triggerAt: 4,
      misses: 0,
      content: "external",
    };

    const result = await createPathCopyTool().execute(
      { from: "source.txt", to: "destination.txt" },
      { runId: "run-1", workspace, operationId: "op-1" },
    );

    expect(filesystemRace.lateDestination.misses).toBe(4);
    filesystemRace.lateDestination = undefined;
    expect(result.isError).toBe(true);
    await expect(readFile(destination, "utf8")).resolves.toBe("external");
    await expect(readFile(path.join(workspace, "source.txt"), "utf8")).resolves.toBe("source");
    expect((await readdir(workspace)).some((entry) => entry.startsWith(".nausicaa-copy-"))).toBe(false);
  });

  it("does not replace a directory created after the final no-overwrite move check", async () => {
    const workspace = await temporaryDirectory("nausicaa-move-directory-race-");
    const source = path.join(workspace, "source");
    const destination = path.join(workspace, "destination");
    await mkdir(source);
    await writeFile(path.join(source, "source.txt"), "source", "utf8");
    filesystemRace.lateDestination = {
      path: destination,
      triggerAt: 3,
      misses: 0,
      content: "",
      type: "directory",
    };

    const result = await createPathMoveTool().execute(
      { from: "source", to: "destination" },
      { runId: "run-1", workspace, operationId: "op-1" },
    );

    expect(filesystemRace.lateDestination.misses).toBe(3);
    filesystemRace.lateDestination = undefined;
    expect(result.isError).toBe(true);
    await expect(readdir(destination)).resolves.toEqual([]);
    await expect(readFile(path.join(source, "source.txt"), "utf8")).resolves.toBe("source");
  });

  it("does not replace a directory created after the final no-overwrite copy check", async () => {
    const workspace = await temporaryDirectory("nausicaa-copy-directory-race-");
    const source = path.join(workspace, "source");
    const destination = path.join(workspace, "destination");
    await mkdir(source);
    await writeFile(path.join(source, "source.txt"), "source", "utf8");
    filesystemRace.lateDestination = {
      path: destination,
      triggerAt: 4,
      misses: 0,
      content: "",
      type: "directory",
    };

    const result = await createPathCopyTool().execute(
      { from: "source", to: "destination" },
      { runId: "run-1", workspace, operationId: "op-1" },
    );

    expect(filesystemRace.lateDestination.misses).toBe(4);
    filesystemRace.lateDestination = undefined;
    expect(result.isError).toBe(true);
    await expect(readdir(destination)).resolves.toEqual([]);
    await expect(readFile(path.join(source, "source.txt"), "utf8")).resolves.toBe("source");
  });

  it("preserves a concurrent write through the atomically published move link", async () => {
    const workspace = await temporaryDirectory("nausicaa-move-link-write-");
    const source = path.join(workspace, "source.txt");
    const destination = path.join(workspace, "destination.txt");
    await writeFile(source, "source", "utf8");
    filesystemRace.afterLink = {
      path: destination,
      run: async (published) => await writeFile(published, "external", "utf8"),
    };

    const result = await createPathMoveTool().execute(
      { from: "source.txt", to: "destination.txt" },
      { runId: "run-1", workspace, operationId: "op-1" },
    );

    expect(result.isError).toBe(false);
    expect(filesystemRace.afterLink).toBeUndefined();
    await expect(readFile(destination, "utf8")).resolves.toBe("external");
    await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a concurrent write through the atomically published staged-file link", async () => {
    const workspace = await temporaryDirectory("nausicaa-copy-link-write-");
    const destination = path.join(workspace, "destination.txt");
    await writeFile(path.join(workspace, "source.txt"), "source", "utf8");
    filesystemRace.afterLink = {
      path: destination,
      run: async (published) => await writeFile(published, "external", "utf8"),
    };

    const result = await createPathCopyTool().execute(
      { from: "source.txt", to: "destination.txt" },
      { runId: "run-1", workspace, operationId: "op-1" },
    );

    expect(result.isError).toBe(false);
    expect(filesystemRace.afterLink).toBeUndefined();
    await expect(readFile(destination, "utf8")).resolves.toBe("external");
    await expect(readFile(path.join(workspace, "source.txt"), "utf8")).resolves.toBe("source");
  });

  it("rejects an unexpected hard link added after atomic file publication", async () => {
    const workspace = await temporaryDirectory("nausicaa-move-link-count-");
    const source = path.join(workspace, "source.txt");
    const destination = path.join(workspace, "destination.txt");
    const externalLink = path.join(workspace, "external-link.txt");
    await writeFile(source, "source", "utf8");
    filesystemRace.afterLink = {
      path: destination,
      run: async (published) => await link(published, externalLink),
    };

    const result = await createPathMoveTool().execute(
      { from: "source.txt", to: "destination.txt" },
      { runId: "run-1", workspace, operationId: "op-1" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("unexpected hard link");
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(source, "utf8")).resolves.toBe("source");
    await expect(readFile(externalLink, "utf8")).resolves.toBe("source");
  });

  it("retains content injected into a directory reservation when promotion fails", async () => {
    const workspace = await temporaryDirectory("nausicaa-directory-reservation-");
    const source = path.join(workspace, "source");
    const destination = path.join(workspace, "destination");
    await mkdir(source);
    await writeFile(path.join(source, "source.txt"), "source", "utf8");
    filesystemRace.afterMkdir = {
      path: destination,
      run: async (reserved) => await writeFile(path.join(reserved, "external.txt"), "external", "utf8"),
    };

    const result = await createPathMoveTool().execute(
      { from: "source", to: "destination" },
      { runId: "run-1", workspace, operationId: "op-1" },
    );

    expect(result.isError).toBe(true);
    expect(filesystemRace.afterMkdir).toBeUndefined();
    await expect(readFile(path.join(destination, "external.txt"), "utf8")).resolves.toBe("external");
    await expect(readFile(path.join(source, "source.txt"), "utf8")).resolves.toBe("source");
  });

  it("rescans copy staging for late symlinks and hard links", async () => {
    const workspace = await temporaryDirectory("nausicaa-copy-stage-links-");
    await mkdir(path.join(workspace, "source"));
    await writeFile(path.join(workspace, "source", "file.txt"), "safe", "utf8");
    filesystemRace.afterCopy = async (_source, staged) => {
      await link(path.join(staged, "file.txt"), path.join(staged, "hard.txt"));
      await symlink(path.join(staged, "file.txt"), path.join(staged, "link.txt"), "file");
    };

    const result = await createPathCopyTool().execute(
      { from: "source", to: "destination" },
      { runId: "run-1", workspace, operationId: "op-1" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("copy staging");
    await expect(lstat(path.join(workspace, "destination"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rescans copy staging for late byte growth", async () => {
    const workspace = await temporaryDirectory("nausicaa-copy-stage-size-");
    await mkdir(path.join(workspace, "source"));
    await writeFile(path.join(workspace, "source", "file.txt"), "safe", "utf8");
    filesystemRace.afterCopy = async (_source, staged) => {
      await truncate(path.join(staged, "file.txt"), (16 * 1024 * 1024) + 1);
    };

    const result = await createPathCopyTool().execute(
      { from: "source", to: "destination" },
      { runId: "run-1", workspace, operationId: "op-1" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("copy limit");
    await expect(lstat(path.join(workspace, "destination"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps late staged descendants back to protected source paths", async () => {
    const workspace = await temporaryDirectory("nausicaa-copy-stage-policy-");
    const source = path.join(workspace, "source");
    await mkdir(source);
    await writeFile(path.join(source, "visible.txt"), "safe", "utf8");
    filesystemRace.afterCopy = async (_source, staged) => {
      await mkdir(path.join(staged, "private"));
      await writeFile(path.join(staged, "private", "secret.txt"), "secret", "utf8");
    };

    const result = await createPathCopyTool({
      protectedPaths: [path.join(source, "private")],
    }).execute(
      { from: "source", to: "destination" },
      { runId: "run-1", workspace, operationId: "op-1" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("protected source mapping");
    await expect(lstat(path.join(workspace, "destination"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("quarantines and rescans a recursive delete before removing it", async () => {
    const workspace = await temporaryDirectory("nausicaa-delete-rescan-");
    const tree = path.join(workspace, "tree");
    await mkdir(tree);
    await writeFile(path.join(tree, "safe.txt"), "safe", "utf8");
    filesystemRace.afterDirectoryRead = {
      matches: (directory) => path.basename(directory) === path.basename(tree),
      run: async (directory) => {
        await symlink(path.join(directory, "safe.txt"), path.join(directory, "late-link.txt"), "file");
      },
    };

    const result = await createPathDeleteTool().execute(
      { path: "tree", recursive: true },
      { runId: "run-1", workspace, operationId: "op-1" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("symbolic links");
    await expect(lstat(tree)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(lstat(path.join(tree, "late-link.txt"))).resolves.toMatchObject({
      isSymbolicLink: expect.any(Function),
    });
  });

  it("does not overwrite an externally recreated delete target during rollback", async () => {
    const workspace = await temporaryDirectory("nausicaa-delete-rollback-race-");
    const tree = path.join(workspace, "tree");
    await mkdir(tree);
    await writeFile(path.join(tree, "safe.txt"), "safe", "utf8");
    filesystemRace.afterDirectoryRead = {
      matches: (directory) => path.basename(directory).startsWith(".nausicaa-delete-"),
      run: async (quarantine) => {
        await rm(path.join(quarantine, "safe.txt"));
        await symlink(quarantine, path.join(quarantine, "safe.txt"), "dir");
        await mkdir(tree);
        await writeFile(path.join(tree, "external.txt"), "external", "utf8");
      },
    };

    const result = await createPathDeleteTool().execute(
      { path: "tree", recursive: true },
      { runId: "run-1", workspace, operationId: "op-1" },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("quarantine retained");
    await expect(readFile(path.join(tree, "external.txt"), "utf8")).resolves.toBe("external");
    expect((await readdir(workspace)).some((entry) => entry.startsWith(".nausicaa-delete-"))).toBe(true);
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function isNotFound(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}
