import { Logger } from '@nestjs/common';
import { DateTime, Settings } from 'luxon';
import { Constants } from 'src/constants';
import { HolidayDto, IHolidaysInterface } from 'src/interfaces/holidays.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';
import { ZulipService } from 'src/services/zulip.service';
import { Mocked, afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

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
  createEmote: vitest.fn(),
  getMessage: vitest.fn(),
  updateMessage: vitest.fn(),
  listEmoji: vitest.fn(),
  getSubscriptions: vitest.fn(),
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
      vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
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
});
