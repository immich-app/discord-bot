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
  async enable(streamId: number, expanders: ZulipExpanderKind[], createdBy: string) {
    const added = await this.database.addZulipExpanders(streamId, expanders, createdBy);
    for (const { expander } of added) {
      this.cache(streamId, expander);
    }
    return inOrder(added.map(({ expander }) => expander));
  }

  /** Resolves to the expanders that were on and are now off. */
  async disable(streamId: number, expanders: ZulipExpanderKind[]) {
    const removed = await this.database.removeZulipExpanders(streamId, expanders);
    const enabled = this.streams.get(streamId);
    for (const { expander } of removed) {
      enabled?.delete(expander);
    }
    if (enabled?.size === 0) {
      this.streams.delete(streamId);
    }
    return inOrder(removed.map(({ expander }) => expander));
  }

  private cache(streamId: number, expander: ZulipExpanderKind) {
    const enabled = this.streams.get(streamId) ?? new Set();
    enabled.add(expander);
    this.streams.set(streamId, enabled);
  }
}
