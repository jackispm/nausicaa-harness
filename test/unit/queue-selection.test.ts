import { describe, expect, it } from "vitest";

import {
  QueueSelection,
  type QueueSelectionItem,
} from "../../src/cli/queue-selection.js";

const queue: QueueSelectionItem[] = [
  item("s1", 1, "steering", 1),
  item("f1", 1, "follow-up", 2),
  item("s2", 1, "steering", 3),
];

describe("QueueSelection", () => {
  it("browses pending inputs newest-first and restores the draft", () => {
    const selection = new QueueSelection();

    expect(selection.move(queue, "draft", 1)).toBeUndefined();
    expect(selection.move(queue, "draft", -1)).toEqual({
      kind: "item",
      item: item("s2", 1, "steering", 3),
    });
    expect(selection.move(queue, "ignored", -1)).toEqual({
      kind: "item",
      item: item("f1", 1, "follow-up", 2),
    });
    expect(selection.move(queue, "ignored", -1)).toEqual({
      kind: "item",
      item: item("s1", 1, "steering", 1),
    });
    expect(selection.move(queue, "ignored", -1)).toBeUndefined();

    expect(selection.move(queue, "ignored", 1)?.kind).toBe("item");
    expect(selection.move(queue, "ignored", 1)?.kind).toBe("item");
    expect(selection.move(queue, "ignored", 1)).toEqual({
      kind: "draft",
      text: "draft",
    });
    expect(selection.isBrowsing).toBe(false);
  });

  it("does not enter browse mode when the queue is empty", () => {
    const selection = new QueueSelection();
    expect(selection.move([], "draft", -1)).toBeUndefined();
    expect(selection.isBrowsing).toBe(false);
  });

  it("keeps the selection by input id and revision across reordering", () => {
    const selection = new QueueSelection();
    selection.move(queue, "draft", -1);

    expect(selection.sync([queue[2]!, queue[0]!, queue[1]!])).toBeUndefined();
    expect(selection.selected).toEqual(item("s2", 1, "steering", 3));
  });

  it("drops a selected snapshot when its revision changes or it is delivered", () => {
    const selection = new QueueSelection();
    selection.move(queue, "draft", -1);

    expect(selection.sync([
      queue[0]!,
      queue[1]!,
      item("s2", 2, "steering", 3),
    ])).toEqual(item("s2", 1, "steering", 3));
    expect(selection.isBrowsing).toBe(false);

    selection.move([queue[0]!], "edited queue text", -1);
    expect(selection.sync([])).toEqual(queue[0]);
    expect(selection.reset()).toBe("draft");
  });

  it("returns a replaced draft once", () => {
    const selection = new QueueSelection();
    selection.move(queue, "original draft", -1);
    selection.replaceDraft("queue edit kept as draft");

    expect(selection.reset()).toBe("queue edit kept as draft");
    expect(selection.reset()).toBe("");
  });
});

function item(
  inputId: string,
  revision: number,
  delivery: "steering" | "follow-up",
  sequence: number,
): QueueSelectionItem {
  return { inputId, revision, delivery, text: inputId, sequence };
}
