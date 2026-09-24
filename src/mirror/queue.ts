import { Logger } from '@nestjs/common';

type Op = { label: string; run: () => Promise<void> };

/**
 * Runs ops one at a time, in order: the next op starts only once the current one settles. Nothing is ever dropped while
 * the queue is open; an op that outlives the watchdog is logged, and again each time the watchdog comes round, since it
 * cannot be cancelled and running the next op beside it would break the order.
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

  pushNext(ops: Op[]) {
    this.enqueue(ops, 'next');
  }

  whenIdle() {
    if (!this.running) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.idle.push(resolve));
  }

  close() {
    this.closed = true;
  }

  isOpen() {
    return !this.closed;
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
      let overdue = 0;
      const watchdog = setInterval(() => {
        overdue++;
        this.logger.error(
          `${this.name}: ${label} has not finished after ${(overdue * this.watchdogMs) / 1000} s; the queue waits for it`,
        );
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
          clearInterval(watchdog);
          if (overdue > 0) {
            this.logger.warn(`${this.name}: ${label} finished late, and the queue goes on`);
          }
          resolve();
        },
        (error: unknown) => {
          clearInterval(watchdog);
          this.logger.error(`${this.name}: ${label} failed${overdue > 0 ? ' late, and the queue goes on' : ''}`, error);
          resolve();
        },
      );
    });
  }
}
