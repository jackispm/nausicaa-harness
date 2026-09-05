import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ImageInputError,
  MAX_INPUT_IMAGE_BYTES,
  processImageInputs,
} from "../../src/cli/image-input.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("image input", () => {
  it("loads workspace images by magic bytes and emits Prime-style references", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(path.join(workspace, 'screen & "one".txt'), TINY_PNG);

    const result = await processImageInputs(['screen & "one".txt'], { workspace });

    expect(result.text).toBe('<file name="screen &amp; &quot;one&quot;.txt"></file>');
    expect(result.images).toEqual([{
      type: "image",
      mimeType: "image/png",
      data: TINY_PNG.toString("base64"),
    }]);
  });

  it("rejects extension spoofing and oversized files", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(path.join(workspace, "fake.png"), "not an image");
    await writeFile(
      path.join(workspace, "large.png"),
      Buffer.concat([TINY_PNG, Buffer.alloc(MAX_INPUT_IMAGE_BYTES)]),
    );

    await expect(processImageInputs(["fake.png"], { workspace }))
      .rejects.toThrow(/not a supported/i);
    await expect(processImageInputs(["large.png"], { workspace }))
      .rejects.toThrow(/image limit/i);
  });

  it("enforces count, workspace, protected-path, and symlink boundaries", async () => {
    const workspace = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(path.join(workspace, "image.png"), TINY_PNG);
    await writeFile(path.join(outside, "outside.png"), TINY_PNG);
    await symlink(path.join(outside, "outside.png"), path.join(workspace, "alias.png"));
    await mkdir(path.join(workspace, ".nausicaa"));
    await writeFile(path.join(workspace, ".nausicaa", "hidden.png"), TINY_PNG);

    await expect(processImageInputs(Array(5).fill("image.png"), { workspace }))
      .rejects.toThrow(/at most 4/i);
    await expect(processImageInputs([path.join(outside, "outside.png")], { workspace }))
      .rejects.toThrow(/absolute|workspace/i);
    await expect(processImageInputs(["../outside.png"], { workspace }))
      .rejects.toThrow(/escapes/i);
    await expect(processImageInputs(["alias.png"], { workspace }))
      .rejects.toThrow(/symbolic-link/i);
    await expect(processImageInputs([".nausicaa/hidden.png"], { workspace }))
      .rejects.toThrow(/protected/i);
  });

  it("rejects empty images", async () => {
    const workspace = await temporaryDirectory();
    await writeFile(path.join(workspace, "empty.png"), "");
    await expect(processImageInputs(["empty.png"], { workspace }))
      .rejects.toThrow(ImageInputError);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "nausicaa-image-input-"));
  temporaryDirectories.push(directory);
  return directory;
}
