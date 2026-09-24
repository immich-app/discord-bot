import { Logger } from '@nestjs/common';
import { SerialQueue } from 'src/mirror/queue';
import { afterEach, beforeEach, describe, expect, it, Mocked, vitest } from 'vitest';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async () => {
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
  }
};

const newLogger = () =>
  ({ debug: vitest.fn(), log: vitest.fn(), warn: vitest.fn(), error: vitest.fn() }) as unknown as Mocked<Logger>;

describe(SerialQueue.name, () => {
  let logger: Mocked<Logger>;
  let events: string[];

  beforeEach(() => {
    logger = newLogger();
    events = [];
  });

  afterEach(() => {
    vitest.useRealTimers();
  });

  const op = (name: string, wait?: Promise<void>) => async () => {
    events.push(`start ${name}`);
    await wait;
    events.push(`end ${name}`);
  };

  it('should run ops one at a time, in order, while an earlier op is slow', async () => {
    const queue = new SerialQueue('Dev', logger);
    const slow = deferred();
    queue.push('a', op('a', slow.promise));
    queue.push('b', op('b'));
    queue.push('c', op('c'));
    await flush();
    expect(events).toEqual(['start a']);

    slow.resolve();
    await queue.whenIdle();
    expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('should not start an op inside push', () => {
    const queue = new SerialQueue('Dev', logger);
    queue.push('a', op('a'));
    expect(events).toEqual([]);
  });

  it('should run pushNext ops right after the current one, in the order given', async () => {
    const queue = new SerialQueue('Dev', logger);
    const slow = deferred();
    queue.push('catch-up', op('catch-up', slow.promise));
    queue.push('live', op('live'));
    await flush();
    queue.pushNext([
      { label: 'first', run: op('first') },
      { label: 'second', run: op('second') },
    ]);

    slow.resolve();
    await queue.whenIdle();
    expect(events.filter((event) => event.startsWith('start'))).toEqual([
      'start catch-up',
      'start first',
      'start second',
      'start live',
    ]);
  });

  it('should keep going after an op throws or rejects', async () => {
    const queue = new SerialQueue('Dev', logger);
    const error = new Error('boom');
    queue.push('throws', () => {
      throw error;
    });
    queue.push('rejects', () => Promise.reject(error));
    queue.push('after', op('after'));
    await queue.whenIdle();

    expect(events).toEqual(['start after', 'end after']);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith('Dev: throws failed', error);
    expect(logger.error).toHaveBeenCalledWith('Dev: rejects failed', error);
  });

  it('should log each op at debug', async () => {
    const queue = new SerialQueue('Dev', logger);
    queue.push('Zulip message 5', op('a'));
    await queue.whenIdle();
    expect(logger.debug).toHaveBeenCalledWith('Dev: Zulip message 5');
  });

  it('should resolve whenIdle at once when nothing is queued', async () => {
    await expect(new SerialQueue('Dev', logger).whenIdle()).resolves.toBeUndefined();
  });

  it('should wait in whenIdle for ops pushed while it waits', async () => {
    const queue = new SerialQueue('Dev', logger);
    queue.push('a', async () => {
      events.push('a');
      queue.push('b', op('b'));
    });
    await queue.whenIdle();
    expect(events).toEqual(['a', 'start b', 'end b']);
  });

  it('should wait for an op past the watchdog, warning again each time it comes round, and log the late settle', async () => {
    vitest.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const queue = new SerialQueue('Dev', logger);
    const stuck = deferred();
    queue.push('Zulip message 1', op('stuck', stuck.promise));
    queue.push('Zulip message 2', op('next'));
    await flush();

    await vitest.advanceTimersByTimeAsync(179_999);
    expect(events).toEqual(['start stuck']);
    expect(logger.error).not.toHaveBeenCalled();

    await vitest.advanceTimersByTimeAsync(1);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      'Dev: Zulip message 1 has not finished after 180 s; the queue waits for it',
    );
    expect(events).toEqual(['start stuck']);

    await vitest.advanceTimersByTimeAsync(360_000);
    expect(logger.error.mock.calls).toEqual([
      ['Dev: Zulip message 1 has not finished after 180 s; the queue waits for it'],
      ['Dev: Zulip message 1 has not finished after 360 s; the queue waits for it'],
      ['Dev: Zulip message 1 has not finished after 540 s; the queue waits for it'],
    ]);
    expect(events).toEqual(['start stuck']);

    stuck.resolve();
    await queue.whenIdle();
    expect(events).toEqual(['start stuck', 'end stuck', 'start next', 'end next']);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('Dev: Zulip message 1 finished late, and the queue goes on');
    await vitest.advanceTimersByTimeAsync(1_000_000);
    expect(logger.error).toHaveBeenCalledTimes(3);
    expect(vitest.getTimerCount()).toBe(0);
  });

  it('should log a late failure as an error, and only then run the next op', async () => {
    vitest.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const queue = new SerialQueue('Dev', logger, { watchdogMs: 1000 });
    const stuck = deferred();
    const error = new Error('late');
    queue.push('op', op('stuck', stuck.promise));
    queue.push('next', op('next'));
    await flush();
    await vitest.advanceTimersByTimeAsync(1000);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('Dev: op has not finished after 1 s; the queue waits for it');
    expect(events).toEqual(['start stuck']);

    stuck.reject(error);
    await queue.whenIdle();
    expect(logger.error).toHaveBeenLastCalledWith('Dev: op failed late, and the queue goes on', error);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(events).toEqual(['start stuck', 'start next', 'end next']);
  });

  it('should clear the watchdog of an op that finishes in time', async () => {
    vitest.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const queue = new SerialQueue('Dev', logger, { watchdogMs: 1000 });
    queue.push('op', op('quick'));
    await queue.whenIdle();
    await vitest.advanceTimersByTimeAsync(5000);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(vitest.getTimerCount()).toBe(0);
  });

  it('should warn at every warnEvery pending ops, and never drop one', async () => {
    const queue = new SerialQueue('Dev', logger, { warnEvery: 3 });
    const slow = deferred();
    queue.push('first', op('first', slow.promise));
    await flush();
    for (let index = 0; index < 7; index++) {
      queue.push(`op ${index}`, op(`${index}`));
    }
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(1, 'Dev: 3 operations are waiting');
    expect(logger.warn).toHaveBeenNthCalledWith(2, 'Dev: 6 operations are waiting');

    queue.pushNext([
      { label: 'x', run: op('x') },
      { label: 'y', run: op('y') },
    ]);
    expect(logger.warn).toHaveBeenLastCalledWith('Dev: 9 operations are waiting');

    slow.resolve();
    await queue.whenIdle();
    expect(events.filter((event) => event.startsWith('end'))).toHaveLength(10);
  });

  it('should ignore an empty pushNext', async () => {
    const queue = new SerialQueue('Dev', logger);
    queue.pushNext([]);
    await expect(queue.whenIdle()).resolves.toBeUndefined();
  });

  it('should refuse new ops once closed, and still run the queued ones', async () => {
    const queue = new SerialQueue('Dev', logger);
    const slow = deferred();
    queue.push('queued', op('queued', slow.promise));
    queue.close();
    queue.push('late', op('late'));
    queue.pushNext([{ label: 'later', run: op('later') }]);

    slow.resolve();
    await queue.whenIdle();
    expect(events).toEqual(['start queued', 'end queued']);
    expect(logger.debug).toHaveBeenCalledWith('Dev: not running late, the queue is closed');
    expect(logger.debug).toHaveBeenCalledWith('Dev: not running later, the queue is closed');
  });
});
