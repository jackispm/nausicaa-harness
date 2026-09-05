import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_USER_IMAGE_BYTES } from "../../src/domain/images.js";
import { createReadImageTool } from "../../src/tools/read-image.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("read_image tool", () => {
  it("returns a provider-native image block with bounded metadata", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(path.join(workspace, "screen.png"), TINY_PNG);

    const result = await createReadImageTool().execute({ path: "screen.png" }, context(workspace));

    expect(result).toEqual({
      content: JSON.stringify({
        path: "screen.png",
        mimeType: "image/png",
        byteLength: TINY_PNG.byteLength,
      }),
      isError: false,
      images: [{
        type: "image",
        mimeType: "image/png",
        data: TINY_PNG.toString("base64"),
      }],
    });
  });

  it("validates magic bytes, size, and workspace symlink boundaries", async () => {
    const workspace = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(path.join(workspace, "fake.png"), "not an image");
    await writeFile(path.join(workspace, "large.png"), Buffer.concat([TINY_PNG, Buffer.alloc(MAX_USER_IMAGE_BYTES)]));
    await writeFile(path.join(outside, "outside.png"), TINY_PNG);
    await symlink(path.join(outside, "outside.png"), path.join(workspace, "alias.png"));

    const tool = createReadImageTool();
    await expect(tool.execute({ path: "fake.png" }, context(workspace))).resolves.toMatchObject({ isError: true });
    await expect(tool.execute({ path: "large.png" }, context(workspace))).resolves.toMatchObject({ isError: true });
    await expect(tool.execute({ path: "alias.png" }, context(workspace))).resolves.toMatchObject({ isError: true });
  });
});

function context(workspace: string) {
  return { runId: "run-1", workspace, operationId: "operation-1" };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "nausicaa-read-image-"));
  temporaryDirectories.push(directory);
  return directory;
}
