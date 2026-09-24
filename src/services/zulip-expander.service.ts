import { Inject, Injectable } from '@nestjs/common';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { ZulipExpanderKind } from 'src/schema/tables/zulip-expander.table';

export const ZULIP_EXPANDERS: ZulipExpanderKind[] = ['github', 'twitter'];

const inOrder = (expanders: Iterable<ZulipExpanderKind>) => {
  const set = new Set(expanders);
  return ZULIP_EXPANDERS.filter((expander) => set.has(expander));
};

/** The `zulip_expander` table, cached so that no message costs a query; only this service writes the table. */
@Injectable()
export class ZulipExpanderService {
  private streams = new Map<number, Set<ZulipExpanderKind>>();
  private writes = new Map<number, Promise<unknown>>();

  constructor(@Inject(IDatabaseRepository) private database: IDatabaseRepository) {}

  async init() {
    const rows = await this.database.getZulipExpanders();
    this.streams = new Map();
    for (const { streamId, expander } of rows) {
      this.cache(streamId, expander);
    }
  }

  isEnabled(streamId: number, expander: ZulipExpanderKind) {
    return this.streams.get(streamId)?.has(expander) ?? false;
  }

  enabledIn(streamId: number) {
    return inOrder(this.streams.get(streamId) ?? []);
  }

  list() {
    return [...this.streams.keys()]
      .sort((a, b) => a - b)
      .map((streamId) => ({ streamId, expanders: this.enabledIn(streamId) }));
  }

  /** Resolves to the expanders that were off and are now on. */
  enable(streamId: number, expanders: ZulipExpanderKind[], createdBy: string) {
    return this.write(streamId, async () => {
      const added = await this.database.addZulipExpanders(streamId, expanders, createdBy);
      return inOrder(added.map(({ expander }) => expander));
    });
  }

  /** Resolves to the expanders that were on and are now off. */
  disable(streamId: number, expanders: ZulipExpanderKind[]) {
    return this.write(streamId, async () => {
      const removed = await this.database.removeZulipExpanders(streamId, expanders);
      return inOrder(removed.map(({ expander }) => expander));
    });
  }

  /**
   * A command the event loop stopped waiting for can still be writing when the next one runs, so a stream's writes
   * run one at a time and its cache is read back from the table after each.
   */
  private write<T>(streamId: number, change: () => Promise<T>): Promise<T> {
    const run = (this.writes.get(streamId) ?? Promise.resolve()).then(async () => {
      try {
        return await change();
      } finally {
        await this.reload(streamId);
      }
    });
    const settled = run.catch(() => undefined);
    this.writes.set(streamId, settled);
    void settled.then(() => {
      if (this.writes.get(streamId) === settled) {
        this.writes.delete(streamId);
      }
    });
    return run;
  }

  private async reload(streamId: number) {
    const rows = await this.database.getZulipExpanders();
    this.streams.delete(streamId);
    for (const row of rows) {
      if (row.streamId === streamId) {
        this.cache(streamId, row.expander);
      }
    }
  }

  private cache(streamId: number, expander: ZulipExpanderKind) {
    const enabled = this.streams.get(streamId) ?? new Set();
    enabled.add(expander);
    this.streams.set(streamId, enabled);
  }
}
