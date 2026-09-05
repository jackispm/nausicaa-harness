import type {
  AnyEvent,
  AppendEvent,
  EventEnvelope,
  EventType,
} from "../domain/events.js";
import {
  LedgerClosedError,
  LedgerState,
  type Ledger,
  type LedgerOptions,
  type ReadEventsOptions,
} from "./ledger.js";

export class MemoryLedger implements Ledger {
  readonly #state: LedgerState;
  #closed = false;

  constructor(options: LedgerOptions = {}) {
    this.#state = new LedgerState([], options);
  }

  async append<K extends EventType>(
    input: AppendEvent<K>,
  ): Promise<EventEnvelope<K>> {
    this.#assertOpen();
    const prepared = this.#state.prepare(input);
    if (!prepared.duplicate) {
      this.#state.commit(prepared.event as AnyEvent);
    }
    return prepared.event;
  }

  async read(options: ReadEventsOptions = {}): Promise<AnyEvent[]> {
    this.#assertOpen();
    return this.#state.read(options);
  }

  async watermark(): Promise<number> {
    this.#assertOpen();
    return this.#state.watermark;
  }

  async flush(): Promise<void> {
    this.#assertOpen();
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new LedgerClosedError("Ledger is closed");
    }
  }
}
