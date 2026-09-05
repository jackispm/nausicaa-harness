// Minimally adapted from Prime Agent commit 7787f07415d843b9a800f6a4720e0c739bd608e5 (MIT).

export interface QueueSelectionItem {
  inputId: string;
  revision: number;
  delivery: "steering" | "follow-up";
  text: string;
  sequence: number;
}

export type QueueSelectionMove =
  | { kind: "item"; item: QueueSelectionItem }
  | { kind: "draft"; text: string };

/**
 * Tracks the pending input being edited while preserving the user's draft.
 * Durable mutation remains a SessionController responsibility.
 */
export class QueueSelection {
  private items: QueueSelectionItem[] = [];
  private cursor = -1;
  private draft = "";
  private hasStashedDraft = false;

  get selected(): QueueSelectionItem | undefined {
    const selected = this.cursor >= 0 ? this.items[this.cursor] : undefined;
    return selected === undefined ? undefined : { ...selected };
  }

  get isBrowsing(): boolean {
    return this.cursor >= 0;
  }

  get hasDraft(): boolean {
    return this.hasStashedDraft;
  }

  replaceDraft(draft: string): void {
    this.draft = draft;
    this.hasStashedDraft = true;
  }

  /** Move newest-first from the draft into pending inputs and back. */
  move(
    queue: readonly QueueSelectionItem[],
    draft: string,
    direction: -1 | 1,
  ): QueueSelectionMove | undefined {
    if (this.cursor < 0) {
      if (direction > 0) return undefined;
      this.items = ordered(queue);
      if (this.items.length === 0) return undefined;
      if (!this.hasStashedDraft) {
        this.draft = draft;
        this.hasStashedDraft = true;
      }
      this.cursor = this.items.length - 1;
      return { kind: "item", item: this.selected! };
    }

    const next = this.cursor + direction;
    if (next < 0 || next > this.items.length) return undefined;
    if (next === this.items.length) {
      return { kind: "draft", text: this.reset() };
    }
    this.cursor = next;
    return { kind: "item", item: this.selected! };
  }

  /**
   * Reconcile a durable queue refresh. A changed revision is a different
   * editable snapshot even when the input id remains stable.
   */
  sync(queue: readonly QueueSelectionItem[]): QueueSelectionItem | undefined {
    const selected = this.selected;
    this.items = ordered(queue);
    if (selected === undefined) return undefined;

    const exact = this.items.findIndex((item) => (
      item.inputId === selected.inputId && item.revision === selected.revision
    ));
    if (exact >= 0) {
      this.cursor = exact;
      return undefined;
    }
    this.cursor = -1;
    return selected;
  }

  /** Leave browse mode and return the stashed draft exactly once. */
  reset(): string {
    this.cursor = -1;
    this.items = [];
    const draft = this.draft;
    this.draft = "";
    this.hasStashedDraft = false;
    return draft;
  }
}

function ordered(queue: readonly QueueSelectionItem[]): QueueSelectionItem[] {
  return [...queue]
    .sort((left, right) => left.sequence - right.sequence)
    .map((item) => ({ ...item }));
}
