import { describe, expect, it } from "vitest";

import {
  collectMarkedImages,
  evictImagesToBudget,
  formatImageMarker,
  imageMarkerIds,
  remapImageMarkers,
} from "../../src/cli/image-markers.js";

describe("image markers", () => {
  it("formats, parses, and remaps marker ids", () => {
    expect(formatImageMarker(7)).toBe("[image #7]");
    expect(imageMarkerIds("[image #2] x [image #1] [image #9007199254740992]"))
      .toEqual([2, 1]);
    expect(remapImageMarkers("[image #1] [image #01] [image #2]", new Map([[1, 7]])))
      .toBe("[image #7] [image #7] [image #2]");
  });

  it("collects each live image once in registry insertion order", () => {
    const images = new Map([
      [1, "first"],
      [2, "second"],
      [3, "deleted"],
    ]);

    expect(collectMarkedImages(images, "[image #2] [image #1] [image #1]"))
      .toEqual(["first", "second"]);
    expect(collectMarkedImages(images, "no markers")).toEqual([]);
  });

  it("evicts oldest unprotected images until the budget is met", () => {
    const images = new Map([
      [1, "aaaa"],
      [2, "bbbb"],
      [3, "cccc"],
    ]);

    evictImagesToBudget(images, (value) => value.length, 8, new Set([1]));

    expect([...images.keys()]).toEqual([1, 3]);
  });

  it("rejects a protected set that would exceed the hard budget", () => {
    const images = new Map([
      [1, "aaaa"],
      [2, "bbbb"],
    ]);

    expect(() => evictImagesToBudget(
      images,
      (value) => value.length,
      1,
      new Set([1, 2]),
    )).toThrow(/registry budget/i);

    expect([...images.keys()]).toEqual([1, 2]);
  });
});
