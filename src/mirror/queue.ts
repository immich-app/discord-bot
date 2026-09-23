import { Logger } from '@nestjs/common';

type Op = { label: string; run: () => Promise<void> };

/**
 * Runs ops one at a time, in order. Nothing is ever dropped while the queue is open; an op that outlives the watchdog
 * is left running, since it cannot be cancelled, and the queue moves on to the next one.
 */
export class SerialQueue {
  private pending: Op[] = [];
  private running = false;
  private closed = false;
  private idle: (() => void)[] = [];
  private readonly watchdogMs: number;
  private readonly warnEvery: number;

  constructor(
    private readonly name: string,
    private readonly logger: Logger,
    options: { watchdogMs?: number; warnEvery?: number } = {},
  ) {
    this.watchdogMs = options.watchdogMs ?? 180_000;
    this.warnEvery = options.warnEvery ?? 100;
  }

  push(label: string, run: () => Promise<void>) {
    this.enqueue([{ label, run }], 'last');
  }

  /** Inserts ops to run right after the current one, in the given order. */
  pushNext(ops: Op[]) {
    this.enqueue(ops, 'next');
  }

  whenIdle() {
    if (!this.running) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.idle.push(resolve));
  }

  /** Refuses new ops; the ones already queued still run. */
  close() {
    this.closed = true;
  }

  private enqueue(ops: Op[], where: 'next' | 'last') {
    if (ops.length === 0) {
      return;
    }
    if (this.closed) {
      for (const { label } of ops) {
        this.logger.debug(`${this.name}: not running ${label}, the queue is closed`);
      }
      return;
    }

    const before = this.pending.length;
    if (where === 'next') {
      this.pending.unshift(...ops);
    } else {
      this.pending.push(...ops);
    }
    const after = this.pending.length;
    if (Math.floor(after / this.warnEvery) > Math.floor(before / this.warnEvery)) {
      this.logger.warn(`${this.name}: ${after} operations are waiting`);
    }

    if (!this.running) {
      this.running = true;
      void Promise.resolve().then(() => this.drain());
    }
  }

  private async drain() {
    for (let op = this.pending.shift(); op; op = this.pending.shift()) {
      await this.runOne(op);
    }
    this.running = false;
    for (const resolve of this.idle.splice(0)) {
      resolve();
    }
  }

  private runOne({ label, run }: Op) {
    this.logger.debug(`${this.name}: ${label}`);
    return new Promise<void>((resolve) => {
      let abandoned = false;
      const watchdog = setTimeout(() => {
        abandoned = true;
        this.logger.error(
          `${this.name}: ${label} has not finished after ${this.watchdogMs / 1000} s; the queue is moving on without it`,
        );
        resolve();
      }, this.watchdogMs);
      watchdog.unref();

      let result: Promise<void>;
      try {
        result = run();
      } catch (error) {
        result = Promise.reject(error as Error);
      }
      result.then(
        () => {
          clearTimeout(watchdog);
          if (abandoned) {
            this.logger.warn(`${this.name}: ${label} finished after the queue had moved on without it`);
          }
          resolve();
        },
        (error: unknown) => {
          clearTimeout(watchdog);
          this.logger.error(
            `${this.name}: ${label} failed${abandoned ? ' after the queue had moved on without it' : ''}`,
            error,
          );
          resolve();
        },
      );
    });
  }
}
