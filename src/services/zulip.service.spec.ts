import { Logger } from '@nestjs/common';
import { DateTime, Settings } from 'luxon';
import { Constants } from 'src/constants';
import { HolidayDto, IHolidaysInterface } from 'src/interfaces/holidays.interface';
import {
  IZulipInterface,
  ZulipEvent,
  ZulipEventQueue,
  ZulipMessagesDeleted,
  ZulipMessageUpdated,
  ZulipQueueRegistration,
  ZulipReceivedMessage,
} from 'src/interfaces/zulip.interface';
import { ZulipApiError } from 'src/repositories/zulip.client';
import { ZulipService } from 'src/services/zulip.service';
import { afterEach, beforeEach, describe, expect, it, Mock, Mocked, vitest } from 'vitest';

const { config } = vitest.hoisted(() => ({
  config: {
    zulip: {
      bot: { username: 'bot@example.com', apiKey: 'bot-key' },
      user: { username: 'human@example.com', apiKey: 'user-key' },
      realm: 'https://zulip.example.com',
    },
  },
}));

vitest.mock('src/config', () => ({ getConfig: () => config }));

/**
 * Characterization tests: these pin the CURRENT holiday notice ZulipService sends and the rule that
 * decides whether tomorrow's holiday deserves one. If an assertion changes during a refactor, the
 * refactor drifted - fix the code, never the assertion.
 */

const newHolidaysMock = (): Mocked<IHolidaysInterface> => ({
  getHolidays: vitest.fn().mockResolvedValue([]),
});

const newZulipMock = (): Mocked<IZulipInterface> => ({
  init: vitest.fn(),
  isInitialised: vitest.fn(),
  sendMessage: vitest.fn(),
  sendDirectMessage: vitest.fn(),
  createEmote: vitest.fn(),
  getMessage: vitest.fn(),
  updateMessage: vitest.fn(),
  listEmoji: vitest.fn(),
  getSubscriptions: vitest.fn(),
  getOwnUser: vitest.fn(),
  getUser: vitest.fn(),
  getStream: vitest.fn(),
  getMessages: vitest.fn(),
  registerQueue: vitest.fn(),
  getEvents: vitest.fn(),
  deleteQueue: vitest.fn(),
  deleteMessage: vitest.fn(),
  uploadFile: vitest.fn(),
  downloadUpload: vitest.fn(),
  getStreamMessagesBefore: vitest.fn(),
  getEmojiCodes: vitest.fn(),
});

/** A relevant holiday on the day after the frozen clock, unless overridden. */
const newHoliday = (overrides: Partial<HolidayDto> = {}): HolidayDto => ({
  date: '2026-07-04',
  localName: 'Independence Day',
  name: 'Independence Day',
  countryCode: 'US',
  global: true,
  counties: null,
  launchYear: 1776,
  types: ['Public'],
  ...overrides,
});

/** Freeze luxon's clock at the given UTC instant. */
const setNow = (iso: string) => {
  const millis = DateTime.fromISO(iso, { zone: 'utc' }).toMillis();
  Settings.now = () => millis;
};

const NOTICE = "Tomorrow is a federal holiday: Independence Day. There won't be any meetings tomorrow.";

describe('ZulipService', () => {
  let sut: ZulipService;
  let holidaysMock: Mocked<IHolidaysInterface>;
  let zulipMock: Mocked<IZulipInterface>;

  const originalNow = Settings.now;
  const originalZone = Settings.defaultZone;

  beforeEach(() => {
    // "Tomorrow" is resolved in the default zone, so pin it for deterministic dates.
    Settings.defaultZone = 'utc';
    // The cron fires at 22:00; this is the evening before Independence Day.
    setNow('2026-07-03T22:00:00.000Z');

    holidaysMock = newHolidaysMock();
    zulipMock = newZulipMock();
    sut = new ZulipService(holidaysMock, zulipMock);
  });

  afterEach(() => {
    Settings.now = originalNow;
    Settings.defaultZone = originalZone;
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('notifyHoliday', () => {
    it("should look up US holidays for tomorrow's year", async () => {
      await sut.notifyHoliday();

      expect(holidaysMock.getHolidays).toHaveBeenCalledOnce();
      expect(holidaysMock.getHolidays).toHaveBeenCalledWith('US', 2026);
    });

    it("should look up next year's holidays on New Year's Eve", async () => {
      setNow('2026-12-31T22:00:00.000Z');

      await sut.notifyHoliday();

      expect(holidaysMock.getHolidays).toHaveBeenCalledOnce();
      expect(holidaysMock.getHolidays).toHaveBeenCalledWith('US', 2027);
    });

    it('should post the notice to the Holidays topic of the FUTO staff stream', async () => {
      holidaysMock.getHolidays.mockResolvedValue([newHoliday()]);

      await sut.notifyHoliday();

      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage).toHaveBeenCalledWith({
        stream: 2,
        topic: 'Holidays',
        content: "Tomorrow is a federal holiday: Independence Day. There won't be any meetings tomorrow.",
      });
      expect(zulipMock.sendMessage.mock.calls[0][0].stream).toBe(Constants.Zulip.Streams.FUTOStaff);
      expect(zulipMock.createEmote).not.toHaveBeenCalled();
    });

    it('should use the holiday name, not the local name, in the notice', async () => {
      holidaysMock.getHolidays.mockResolvedValue([newHoliday({ name: 'Labor Day', localName: 'Labour Day' })]);

      await sut.notifyHoliday();

      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage).toHaveBeenCalledWith({
        stream: 2,
        topic: 'Holidays',
        content: "Tomorrow is a federal holiday: Labor Day. There won't be any meetings tomorrow.",
      });
    });

    it('should send nothing when there is no holiday tomorrow', async () => {
      holidaysMock.getHolidays.mockResolvedValue([
        newHoliday({ date: '2026-07-03', name: 'Today' }),
        newHoliday({ date: '2026-07-05', name: 'The day after tomorrow' }),
        newHoliday({ date: '2026-09-07', name: 'Labor Day' }),
      ]);

      await sut.notifyHoliday();

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should send nothing when there are no holidays at all', async () => {
      holidaysMock.getHolidays.mockResolvedValue([]);

      await sut.notifyHoliday();

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    describe('relevance', () => {
      const relevant: { reason: string; overrides: Partial<HolidayDto> }[] = [
        { reason: 'a global public holiday', overrides: { global: true, counties: null, types: ['Public'] } },
        { reason: 'a public holiday in Texas', overrides: { global: false, counties: ['US-TX'], types: ['Public'] } },
        {
          reason: 'a public holiday in Texas among other states',
          overrides: { global: false, counties: ['US-CA', 'US-TX', 'US-NY'], types: ['Public'] },
        },
        {
          reason: 'a global holiday that is public among other types',
          overrides: { global: true, counties: null, types: ['Bank', 'Public'] },
        },
      ];

      it.each(relevant)('should send a notice for $reason', async ({ overrides }) => {
        holidaysMock.getHolidays.mockResolvedValue([newHoliday(overrides)]);

        await sut.notifyHoliday();

        expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
        expect(zulipMock.sendMessage).toHaveBeenCalledWith({ stream: 2, topic: 'Holidays', content: NOTICE });
      });

      const irrelevant: { reason: string; overrides: Partial<HolidayDto> }[] = [
        {
          reason: 'a global holiday that is not public',
          overrides: { global: true, counties: null, types: ['Observance'] },
        },
        { reason: 'a global holiday without types', overrides: { global: true, counties: null, types: null } },
        { reason: 'a global holiday with an empty type list', overrides: { global: true, counties: null, types: [] } },
        {
          reason: 'a public holiday in other states only',
          overrides: { global: false, counties: ['US-CA', 'US-NY'], types: ['Public'] },
        },
        {
          reason: 'a public holiday that is neither global nor in any state',
          overrides: { global: false, counties: null, types: ['Public'] },
        },
        {
          reason: 'a Texas holiday that is not public',
          overrides: { global: false, counties: ['US-TX'], types: ['Optional'] },
        },
      ];

      it.each(irrelevant)('should not send a notice for $reason', async ({ overrides }) => {
        holidaysMock.getHolidays.mockResolvedValue([newHoliday(overrides)]);

        await sut.notifyHoliday();

        expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      });

      it('should skip an irrelevant holiday and announce the relevant one on the same date', async () => {
        holidaysMock.getHolidays.mockResolvedValue([
          newHoliday({ name: 'Some observance', types: ['Observance'] }),
          newHoliday({ name: 'Independence Day' }),
        ]);

        await sut.notifyHoliday();

        expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
        expect(zulipMock.sendMessage).toHaveBeenCalledWith({ stream: 2, topic: 'Holidays', content: NOTICE });
      });

      it('should announce only the first relevant holiday when several fall on the same date', async () => {
        holidaysMock.getHolidays.mockResolvedValue([
          newHoliday({ name: 'Independence Day' }),
          newHoliday({ name: 'Another holiday' }),
        ]);

        await sut.notifyHoliday();

        expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
        expect(zulipMock.sendMessage).toHaveBeenCalledWith({ stream: 2, topic: 'Holidays', content: NOTICE });
      });
    });

    describe('zone', () => {
      // 22:00 on July 3rd in Texas is already 03:00 on July 4th in UTC.
      const lateEveningInTexas = '2026-07-04T03:00:00.000Z';

      it('should resolve tomorrow in the default zone', async () => {
        Settings.defaultZone = 'America/Chicago';
        setNow(lateEveningInTexas);
        holidaysMock.getHolidays.mockResolvedValue([newHoliday({ date: '2026-07-04' })]);

        await sut.notifyHoliday();

        expect(holidaysMock.getHolidays).toHaveBeenCalledWith('US', 2026);
        expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
        expect(zulipMock.sendMessage).toHaveBeenCalledWith({ stream: 2, topic: 'Holidays', content: NOTICE });
      });

      it('should treat the same instant as the holiday itself when the default zone is UTC', async () => {
        Settings.defaultZone = 'utc';
        setNow(lateEveningInTexas);
        holidaysMock.getHolidays.mockResolvedValue([newHoliday({ date: '2026-07-04' })]);

        await sut.notifyHoliday();

        expect(holidaysMock.getHolidays).toHaveBeenCalledWith('US', 2026);
        expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      });
    });
  });

  describe('init', () => {
    const subscriptions = [{ streamId: 111 }, { streamId: 112 }, { streamId: 113 }];

    beforeEach(() => {
      config.zulip.bot.apiKey = 'bot-key';
      config.zulip.user.apiKey = 'user-key';
      zulipMock.getSubscriptions.mockResolvedValue(subscriptions);
      let endPoll = () => {};
      zulipMock.getOwnUser.mockResolvedValue({ userId: 7, fullName: 'Immich' });
      zulipMock.registerQueue.mockResolvedValue({
        queue: { queueId: 'q1', lastEventId: -1 },
        subscribedStreamIds: [Constants.Zulip.Streams.Immich, ...Object.values(Constants.Zulip.TeamStreams)],
      });
      zulipMock.getEvents.mockImplementation(() => new Promise((resolve) => (endPoll = () => resolve([]))));
      zulipMock.deleteQueue.mockImplementation(async () => endPoll());
      vitest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    });

    afterEach(async () => {
      await sut.onModuleDestroy();
      vitest.restoreAllMocks();
    });

    it('should initialise the Zulip clients exactly once, with both identities', async () => {
      await sut.init();

      expect(zulipMock.init).toHaveBeenCalledOnce();
      expect(zulipMock.init).toHaveBeenCalledWith({
        bot: { username: 'bot@example.com', apiKey: 'bot-key' },
        user: { username: 'human@example.com', apiKey: 'user-key' },
        realm: 'https://zulip.example.com',
      });
    });

    it('should skip initialisation when the bot key is the dev sentinel', async () => {
      config.zulip.bot.apiKey = 'dev';

      await sut.init();

      expect(zulipMock.init).not.toHaveBeenCalled();
      expect(zulipMock.getSubscriptions).not.toHaveBeenCalled();
    });

    it('should skip initialisation when the user key is the dev sentinel', async () => {
      config.zulip.user.apiKey = 'dev';

      await sut.init();

      expect(zulipMock.init).not.toHaveBeenCalled();
      expect(zulipMock.getSubscriptions).not.toHaveBeenCalled();
    });

    describe('subscription check', () => {
      it('should check the subscriptions after the clients exist and stay quiet when every required stream is there', async () => {
        await sut.init();

        expect(zulipMock.getSubscriptions).toHaveBeenCalledOnce();
        expect(zulipMock.init.mock.invocationCallOrder[0]).toBeLessThan(
          zulipMock.getSubscriptions.mock.invocationCallOrder[0],
        );
        expect(Logger.prototype.warn).not.toHaveBeenCalled();
        expect(Logger.prototype.error).not.toHaveBeenCalled();
      });

      it('should require exactly the three private notification streams, not FUTOStaff, where the holiday notice has always posted', () => {
        expect(Constants.Zulip.RequiredSubscriptions).toEqual([111, 112, 113]);
        expect(Constants.Zulip.RequiredSubscriptions).not.toContain(Constants.Zulip.Streams.FUTOStaff);
      });

      it('should warn, naming the stream, for each required stream the bot is not subscribed to', async () => {
        zulipMock.getSubscriptions.mockResolvedValue([subscriptions[0], { streamId: 54 }]);

        await expect(sut.init()).resolves.toBeUndefined();

        expect(Logger.prototype.warn).toHaveBeenCalledTimes(2);
        expect(Logger.prototype.warn).toHaveBeenCalledWith(
          'The Zulip bot is not subscribed to stream 112 (ImmichPullRequests): posts to it will fail until an admin subscribes it',
        );
        expect(Logger.prototype.warn).toHaveBeenCalledWith(
          'The Zulip bot is not subscribed to stream 113 (ImmichAlerts): posts to it will fail until an admin subscribes it',
        );
        expect(Logger.prototype.error).not.toHaveBeenCalled();
      });

      it('should warn for every required stream when the bot is subscribed to nothing', async () => {
        zulipMock.getSubscriptions.mockResolvedValue([]);

        await expect(sut.init()).resolves.toBeUndefined();

        expect(Logger.prototype.warn).toHaveBeenCalledTimes(3);
      });

      it('should log and carry on when the subscriptions cannot be read', async () => {
        zulipMock.getSubscriptions.mockRejectedValue(new Error('boom'));

        await expect(sut.init()).resolves.toBeUndefined();

        expect(zulipMock.init).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'Could not check the Zulip subscriptions of the bot',
          expect.any(Error),
        );
        expect(Logger.prototype.warn).not.toHaveBeenCalled();
      });
    });
  });

  describe('event loop', () => {
    type Poll = {
      queue: ZulipEventQueue;
      signal: AbortSignal;
      resolve: (events: ZulipEvent[]) => void;
      reject: (error: unknown) => void;
    };

    let polls: Poll[];
    let handler: Mock<(message: ZulipReceivedMessage) => Promise<void>>;
    let registered: number;

    const OWN_USER_ID = 7;
    const MIN_POLL_INTERVAL_MS = 1000;
    const HANDLER_TIMEOUT_MS = 30_000;
    const SHUTDOWN_GRACE_MS = 5000;
    const UNHEALTHY_STREAK = 10;
    const LISTENING_STREAMS = [Constants.Zulip.Streams.Immich, ...Object.values(Constants.Zulip.TeamStreams)];
    const badQueue = () => new ZulipApiError(400, 'BAD_EVENT_QUEUE_ID', 'Bad event queue ID: q1', 'GET /events');
    const outage = () => new ZulipApiError(502, 'UNKNOWN_ERROR', 'Bad Gateway', 'GET /events');
    const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const unhealthy = (deadQueues: number, instantEmptyPolls: number) =>
      `The Zulip event loop is not healthy: the server has not held a poll open for the last ${deadQueues + instantEmptyPolls} rounds (${deadQueues} dead queues re-registered, ${instantEmptyPolls} polls answered at once with nothing); it keeps trying, at most once a second, but receives nothing in the meantime`;

    const message = (overrides: Partial<ZulipReceivedMessage> = {}): ZulipReceivedMessage => ({
      id: 500,
      senderId: 12,
      senderEmail: 'alice@example.com',
      senderFullName: 'Alice',
      type: 'stream',
      streamId: 107,
      topic: 'thumbnails',
      content: 'see #4242',
      timestamp: 1_700_000_000,
      ...overrides,
    });
    const messageEvent = (id: number, overrides: Partial<ZulipReceivedMessage> = {}): ZulipEvent => ({
      id,
      type: 'message',
      message: message(overrides),
    });
    const heartbeat = (id: number): ZulipEvent => ({ id, type: 'heartbeat' });
    const update = (overrides: Partial<ZulipMessageUpdated> = {}): ZulipMessageUpdated => ({
      userId: 12,
      renderingOnly: false,
      messageId: 500,
      messageIds: [500],
      streamId: 107,
      content: 'see #4243',
      ...overrides,
    });
    const updateEvent = (id: number, overrides: Partial<ZulipMessageUpdated> = {}): ZulipEvent => ({
      id,
      type: 'update_message',
      update: update(overrides),
    });
    const deletion = (messageIds: number[]): ZulipMessagesDeleted => ({
      messageIds,
      streamId: 107,
      topic: 'thumbnails',
    });
    const deletionEvent = (id: number, messageIds: number[]): ZulipEvent => ({
      id,
      type: 'delete_message',
      deletion: deletion(messageIds),
    });

    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    const advance = async (ms: number) => {
      await vitest.advanceTimersByTimeAsync(ms);
      await flush();
    };
    const nextPoll = () => advance(MIN_POLL_INTERVAL_MS);

    beforeEach(async () => {
      vitest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      config.zulip.bot.apiKey = 'bot-key';
      config.zulip.user.apiKey = 'user-key';
      vitest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      vitest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

      polls = [];
      registered = 0;
      handler = vitest.fn();
      zulipMock.getSubscriptions.mockResolvedValue([{ streamId: 111 }, { streamId: 112 }, { streamId: 113 }]);
      zulipMock.getOwnUser.mockResolvedValue({ userId: OWN_USER_ID, fullName: 'Immich' });
      zulipMock.registerQueue.mockImplementation(async () => ({
        queue: { queueId: `q${++registered}`, lastEventId: -1 },
        subscribedStreamIds: LISTENING_STREAMS,
      }));
      zulipMock.deleteQueue.mockResolvedValue();
      zulipMock.getEvents.mockImplementation(
        (queue, signal) =>
          new Promise<ZulipEvent[]>((resolve, reject) => {
            polls.push({ queue: { ...queue }, signal, resolve, reject });
          }),
      );
      sut.onMessage(handler);
    });

    afterEach(async () => {
      const destroyed = sut.onModuleDestroy();
      await vitest.advanceTimersByTimeAsync(5000);
      await destroyed;
      vitest.restoreAllMocks();
      vitest.useRealTimers();
    });

    describe('start', () => {
      it('should know no own account before the loop has read it', () => {
        expect(sut.ownUser).toBeUndefined();
      });

      it('should not start in local dev, where the sentinel key skips the clients', async () => {
        config.zulip.bot.apiKey = 'dev';

        await sut.init();
        await flush();

        expect(zulipMock.getOwnUser).not.toHaveBeenCalled();
        expect(zulipMock.registerQueue).not.toHaveBeenCalled();
        expect(zulipMock.getEvents).not.toHaveBeenCalled();
      });

      it('should learn its own user, register a queue and start polling it from its initial cursor', async () => {
        await sut.init();
        await flush();

        expect(zulipMock.getOwnUser).toHaveBeenCalledOnce();
        expect(zulipMock.registerQueue).toHaveBeenCalledOnce();
        expect(polls).toHaveLength(1);
        expect(polls[0].queue).toEqual({ queueId: 'q1', lastEventId: -1 });
        expect(Logger.prototype.log).toHaveBeenCalledWith('Registered Zulip event queue q1');
      });

      it('should not block init on the long poll', async () => {
        await expect(sut.init()).resolves.toBeUndefined();
      });

      it('should back off when its own user cannot be read, and recover', async () => {
        zulipMock.getOwnUser.mockRejectedValueOnce(new TypeError('fetch failed'));

        await sut.init();
        await flush();
        expect(zulipMock.registerQueue).not.toHaveBeenCalled();
        expect(polls).toHaveLength(0);
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'The Zulip event loop failed, retrying in 1000ms',
          expect.any(TypeError),
        );

        await advance(1000);
        expect(zulipMock.getOwnUser).toHaveBeenCalledTimes(2);
        expect(zulipMock.registerQueue).toHaveBeenCalledOnce();
        expect(polls).toHaveLength(1);
      });

      it('should make shutdown a no-op before the loop started', async () => {
        await sut.onModuleDestroy();

        expect(zulipMock.deleteQueue).not.toHaveBeenCalled();
      });
    });

    describe('listening streams', () => {
      it('should listen in #Immich and every immich team stream', () => {
        expect(LISTENING_STREAMS).toEqual([54, 107, 108, 109, 110, 111, 112, 113]);
      });

      it('should stay quiet when the queue carries every listening stream', async () => {
        await sut.init();
        await flush();

        expect(Logger.prototype.warn).not.toHaveBeenCalled();
      });

      it('should warn, naming the stream, for each listening stream the queue cannot see, and poll all the same', async () => {
        zulipMock.registerQueue.mockResolvedValue({
          queue: { queueId: 'q1', lastEventId: -1 },
          subscribedStreamIds: LISTENING_STREAMS.filter((streamId) => streamId !== 109 && streamId !== 110),
        });

        await sut.init();
        await flush();

        expect(Logger.prototype.warn).toHaveBeenCalledTimes(2);
        expect(Logger.prototype.warn).toHaveBeenCalledWith(
          'The Zulip bot is not subscribed to stream 109 (ImmichMobile): its event queue carries no messages from it, so nothing is expanded there until an admin subscribes it',
        );
        expect(Logger.prototype.warn).toHaveBeenCalledWith(
          'The Zulip bot is not subscribed to stream 110 (ImmichFocusTopic): its event queue carries no messages from it, so nothing is expanded there until an admin subscribes it',
        );
        expect(Logger.prototype.error).not.toHaveBeenCalled();
        expect(polls).toHaveLength(1);
      });

      it('should check again at every registration, so a subscription added since is confirmed', async () => {
        zulipMock.registerQueue.mockResolvedValueOnce({
          queue: { queueId: 'q1', lastEventId: -1 },
          subscribedStreamIds: [],
        });

        await sut.init();
        await flush();
        expect(Logger.prototype.warn).toHaveBeenCalledTimes(LISTENING_STREAMS.length);

        polls[0].reject(badQueue());
        await nextPoll();

        expect(zulipMock.registerQueue).toHaveBeenCalledTimes(2);
        expect(Logger.prototype.warn).toHaveBeenCalledTimes(LISTENING_STREAMS.length);
        expect(polls).toHaveLength(2);
      });

      it('should check every stream the command router listens in too', async () => {
        const commands = Constants.Zulip.Commands;
        commands.push(998);
        try {
          await sut.init();
          await flush();
        } finally {
          commands.pop();
        }

        expect(Logger.prototype.warn).toHaveBeenCalledExactlyOnceWith(
          'The Zulip bot is not subscribed to stream 998: its event queue carries no messages from it, so nothing is expanded there until an admin subscribes it',
        );
      });

      it('should check every stream of every expander, not only the team streams, naming an unnamed one by its ID', async () => {
        const mirror = Constants.Zulip.Expanders.TwitterMirror;
        mirror.push(999);
        try {
          await sut.init();
          await flush();
        } finally {
          mirror.pop();
        }

        expect(Logger.prototype.warn).toHaveBeenCalledOnce();
        expect(Logger.prototype.warn).toHaveBeenCalledWith(
          'The Zulip bot is not subscribed to stream 999: its event queue carries no messages from it, so nothing is expanded there until an admin subscribes it',
        );
      });
    });

    describe('polling', () => {
      beforeEach(async () => {
        await sut.init();
        await flush();
      });

      it('should advance the cursor to the highest event ID received, heartbeats included, and poll again', async () => {
        polls[0].resolve([heartbeat(3), messageEvent(9), heartbeat(5)]);
        await nextPoll();

        expect(polls).toHaveLength(2);
        expect(polls[1].queue).toEqual({ queueId: 'q1', lastEventId: 9 });
        expect(zulipMock.registerQueue).toHaveBeenCalledOnce();
      });

      it('should hand every poll the loop signal, not yet aborted', () => {
        expect(polls[0].signal).toBeInstanceOf(AbortSignal);
        expect(polls[0].signal.aborted).toBe(false);
      });

      it('should never start a poll within a second of the previous one, however fast the server answered', async () => {
        polls[0].resolve([]);
        await flush();
        expect(polls).toHaveLength(1);

        await advance(999);
        expect(polls).toHaveLength(1);

        await advance(1);
        expect(polls).toHaveLength(2);
      });

      it('should make at most one poll a second against a server that answers every poll at once', async () => {
        zulipMock.getEvents.mockImplementation((queue, signal) => {
          polls.push({ queue: { ...queue }, signal, resolve: () => {}, reject: () => {} });
          return Promise.resolve([]);
        });
        polls[0].resolve([]);

        await advance(10_000);

        expect(zulipMock.getEvents.mock.calls.length).toBeGreaterThan(5);
        expect(zulipMock.getEvents.mock.calls.length).toBeLessThanOrEqual(12);
        expect(Logger.prototype.error).not.toHaveBeenCalled();
      });

      it('should never move the cursor backwards', async () => {
        polls[0].resolve([messageEvent(9)]);
        await nextPoll();
        polls[1].resolve([heartbeat(4)]);
        await nextPoll();

        expect(polls[2].queue.lastEventId).toBe(9);
      });

      it('should hand every message to every handler, in order, and nothing for a heartbeat', async () => {
        const second = vitest.fn<(message: ZulipReceivedMessage) => Promise<void>>();
        sut.onMessage(second);

        polls[0].resolve([heartbeat(3), messageEvent(9, { id: 500 }), messageEvent(10, { id: 501 })]);
        await flush();

        expect(handler).toHaveBeenCalledTimes(2);
        expect(handler).toHaveBeenNthCalledWith(1, message({ id: 500 }));
        expect(handler).toHaveBeenNthCalledWith(2, message({ id: 501 }));
        expect(second).toHaveBeenCalledTimes(2);
        expect(handler.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0]);
        expect(second.mock.invocationCallOrder[0]).toBeLessThan(handler.mock.invocationCallOrder[1]);
      });

      it("should expose the bot's own account to handlers, read before the first poll", () => {
        expect(sut.ownUser).toEqual({ userId: OWN_USER_ID, fullName: 'Immich' });
      });

      it('should ignore the messages the bot sent itself, but still acknowledge them', async () => {
        polls[0].resolve([messageEvent(9, { senderId: OWN_USER_ID }), messageEvent(10, { senderId: 12 })]);
        await nextPoll();

        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(message({ senderId: 12 }));
        expect(polls[1].queue.lastEventId).toBe(10);
      });

      it('should ignore the messages other bots sent, by their -bot@ address, but still acknowledge them', async () => {
        polls[0].resolve([
          messageEvent(9, { id: 500, senderId: 30, senderEmail: 'github-bot@chat.futo.org' }),
          messageEvent(10, { id: 501, senderId: 31, senderEmail: 'notification-bot@zulip.com' }),
          messageEvent(11, { id: 502, senderId: 12, senderEmail: 'alice@example.com' }),
          messageEvent(12, { id: 503, senderId: 13, senderEmail: 'user13@chat.futo.org' }),
          messageEvent(13, { id: 504, senderId: 14, senderEmail: '' }),
        ]);
        await nextPoll();

        expect(handler).toHaveBeenCalledTimes(3);
        expect(handler).toHaveBeenNthCalledWith(
          1,
          message({ id: 502, senderId: 12, senderEmail: 'alice@example.com' }),
        );
        expect(handler).toHaveBeenNthCalledWith(
          2,
          message({ id: 503, senderId: 13, senderEmail: 'user13@chat.futo.org' }),
        );
        expect(handler).toHaveBeenNthCalledWith(3, message({ id: 504, senderId: 14, senderEmail: '' }));
        expect(polls[1].queue.lastEventId).toBe(13);
      });

      it('should log a handler that throws and keep going, to the next handler and the next poll', async () => {
        const second = vitest.fn<(message: ZulipReceivedMessage) => Promise<void>>();
        sut.onMessage(second);
        handler.mockRejectedValueOnce(new Error('handler bug'));

        polls[0].resolve([messageEvent(9, { id: 500 })]);
        await nextPoll();

        expect(second).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'A Zulip message handler failed on message 500',
          expect.any(Error),
        );
        expect(polls).toHaveLength(2);

        polls[1].resolve([messageEvent(10, { id: 501 })]);
        await nextPoll();

        expect(handler).toHaveBeenCalledTimes(2);
        expect(polls).toHaveLength(3);
      });

      it('should log a handler that has not finished after thirty seconds and move on, to the next handler and the next poll', async () => {
        const second = vitest.fn<(message: ZulipReceivedMessage) => Promise<void>>();
        sut.onMessage(second);
        handler.mockReturnValueOnce(new Promise<void>(() => {}));

        polls[0].resolve([messageEvent(9, { id: 500 })]);
        await advance(HANDLER_TIMEOUT_MS - 1);

        expect(second).not.toHaveBeenCalled();
        expect(polls).toHaveLength(1);
        expect(Logger.prototype.error).not.toHaveBeenCalled();

        await advance(1);

        expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
          'A Zulip message handler has not finished message 500 after 30000ms; the loop is moving on without it',
        );
        expect(second).toHaveBeenCalledOnce();
        expect(polls).toHaveLength(2);
        expect(polls[1].queue.lastEventId).toBe(9);
      });

      it('should log a stalled handler that finishes late, and one that fails late, without waiting on either', async () => {
        let finish!: () => void;
        let fail!: (error: unknown) => void;
        handler.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
        handler.mockReturnValueOnce(new Promise<void>((_, reject) => (fail = reject)));

        polls[0].resolve([messageEvent(9, { id: 500 }), messageEvent(10, { id: 501 })]);
        await advance(2 * HANDLER_TIMEOUT_MS);

        expect(polls).toHaveLength(2);
        expect(Logger.prototype.error).toHaveBeenCalledTimes(2);
        expect(Logger.prototype.warn).not.toHaveBeenCalled();

        finish();
        fail(new Error('late bug'));
        await flush();

        expect(Logger.prototype.warn).toHaveBeenCalledExactlyOnceWith(
          'The Zulip message handler that stalled on message 500 finished after the loop had stopped waiting for it',
        );
        expect(Logger.prototype.error).toHaveBeenCalledTimes(3);
        expect(Logger.prototype.error).toHaveBeenLastCalledWith(
          'A Zulip message handler failed on message 501 after the loop had stopped waiting for it',
          expect.any(Error),
        );
        expect(polls).toHaveLength(2);
      });

      it('should not report a handler that finished in time, however long ago', async () => {
        polls[0].resolve([messageEvent(9, { id: 500 })]);
        await nextPoll();
        await advance(2 * HANDLER_TIMEOUT_MS);

        expect(handler).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).not.toHaveBeenCalled();
        expect(Logger.prototype.warn).not.toHaveBeenCalled();
      });

      it('should poll again after a long poll that timed out, without backing off or logging an error', async () => {
        polls[0].reject(timeout());
        await nextPoll();

        expect(polls).toHaveLength(2);
        expect(polls[1].queue).toEqual({ queueId: 'q1', lastEventId: -1 });
        expect(zulipMock.registerQueue).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).not.toHaveBeenCalled();
      });
    });

    describe('edits and deletions', () => {
      let onUpdate: Mock<(update: ZulipMessageUpdated) => Promise<void>>;
      let onDeletion: Mock<(deletion: ZulipMessagesDeleted) => Promise<void>>;

      beforeEach(async () => {
        onUpdate = vitest.fn();
        onDeletion = vitest.fn();
        sut.onMessageUpdate(onUpdate);
        sut.onMessagesDeleted(onDeletion);
        await sut.init();
        await flush();
      });

      it('should hand every update to every update handler, in order, and none to the message or deletion handlers', async () => {
        const second = vitest.fn<(update: ZulipMessageUpdated) => Promise<void>>();
        sut.onMessageUpdate(second);
        const move = { messageId: 501, messageIds: [499, 501], content: undefined, topic: 'renamed' };

        polls[0].resolve([updateEvent(9), updateEvent(10, move)]);
        await flush();

        expect(onUpdate).toHaveBeenCalledTimes(2);
        expect(onUpdate).toHaveBeenNthCalledWith(1, update());
        expect(onUpdate).toHaveBeenNthCalledWith(2, update(move));
        expect(second).toHaveBeenCalledTimes(2);
        expect(onUpdate.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0]);
        expect(second.mock.invocationCallOrder[0]).toBeLessThan(onUpdate.mock.invocationCallOrder[1]);
        expect(handler).not.toHaveBeenCalled();
        expect(onDeletion).not.toHaveBeenCalled();
      });

      it.each([
        { reason: 'a link preview', overrides: { userId: null, renderingOnly: true } },
        { reason: 'a rendering-only update that names a user', overrides: { renderingOnly: true } },
        { reason: 'an update without a user', overrides: { userId: null } },
        { reason: "the bot's own edit or move", overrides: { userId: OWN_USER_ID } },
      ])('should drop $reason, but still acknowledge it', async ({ overrides }) => {
        polls[0].resolve([updateEvent(9, overrides)]);
        await nextPoll();

        expect(onUpdate).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
        expect(polls[1].queue.lastEventId).toBe(9);
      });

      it('should hand every deletion to every deletion handler, bulk ones included, and none to the other handlers', async () => {
        const second = vitest.fn<(deletion: ZulipMessagesDeleted) => Promise<void>>();
        sut.onMessagesDeleted(second);

        polls[0].resolve([deletionEvent(9, [500]), deletionEvent(10, [501, 502])]);
        await flush();

        expect(onDeletion).toHaveBeenCalledTimes(2);
        expect(onDeletion).toHaveBeenNthCalledWith(1, deletion([500]));
        expect(onDeletion).toHaveBeenNthCalledWith(2, deletion([501, 502]));
        expect(second).toHaveBeenCalledTimes(2);
        expect(handler).not.toHaveBeenCalled();
        expect(onUpdate).not.toHaveBeenCalled();
      });

      it('should run messages, updates and deletions in the order they arrived', async () => {
        polls[0].resolve([messageEvent(9), updateEvent(10), deletionEvent(11, [500])]);
        await flush();

        expect(handler.mock.invocationCallOrder[0]).toBeLessThan(onUpdate.mock.invocationCallOrder[0]);
        expect(onUpdate.mock.invocationCallOrder[0]).toBeLessThan(onDeletion.mock.invocationCallOrder[0]);
      });

      it('should log an update or deletion handler that fails, naming what it was handling, and keep going', async () => {
        onUpdate.mockRejectedValueOnce(new Error('handler bug'));
        onDeletion.mockRejectedValueOnce(new Error('handler bug'));

        polls[0].resolve([updateEvent(9, { messageId: 500 }), deletionEvent(10, [501, 502])]);
        await nextPoll();

        expect(Logger.prototype.error).toHaveBeenCalledTimes(2);
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'A Zulip message handler failed on the update of message 500',
          expect.any(Error),
        );
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'A Zulip message handler failed on the deletion of messages 501, 502',
          expect.any(Error),
        );
        expect(polls).toHaveLength(2);
      });

      it('should stop waiting for an update or deletion handler after thirty seconds, like a message handler', async () => {
        onUpdate.mockReturnValueOnce(new Promise<void>(() => {}));
        onDeletion.mockReturnValueOnce(new Promise<void>(() => {}));

        polls[0].resolve([updateEvent(9, { messageId: 500 }), deletionEvent(10, [501])]);
        await advance(2 * HANDLER_TIMEOUT_MS);

        expect(Logger.prototype.error).toHaveBeenCalledTimes(2);
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'A Zulip message handler has not finished the update of message 500 after 30000ms; the loop is moving on without it',
        );
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'A Zulip message handler has not finished the deletion of messages 501 after 30000ms; the loop is moving on without it',
        );
        expect(polls).toHaveLength(2);
      });
    });

    describe('registration handlers', () => {
      it('should tell every handler the streams the queue carries, after its own warnings and before the first poll', async () => {
        const first = vitest.fn();
        const second = vitest.fn();
        sut.onQueueRegistered(first);
        sut.onQueueRegistered(second);
        zulipMock.registerQueue.mockResolvedValueOnce({
          queue: { queueId: 'q1', lastEventId: -1 },
          subscribedStreamIds: [54],
        });

        await sut.init();
        await flush();

        expect(first).toHaveBeenCalledExactlyOnceWith({ subscribedStreamIds: [54] });
        expect(second).toHaveBeenCalledExactlyOnceWith({ subscribedStreamIds: [54] });
        const warnings = vitest.mocked(Logger.prototype.warn).mock.invocationCallOrder;
        expect(warnings).toHaveLength(LISTENING_STREAMS.length - 1);
        expect(warnings.at(-1)).toBeLessThan(first.mock.invocationCallOrder[0]);
        expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0]);
        expect(second.mock.invocationCallOrder[0]).toBeLessThan(zulipMock.getEvents.mock.invocationCallOrder[0]);
      });

      it('should tell them again at every registration, a dead queue included', async () => {
        const onRegistered = vitest.fn();
        sut.onQueueRegistered(onRegistered);

        await sut.init();
        await flush();
        polls[0].reject(badQueue());
        await nextPoll();

        expect(zulipMock.registerQueue).toHaveBeenCalledTimes(2);
        expect(onRegistered).toHaveBeenCalledTimes(2);
        expect(onRegistered).toHaveBeenLastCalledWith({ subscribedStreamIds: LISTENING_STREAMS });
        expect(polls).toHaveLength(2);
      });

      it('should log a handler that throws and carry on, to the next handler and the first poll', async () => {
        const next = vitest.fn();
        sut.onQueueRegistered(() => {
          throw new Error('handler bug');
        });
        sut.onQueueRegistered(next);

        await sut.init();
        await flush();

        expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
          'A Zulip queue registration handler failed on queue q1',
          expect.any(Error),
        );
        expect(next).toHaveBeenCalledOnce();
        expect(polls).toHaveLength(1);
      });
    });

    describe('a dead queue', () => {
      beforeEach(async () => {
        await sut.init();
        await flush();
      });

      it('should register a new queue at once and never poll the dead one again', async () => {
        polls[0].resolve([messageEvent(9)]);
        await nextPoll();
        polls[1].reject(badQueue());
        await flush();

        expect(zulipMock.registerQueue).toHaveBeenCalledTimes(2);
        expect(polls).toHaveLength(2);

        await nextPoll();
        expect(polls).toHaveLength(3);
        expect(polls[2].queue).toEqual({ queueId: 'q2', lastEventId: -1 });
        expect(polls.filter(({ queue }) => queue.queueId === 'q1')).toHaveLength(2);
        expect(Logger.prototype.log).toHaveBeenCalledWith(
          'The Zulip event queue is gone (garbage-collected or the server restarted), registering a new one',
        );
        expect(Logger.prototype.error).not.toHaveBeenCalled();
        expect(zulipMock.deleteQueue).not.toHaveBeenCalled();
      });

      it('should keep working on the new queue', async () => {
        polls[0].reject(badQueue());
        await nextPoll();
        polls[1].resolve([messageEvent(9)]);
        await nextPoll();

        expect(handler).toHaveBeenCalledOnce();
        expect(polls[2].queue).toEqual({ queueId: 'q2', lastEventId: 9 });
      });

      it('should register at most once every two seconds when every queue dies after one poll', async () => {
        zulipMock.getEvents.mockImplementation((queue, signal) => {
          polls.push({ queue: { ...queue }, signal, resolve: () => {}, reject: () => {} });
          return queue.lastEventId === -1 ? Promise.resolve([messageEvent(1)]) : Promise.reject(badQueue());
        });
        polls[0].resolve([messageEvent(1)]);

        await advance(10_000);

        expect(zulipMock.registerQueue.mock.calls.length).toBeGreaterThan(2);
        expect(zulipMock.registerQueue.mock.calls.length).toBeLessThanOrEqual(7);
        expect(zulipMock.getEvents.mock.calls.length).toBeLessThanOrEqual(12);
      });

      it('should back off when every fresh queue is reported dead too, instead of registering in a tight loop', async () => {
        zulipMock.getEvents.mockImplementation((queue, signal) => {
          polls.push({ queue: { ...queue }, signal, resolve: () => {}, reject: () => {} });
          return Promise.reject(badQueue());
        });
        polls[0].reject(badQueue());

        await advance(10 * 60 * 1000);

        expect(zulipMock.registerQueue.mock.calls.length).toBeGreaterThan(2);
        expect(zulipMock.registerQueue.mock.calls.length).toBeLessThanOrEqual(17);
        expect(zulipMock.getEvents.mock.calls.length).toBeLessThanOrEqual(17);
      });
    });

    describe('health', () => {
      beforeEach(async () => {
        await sut.init();
        await flush();
      });

      const answerAtOnce = () => {
        zulipMock.getEvents.mockImplementation((queue, signal) => {
          polls.push({ queue: { ...queue }, signal, resolve: () => {}, reject: () => {} });
          return Promise.resolve([]);
        });
        polls[0].resolve([]);
      };

      it('should warn after ten polls in a row answered at once with nothing, and again every ten', async () => {
        answerAtOnce();

        await advance(UNHEALTHY_STREAK * MIN_POLL_INTERVAL_MS);

        expect(Logger.prototype.warn).toHaveBeenCalledOnce();
        expect(Logger.prototype.warn).toHaveBeenCalledWith(unhealthy(0, 10));

        await advance(UNHEALTHY_STREAK * MIN_POLL_INTERVAL_MS);

        expect(Logger.prototype.warn).toHaveBeenCalledTimes(2);
        expect(Logger.prototype.warn).toHaveBeenLastCalledWith(unhealthy(0, 20));
        expect(Logger.prototype.error).not.toHaveBeenCalled();
      });

      it('should warn after ten queues in a row reported dead, however many events the fresh ones carried', async () => {
        zulipMock.getEvents.mockImplementation((queue, signal) => {
          polls.push({ queue: { ...queue }, signal, resolve: () => {}, reject: () => {} });
          return queue.lastEventId === -1 ? Promise.resolve([messageEvent(1)]) : Promise.reject(badQueue());
        });
        polls[0].resolve([messageEvent(1)]);

        await advance(2 * UNHEALTHY_STREAK * MIN_POLL_INTERVAL_MS);

        expect(zulipMock.registerQueue).toHaveBeenCalledTimes(11);
        expect(Logger.prototype.warn).toHaveBeenCalledOnce();
        expect(Logger.prototype.warn).toHaveBeenCalledWith(unhealthy(10, 0));

        await advance(2 * UNHEALTHY_STREAK * MIN_POLL_INTERVAL_MS);

        expect(Logger.prototype.warn).toHaveBeenCalledTimes(2);
        expect(Logger.prototype.warn).toHaveBeenLastCalledWith(unhealthy(20, 0));
      });

      it('should count a dead queue and an instant empty poll together', async () => {
        for (let round = 0; round < 5; round++) {
          polls.at(-1)!.reject(badQueue());
          await nextPoll();
          polls.at(-1)!.resolve([]);
          await nextPoll();
        }

        expect(Logger.prototype.warn).toHaveBeenCalledOnce();
        expect(Logger.prototype.warn).toHaveBeenCalledWith(unhealthy(5, 5));
      });

      it('should never warn while the server holds every poll open, as a healthy one does', async () => {
        for (let poll = 0; poll < 2 * UNHEALTHY_STREAK; poll++) {
          await advance(90_000);
          polls[poll].resolve([heartbeat(poll + 1)]);
          await flush();
        }

        expect(polls).toHaveLength(2 * UNHEALTHY_STREAK + 1);
        expect(Logger.prototype.warn).not.toHaveBeenCalled();
      });

      it('should not count a poll answered at once with events: a busy queue is not an unhealthy one', async () => {
        for (let poll = 0; poll < 2 * UNHEALTHY_STREAK; poll++) {
          polls[poll].resolve([messageEvent(poll + 1)]);
          await nextPoll();
        }

        expect(handler).toHaveBeenCalledTimes(2 * UNHEALTHY_STREAK);
        expect(Logger.prototype.warn).not.toHaveBeenCalled();
      });

      it('should not warn for the one dead queue a server restart costs', async () => {
        polls[0].reject(badQueue());
        await nextPoll();
        await advance(90_000);
        polls[1].resolve([heartbeat(1)]);
        await flush();

        expect(Logger.prototype.warn).not.toHaveBeenCalled();
      });

      it('should count again from a poll the server held open', async () => {
        for (let poll = 0; poll < UNHEALTHY_STREAK; poll++) {
          polls[poll].resolve([]);
          await nextPoll();
        }
        expect(Logger.prototype.warn).toHaveBeenCalledOnce();

        await advance(90_000);
        polls[UNHEALTHY_STREAK].resolve([heartbeat(1)]);
        await flush();
        for (let poll = 1; poll < UNHEALTHY_STREAK; poll++) {
          polls[UNHEALTHY_STREAK + poll].resolve([]);
          await nextPoll();
        }
        expect(Logger.prototype.warn).toHaveBeenCalledOnce();

        polls[2 * UNHEALTHY_STREAK].resolve([]);
        await nextPoll();
        expect(Logger.prototype.warn).toHaveBeenCalledTimes(2);
        expect(Logger.prototype.warn).toHaveBeenLastCalledWith(unhealthy(0, 10));
      });
    });

    describe('other errors', () => {
      beforeEach(async () => {
        await sut.init();
        await flush();
      });

      it('should log the error and retry after a second', async () => {
        polls[0].reject(outage());
        await flush();

        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'The Zulip event loop failed, retrying in 1000ms',
          expect.any(ZulipApiError),
        );
        expect(polls).toHaveLength(1);

        await advance(999);
        expect(polls).toHaveLength(1);

        await advance(1);
        expect(polls).toHaveLength(2);
        expect(polls[1].queue).toEqual({ queueId: 'q1', lastEventId: -1 });
        expect(zulipMock.registerQueue).toHaveBeenCalledOnce();
      });

      it('should double the pause on every consecutive failure and reset it on a successful poll', async () => {
        polls[0].reject(outage());
        await advance(1000);
        expect(polls).toHaveLength(2);

        polls[1].reject(outage());
        await advance(1999);
        expect(polls).toHaveLength(2);
        await advance(1);
        expect(polls).toHaveLength(3);

        polls[2].reject(outage());
        await advance(3999);
        expect(polls).toHaveLength(3);
        await advance(1);
        expect(polls).toHaveLength(4);

        polls[3].resolve([heartbeat(1)]);
        await nextPoll();
        expect(polls).toHaveLength(5);

        polls[4].reject(outage());
        await advance(1000);
        expect(polls).toHaveLength(6);
      });

      it('should cap the pause at a minute', async () => {
        polls[0].reject(outage());
        await advance(1000);
        for (const [index, pause] of [2000, 4000, 8000, 16_000, 32_000].entries()) {
          polls[index + 1].reject(outage());
          await advance(pause);
        }
        expect(polls).toHaveLength(7);

        polls[6].reject(outage());
        await advance(59_999);
        expect(polls).toHaveLength(7);
        await advance(1);
        expect(polls).toHaveLength(8);
        expect(Logger.prototype.error).toHaveBeenLastCalledWith(
          'The Zulip event loop failed, retrying in 60000ms',
          expect.any(ZulipApiError),
        );
      });

      it('should make only a handful of requests during a ten-minute outage, never one per second', async () => {
        zulipMock.getEvents.mockImplementation((queue, signal) => {
          polls.push({ queue: { ...queue }, signal, resolve: () => {}, reject: () => {} });
          return Promise.reject(outage());
        });
        polls[0].reject(outage());

        await advance(10 * 60 * 1000);

        expect(zulipMock.getEvents.mock.calls.length).toBeGreaterThan(5);
        expect(zulipMock.getEvents.mock.calls.length).toBeLessThanOrEqual(16);
        expect(zulipMock.registerQueue).toHaveBeenCalledOnce();
      });

      it('should back off when the queue cannot be registered, and recover', async () => {
        polls[0].reject(badQueue());
        zulipMock.registerQueue.mockRejectedValueOnce(new TypeError('fetch failed'));
        await flush();

        expect(zulipMock.registerQueue).toHaveBeenCalledTimes(2);
        expect(polls).toHaveLength(1);
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'The Zulip event loop failed, retrying in 2000ms',
          expect.any(TypeError),
        );

        await advance(2000);
        expect(zulipMock.registerQueue).toHaveBeenCalledTimes(3);
        expect(polls).toHaveLength(2);
        expect(polls[1].queue).toEqual({ queueId: 'q2', lastEventId: -1 });
      });
    });

    describe('shutdown', () => {
      beforeEach(async () => {
        await sut.init();
        await flush();
      });

      it('should cancel the poll in flight and stop without the server ending it', async () => {
        zulipMock.getEvents.mockImplementation(
          (queue, signal) =>
            new Promise<ZulipEvent[]>((resolve, reject) => {
              polls.push({ queue: { ...queue }, signal, resolve, reject });
              signal.addEventListener('abort', () => reject(signal.reason));
            }),
        );
        polls[0].resolve([]);
        await nextPoll();
        expect(polls).toHaveLength(2);

        await sut.onModuleDestroy();

        expect(polls[1].signal.aborted).toBe(true);
        expect(polls).toHaveLength(2);
        expect(zulipMock.deleteQueue).toHaveBeenCalledOnce();
        expect(zulipMock.deleteQueue).toHaveBeenCalledWith('q1');
        expect(zulipMock.registerQueue).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).not.toHaveBeenCalled();
      });

      it('should delete the queue and stop polling once a poll that ignored the abort returns', async () => {
        const destroyed = sut.onModuleDestroy();
        await flush();

        expect(polls[0].signal.aborted).toBe(true);
        expect(zulipMock.deleteQueue).toHaveBeenCalledOnce();
        expect(zulipMock.deleteQueue).toHaveBeenCalledWith('q1');

        polls[0].resolve([messageEvent(9)]);
        await destroyed;
        await flush();

        expect(polls).toHaveLength(1);
        expect(handler).not.toHaveBeenCalled();
        expect(zulipMock.registerQueue).toHaveBeenCalledOnce();
        expect(zulipMock.deleteQueue).toHaveBeenCalledOnce();
      });

      it('should stop when the poll in flight answers with the deleted queue', async () => {
        const destroyed = sut.onModuleDestroy();
        await flush();
        polls[0].reject(badQueue());
        await destroyed;
        await flush();

        expect(polls).toHaveLength(1);
        expect(zulipMock.registerQueue).toHaveBeenCalledOnce();
      });

      it('should stop at once during a backoff pause', async () => {
        polls[0].reject(outage());
        await flush();

        await sut.onModuleDestroy();
        await advance(60_000);

        expect(zulipMock.deleteQueue).toHaveBeenCalledWith('q1');
        expect(polls).toHaveLength(1);
      });

      it('should not wait for a poll that ignores the abort and is never answered', async () => {
        const destroyed = sut.onModuleDestroy();
        await advance(SHUTDOWN_GRACE_MS);

        await expect(destroyed).resolves.toBeUndefined();
      });

      it('should wait for a registration in flight, past the grace, and delete the queue it registers', async () => {
        let register: (registration: ZulipQueueRegistration) => void = () => {};
        zulipMock.registerQueue.mockImplementationOnce(
          () => new Promise<ZulipQueueRegistration>((resolve) => (register = resolve)),
        );
        polls[0].reject(badQueue());
        await flush();
        expect(zulipMock.registerQueue).toHaveBeenCalledTimes(2);

        const destroyed = sut.onModuleDestroy();
        let settled = false;
        void destroyed.then(() => (settled = true));
        await advance(SHUTDOWN_GRACE_MS);

        expect(settled).toBe(false);
        expect(zulipMock.deleteQueue).not.toHaveBeenCalled();

        register({ queue: { queueId: 'q2', lastEventId: -1 }, subscribedStreamIds: LISTENING_STREAMS });
        await destroyed;

        expect(zulipMock.deleteQueue).toHaveBeenCalledOnce();
        expect(zulipMock.deleteQueue).toHaveBeenCalledWith('q2');
        expect(polls).toHaveLength(1);
        expect(Logger.prototype.error).not.toHaveBeenCalled();
      });

      it('should stop without deleting anything when the registration in flight fails', async () => {
        let fail: (error: unknown) => void = () => {};
        zulipMock.registerQueue.mockImplementationOnce(
          () => new Promise<ZulipQueueRegistration>((_, reject) => (fail = reject)),
        );
        polls[0].reject(badQueue());
        await flush();

        const destroyed = sut.onModuleDestroy();
        await flush();
        fail(new TypeError('fetch failed'));
        await destroyed;

        expect(zulipMock.deleteQueue).not.toHaveBeenCalled();
        expect(zulipMock.registerQueue).toHaveBeenCalledTimes(2);
        expect(polls).toHaveLength(1);
        expect(Logger.prototype.error).not.toHaveBeenCalled();
      });

      it('should stop at once during the poll floor, without polling again', async () => {
        polls[0].resolve([]);
        await flush();

        await sut.onModuleDestroy();
        await advance(MIN_POLL_INTERVAL_MS);

        expect(zulipMock.deleteQueue).toHaveBeenCalledWith('q1');
        expect(polls).toHaveLength(1);
      });

      it('should log and still stop when the queue cannot be deleted', async () => {
        zulipMock.deleteQueue.mockRejectedValue(new TypeError('fetch failed'));

        const destroyed = sut.onModuleDestroy();
        await flush();
        polls[0].resolve([]);
        await destroyed;

        expect(Logger.prototype.warn).toHaveBeenCalledWith(
          'Could not delete Zulip event queue q1; the server will garbage-collect it',
          expect.any(TypeError),
        );
        expect(polls).toHaveLength(1);
      });

      it('should be a no-op the second time', async () => {
        const destroyed = sut.onModuleDestroy();
        await flush();
        polls[0].resolve([]);
        await destroyed;

        await sut.onModuleDestroy();

        expect(zulipMock.deleteQueue).toHaveBeenCalledOnce();
      });
    });
  });
});
