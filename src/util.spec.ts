import { Logger } from '@nestjs/common';
import { NotificationService } from 'src/services/notification.service';
import { logError, withErrorLogging } from 'src/util';
import { beforeEach, describe, expect, it, vitest } from 'vitest';

describe('logError', () => {
  let notify: ReturnType<typeof vitest.fn>;
  let notifications: NotificationService;
  let logger: Logger;

  beforeEach(() => {
    notify = vitest.fn().mockResolvedValue(undefined);
    notifications = { notify } as unknown as NotificationService;
    logger = { error: vitest.fn() } as unknown as Logger;
  });

  it('should log the error and post it to team.bot as a log line', async () => {
    const error = new Error('boom');

    await logError('Something failed', error, { notifications, logger });

    expect(logger.error).toHaveBeenCalledExactlyOnceWith('Something failed', error);
    expect(notify).toHaveBeenCalledExactlyOnceWith('team.bot', {
      kind: 'log',
      title: 'Something failed',
      body: 'Error: boom',
    });
  });

  it('should resolve and only log when the post itself throws', async () => {
    notify.mockRejectedValue(new TypeError('renderer bug'));

    await expect(logError('Something failed', new Error('boom'), { notifications, logger })).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenLastCalledWith(
      'Failed to send error message to bot spam channel',
      new TypeError('renderer bug'),
    );
  });

  it('should resolve when the error cannot be turned into text', async () => {
    await expect(logError('Something failed', Object.create(null), { notifications, logger })).resolves.toBeUndefined();

    expect(notify).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});

describe('withErrorLogging', () => {
  let notify: ReturnType<typeof vitest.fn>;
  let notifications: NotificationService;
  let logger: Logger;

  beforeEach(() => {
    notify = vitest.fn().mockResolvedValue(undefined);
    notifications = { notify } as unknown as NotificationService;
    logger = { error: vitest.fn() } as unknown as Logger;
  });

  it('should return what the method returns and post nothing', async () => {
    const result = await withErrorLogging({
      message: 'Failed',
      method: () => Promise.resolve(42),
      fallbackValue: 0,
      notifications,
      logger,
    });

    expect(result).toBe(42);
    expect(notify).not.toHaveBeenCalled();
  });

  it('should post the failure to team.bot and return the fallback', async () => {
    const result = await withErrorLogging({
      message: 'Failed',
      method: () => Promise.reject(new Error('db down')),
      fallbackValue: 0,
      notifications,
      logger,
    });

    expect(result).toBe(0);
    expect(notify).toHaveBeenCalledExactlyOnceWith('team.bot', {
      kind: 'log',
      title: 'Failed',
      body: 'Error: db down',
    });
  });
});
