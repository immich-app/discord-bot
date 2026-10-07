import { Logger } from '@nestjs/common';
import { NotificationService } from 'src/services/notification.service';
import { isPullRequestLine, logError, makeIssueOrPRMessage, makeLink, withErrorLogging } from 'src/util';
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

describe('isPullRequestLine', () => {
  const pullRequestUrl = (number: number) => `https://github.com/immich-app/immich/pull/${number}`;
  const line = ({
    type = 'PullRequest',
    number = 1,
    title = 'fix: upload',
    discordThreadId,
  }: { type?: string; number?: number; title?: string; discordThreadId?: string } = {}) =>
    makeIssueOrPRMessage({
      type,
      title,
      link: makeLink('immich-app', 'immich', number, pullRequestUrl(number)),
      discordThreadId,
    });

  it.each([
    { what: "the pull request's line", line: line(), url: pullRequestUrl(1), expected: true },
    {
      what: "the pull request's line with its Discord thread",
      line: line({ discordThreadId: '1200000000000000001' }),
      url: pullRequestUrl(1),
      expected: true,
    },
    {
      what: "the pull request's line asked about in another case",
      line: line(),
      url: 'https://github.com/Immich-App/Immich/pull/1',
      expected: true,
    },
    { what: 'an issue line', line: line({ type: 'Issue' }), url: pullRequestUrl(1), expected: false },
    {
      what: 'the line of a pull request whose number starts the same',
      line: line({ number: 12 }),
      url: pullRequestUrl(1),
      expected: false,
    },
    { what: 'a line already marked', line: `:approved2: ${line()}`, url: pullRequestUrl(1), expected: false },
    {
      what: "a code line that ends like the pull request's line",
      line: `revert(${makeLink('immich-app', 'immich', 1, pullRequestUrl(1))})`,
      url: pullRequestUrl(1),
      expected: false,
    },
    {
      what: "another pull request's line whose title quotes the link",
      line: line({ number: 5, title: `Follow-up to ${makeLink('immich-app', 'immich', 1, pullRequestUrl(1))}` }),
      url: pullRequestUrl(1),
      expected: false,
    },
  ])('should be $expected for $what', ({ line, url, expected }) => {
    expect(isPullRequestLine(line, url)).toBe(expected);
  });
});
