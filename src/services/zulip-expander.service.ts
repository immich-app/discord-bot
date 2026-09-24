import { Inject, Injectable, Logger } from '@nestjs/common';
import { IDatabaseRepository } from 'src/interfaces/database.interface';

/** The streams of the `zulip_expander` table, cached so that no message costs a query; only this service writes the table. */
@Injectable()
export class ZulipExpanderService {
  private logger = new Logger(ZulipExpanderService.name);
  private streams = new Set<number>();
  private writes = new Map<number, Promise<unknown>>();

  constructor(@Inject(IDatabaseRepository) private database: IDatabaseRepository) {}

  async init() {
    const rows = await this.database.getZulipExpanders();
    this.streams = new Set(rows.map(({ streamId }) => streamId));
  }

  isEnabled(streamId: number) {
    return this.streams.has(streamId);
  }

  list() {
    return [...this.streams].sort((a, b) => a - b);
  }

  /** Resolves to whether it was off and is now on. */
  enable(streamId: number, createdBy: string) {
    return this.write(streamId, () => this.database.addZulipExpander(streamId, createdBy), true);
  }

  /** Resolves to whether it was on and is now off. */
  disable(streamId: number) {
    return this.write(streamId, () => this.database.removeZulipExpander(streamId), false);
  }

  /**
   * A command the event loop stopped waiting for can still be writing when the next one runs, so a stream's writes
   * run one at a time and its cache is read back from the table after each.
   */
  private write(streamId: number, change: () => Promise<boolean>, enabled: boolean): Promise<boolean> {
    const run = (this.writes.get(streamId) ?? Promise.resolve()).then(async () => {
      let changed: boolean;
      try {
        changed = await change();
      } catch (error) {
        await this.reload(streamId).catch(() => undefined);
        throw error;
      }
      try {
        await this.reload(streamId);
      } catch (error) {
        this.logger.warn(
          `Could not read the Zulip expanders of stream ${streamId} back, so the change is cached as the table reported it`,
          error,
        );
        this.cache(streamId, enabled);
      }
      return changed;
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
    this.cache(
      streamId,
      rows.some((row) => row.streamId === streamId),
    );
  }

  private cache(streamId: number, enabled: boolean) {
    if (enabled) {
      this.streams.add(streamId);
    } else {
      this.streams.delete(streamId);
    }
  }
}
