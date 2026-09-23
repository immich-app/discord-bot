import { DateTime, Settings } from 'luxon';
import { Constants } from 'src/constants';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { IOutlineInterface } from 'src/interfaces/outline.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';
import { NotificationService } from 'src/services/notification.service';
import { ScheduleService } from 'src/services/schedule.service';
import { Mocked, afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

const newDatabaseMock = (): Mocked<Pick<IDatabaseRepository, 'getTotalLicenseCount' | 'getTotalFourthwallOrders'>> => ({
  getTotalLicenseCount: vitest.fn().mockResolvedValue({ server: 12, client: 345 }),
  getTotalFourthwallOrders: vitest.fn().mockResolvedValue({ revenue: 1234.5, profit: 678.25 }),
});

const newDiscordMock = (): Mocked<IDiscordInterface> => ({
  login: vitest.fn(),
  sendMessage: vitest.fn(),
  createEmote: vitest.fn(),
  getEmotes: vitest.fn(),
  setThreadArchived: vitest.fn(),
  createThread: vitest.fn(),
  updateThread: vitest.fn(),
});

const newOutlineMock = (): Mocked<IOutlineInterface> => ({
  addToDocument: vitest.fn(),
  createDocument: vitest.fn(),
  shareDocument: vitest.fn(),
  searchDocuments: vitest.fn(),
});

const newMattermostMock = (): Mocked<IMattermostInterface> => ({
  createEmote: vitest.fn(),
  init: vitest.fn(),
  joinChannel: vitest.fn(),
  registerCommand: vitest.fn() as any,
  registerEventListener: vitest.fn() as any,
  reply: vitest.fn(),
  runCommand: vitest.fn(),
  send: vitest.fn(),
  streamChannels: vitest.fn(),
  updatePost: vitest.fn(),
  openDialog: vitest.fn(),
  submitDialog: vitest.fn(),
});

const newZulipMock = (): Mocked<IZulipInterface> => ({
  init: vitest.fn(),
  isInitialised: vitest.fn().mockReturnValue(false),
  sendMessage: vitest.fn(),
  createEmote: vitest.fn(),
});

/** Freeze luxon's clock at the given UTC instant. */
const setNow = (iso: string) => {
  const millis = DateTime.fromISO(iso, { zone: 'utc' }).toMillis();
  Settings.now = () => millis;
};

describe('ScheduleService', () => {
  let sut: ScheduleService;
  let databaseMock: ReturnType<typeof newDatabaseMock>;
  let discordMock: Mocked<IDiscordInterface>;
  let outlineMock: Mocked<IOutlineInterface>;
  let mattermostMock: Mocked<IMattermostInterface>;

  const originalNow = Settings.now;
  const originalZone = Settings.defaultZone;
  const originalLocale = Settings.defaultLocale;

  beforeEach(() => {
    // The reports embed locale- and zone-formatted dates, so pin both for deterministic snapshots.
    Settings.defaultZone = 'utc';
    Settings.defaultLocale = 'en-US';

    databaseMock = newDatabaseMock();
    discordMock = newDiscordMock();
    outlineMock = newOutlineMock();
    mattermostMock = newMattermostMock();
    sut = new ScheduleService(
      databaseMock as unknown as IDatabaseRepository,
      discordMock,
      outlineMock,
      new NotificationService(discordMock, mattermostMock, newZulipMock()),
    );
  });

  afterEach(() => {
    Settings.now = originalNow;
    Settings.defaultZone = originalZone;
    Settings.defaultLocale = originalLocale;
  });

  describe('onDailyReport', () => {
    beforeEach(() => setNow('2026-09-22T12:00:00.000Z'));

    it("should query yesterday's totals by day", async () => {
      await sut.onDailyReport();

      expect(databaseMock.getTotalLicenseCount).toHaveBeenCalledOnce();
      expect(databaseMock.getTotalLicenseCount).toHaveBeenCalledWith({ day: expect.any(DateTime) });
      expect(databaseMock.getTotalLicenseCount.mock.calls[0][0]?.day?.toISO()).toBe('2026-09-21T23:59:59.999Z');

      expect(databaseMock.getTotalFourthwallOrders).toHaveBeenCalledOnce();
      expect(databaseMock.getTotalFourthwallOrders).toHaveBeenCalledWith({ day: expect.any(DateTime) });
      expect(databaseMock.getTotalFourthwallOrders.mock.calls[0][0]?.day?.toISO()).toBe('2026-09-21T23:59:59.999Z');
    });

    it('should post a licenses report followed by an orders report to the purchases channel', async () => {
      await sut.onDailyReport();

      expect(mattermostMock.send).toHaveBeenCalledTimes(2);
      expect(discordMock.sendMessage).not.toHaveBeenCalled();

      const [[licenses], [orders]] = mattermostMock.send.mock.calls;
      expect(licenses.channelId).toBe(Constants.Mattermost.Channels.Purchases);
      expect(orders.channelId).toBe(Constants.Mattermost.Channels.Purchases);
      expect(licenses).not.toHaveProperty('silent');
      expect(orders).not.toHaveProperty('silent');

      expect(licenses).toMatchInlineSnapshot(`
        {
          "channelId": "ijh1ciffcp8fdyy4y5snxnornr",
          "message": "",
          "props": {
            "mm_blocks": [
              {
                "accent_color": "#9b59b6",
                "border": true,
                "content": [
                  {
                    "text": "Daily product keys report for September 21, 2026",
                    "type": "text",
                  },
                  {
                    "text": "Total: $9,825",
                    "type": "text",
                  },
                  {
                    "type": "divider",
                  },
                  {
                    "columns": [
                      {
                        "gap": "small",
                        "items": [
                          {
                            "text": "**Server keys**",
                            "type": "text",
                          },
                          {
                            "text": "$1,200 - 12 keys",
                            "type": "text",
                          },
                        ],
                        "type": "column",
                      },
                      {
                        "gap": "small",
                        "items": [
                          {
                            "text": "**Client keys**",
                            "type": "text",
                          },
                          {
                            "text": "$8,625 - 345 keys",
                            "type": "text",
                          },
                        ],
                        "type": "column",
                      },
                    ],
                    "type": "column_set",
                  },
                ],
                "gap": "small",
                "type": "container",
              },
            ],
          },
        }
      `);
      expect(orders).toMatchInlineSnapshot(`
        {
          "channelId": "ijh1ciffcp8fdyy4y5snxnornr",
          "message": "",
          "props": {
            "mm_blocks": [
              {
                "accent_color": "#71368a",
                "border": true,
                "content": [
                  {
                    "text": "Daily orders report for September 21, 2026",
                    "type": "text",
                  },
                  {
                    "text": "Revenue: 1,234.5 USD; Profit: 678.25 USD",
                    "type": "text",
                  },
                  {
                    "type": "divider",
                  },
                  {
                    "columns": [
                      {
                        "gap": "small",
                        "items": [
                          {
                            "text": "**Revenue**",
                            "type": "text",
                          },
                          {
                            "text": "1,234.5 USD",
                            "type": "text",
                          },
                        ],
                        "type": "column",
                      },
                      {
                        "gap": "small",
                        "items": [
                          {
                            "text": "**Profit**",
                            "type": "text",
                          },
                          {
                            "text": "678.25 USD",
                            "type": "text",
                          },
                        ],
                        "type": "column",
                      },
                    ],
                    "type": "column_set",
                  },
                ],
                "gap": "small",
                "type": "container",
              },
            ],
          },
        }
      `);
    });

    it('should format the report date across a month boundary', async () => {
      setNow('2026-10-01T12:00:00.000Z');

      await sut.onDailyReport();

      const [[licenses], [orders]] = mattermostMock.send.mock.calls;
      expect((licenses.props as any).mm_blocks[0].content[0].text).toBe(
        'Daily product keys report for September 30, 2026',
      );
      expect((orders.props as any).mm_blocks[0].content[0].text).toBe('Daily orders report for September 30, 2026');
    });
  });

  describe('onWeeklyReport', () => {
    beforeEach(() => setNow('2026-09-24T12:00:00.000Z'));

    it("should query the week ending yesterday's totals", async () => {
      await sut.onWeeklyReport();

      expect(databaseMock.getTotalLicenseCount).toHaveBeenCalledOnce();
      expect(databaseMock.getTotalLicenseCount).toHaveBeenCalledWith({ week: expect.any(DateTime) });
      expect(databaseMock.getTotalLicenseCount.mock.calls[0][0]?.week?.toISO()).toBe('2026-09-23T23:59:59.999Z');

      expect(databaseMock.getTotalFourthwallOrders).toHaveBeenCalledOnce();
      expect(databaseMock.getTotalFourthwallOrders).toHaveBeenCalledWith({ week: expect.any(DateTime) });
      expect(databaseMock.getTotalFourthwallOrders.mock.calls[0][0]?.week?.toISO()).toBe('2026-09-23T23:59:59.999Z');
    });

    it('should post a licenses report followed by an orders report to the purchases channel', async () => {
      await sut.onWeeklyReport();

      expect(mattermostMock.send).toHaveBeenCalledTimes(2);
      expect(discordMock.sendMessage).not.toHaveBeenCalled();

      const [[licenses], [orders]] = mattermostMock.send.mock.calls;
      expect(licenses.channelId).toBe(Constants.Mattermost.Channels.Purchases);
      expect(orders.channelId).toBe(Constants.Mattermost.Channels.Purchases);
      expect(licenses).not.toHaveProperty('silent');
      expect(orders).not.toHaveProperty('silent');

      expect(licenses).toMatchInlineSnapshot(`
        {
          "channelId": "ijh1ciffcp8fdyy4y5snxnornr",
          "message": "",
          "props": {
            "mm_blocks": [
              {
                "accent_color": "#9b59b6",
                "border": true,
                "content": [
                  {
                    "text": "Weekly licenses report for September 16 - September 23",
                    "type": "text",
                  },
                  {
                    "text": "Total: $9,825",
                    "type": "text",
                  },
                  {
                    "type": "divider",
                  },
                  {
                    "columns": [
                      {
                        "gap": "small",
                        "items": [
                          {
                            "text": "**Server keys**",
                            "type": "text",
                          },
                          {
                            "text": "$1,200 - 12 keys",
                            "type": "text",
                          },
                        ],
                        "type": "column",
                      },
                      {
                        "gap": "small",
                        "items": [
                          {
                            "text": "**Client keys**",
                            "type": "text",
                          },
                          {
                            "text": "$8,625 - 345 keys",
                            "type": "text",
                          },
                        ],
                        "type": "column",
                      },
                    ],
                    "type": "column_set",
                  },
                ],
                "gap": "small",
                "type": "container",
              },
            ],
          },
        }
      `);
      expect(orders).toMatchInlineSnapshot(`
        {
          "channelId": "ijh1ciffcp8fdyy4y5snxnornr",
          "message": "",
          "props": {
            "mm_blocks": [
              {
                "accent_color": "#71368a",
                "border": true,
                "content": [
                  {
                    "text": "Weekly orders report for September 16 - September 23",
                    "type": "text",
                  },
                  {
                    "text": "Revenue: 1,234.5 USD; Profit: 678.25 USD",
                    "type": "text",
                  },
                  {
                    "type": "divider",
                  },
                  {
                    "columns": [
                      {
                        "gap": "small",
                        "items": [
                          {
                            "text": "**Revenue**",
                            "type": "text",
                          },
                          {
                            "text": "1,234.5 USD",
                            "type": "text",
                          },
                        ],
                        "type": "column",
                      },
                      {
                        "gap": "small",
                        "items": [
                          {
                            "text": "**Profit**",
                            "type": "text",
                          },
                          {
                            "text": "678.25 USD",
                            "type": "text",
                          },
                        ],
                        "type": "column",
                      },
                    ],
                    "type": "column_set",
                  },
                ],
                "gap": "small",
                "type": "container",
              },
            ],
          },
        }
      `);
    });

    it('should format the report range across a month boundary', async () => {
      setNow('2026-10-01T12:00:00.000Z');

      await sut.onWeeklyReport();

      const [[licenses], [orders]] = mattermostMock.send.mock.calls;
      expect((licenses.props as any).mm_blocks[0].content[0].text).toBe(
        'Weekly licenses report for September 23 - September 30',
      );
      expect((orders.props as any).mm_blocks[0].content[0].text).toBe(
        'Weekly orders report for September 23 - September 30',
      );
    });
  });

  describe('onMonthlyReport', () => {
    beforeEach(() => setNow('2026-09-19T12:00:00.000Z'));

    it("should query the month ending yesterday's totals", async () => {
      await sut.onMonthlyReport();

      expect(databaseMock.getTotalLicenseCount).toHaveBeenCalledOnce();
      expect(databaseMock.getTotalLicenseCount).toHaveBeenCalledWith({ month: expect.any(DateTime) });
      expect(databaseMock.getTotalLicenseCount.mock.calls[0][0]?.month?.toISO()).toBe('2026-09-18T23:59:59.999Z');

      expect(databaseMock.getTotalFourthwallOrders).toHaveBeenCalledOnce();
      expect(databaseMock.getTotalFourthwallOrders).toHaveBeenCalledWith({ month: expect.any(DateTime) });
      expect(databaseMock.getTotalFourthwallOrders.mock.calls[0][0]?.month?.toISO()).toBe('2026-09-18T23:59:59.999Z');
    });

    it('should post a licenses report followed by an orders report to the purchases channel', async () => {
      await sut.onMonthlyReport();

      expect(mattermostMock.send).toHaveBeenCalledTimes(2);
      expect(discordMock.sendMessage).not.toHaveBeenCalled();

      const [[licenses], [orders]] = mattermostMock.send.mock.calls;
      expect(licenses.channelId).toBe(Constants.Mattermost.Channels.Purchases);
      expect(orders.channelId).toBe(Constants.Mattermost.Channels.Purchases);
      expect(licenses).not.toHaveProperty('silent');
      expect(orders).not.toHaveProperty('silent');

      expect(licenses).toMatchInlineSnapshot(`
        {
          "channelId": "ijh1ciffcp8fdyy4y5snxnornr",
          "message": "",
          "props": {
            "mm_blocks": [
              {
                "accent_color": "#9b59b6",
                "border": true,
                "content": [
                  {
                    "text": "Monthly licenses report for August 18 - September 18",
                    "type": "text",
                  },
                  {
                    "text": "Total: $9,825",
                    "type": "text",
                  },
                  {
                    "type": "divider",
                  },
                  {
                    "columns": [
                      {
                        "gap": "small",
                        "items": [
                          {
                            "text": "**Server keys**",
                            "type": "text",
                          },
                          {
                            "text": "$1,200 - 12 keys",
                            "type": "text",
                          },
                        ],
                        "type": "column",
                      },
                      {
                        "gap": "small",
                        "items": [
                          {
                            "text": "**Client keys**",
                            "type": "text",
                          },
                          {
                            "text": "$8,625 - 345 keys",
                            "type": "text",
                          },
                        ],
                        "type": "column",
                      },
                    ],
                    "type": "column_set",
                  },
                ],
                "gap": "small",
                "type": "container",
              },
            ],
          },
        }
      `);
      expect(orders).toMatchInlineSnapshot(`
        {
          "channelId": "ijh1ciffcp8fdyy4y5snxnornr",
          "message": "",
          "props": {
            "mm_blocks": [
              {
                "accent_color": "#71368a",
                "border": true,
                "content": [
                  {
                    "text": "Monthly orders report for August 18 - September 18",
                    "type": "text",
                  },
                  {
                    "text": "Revenue: 1,234.5 USD; Profit: 678.25 USD",
                    "type": "text",
                  },
                  {
                    "type": "divider",
                  },
                  {
                    "columns": [
                      {
                        "gap": "small",
                        "items": [
                          {
                            "text": "**Revenue**",
                            "type": "text",
                          },
                          {
                            "text": "1,234.5 USD",
                            "type": "text",
                          },
                        ],
                        "type": "column",
                      },
                      {
                        "gap": "small",
                        "items": [
                          {
                            "text": "**Profit**",
                            "type": "text",
                          },
                          {
                            "text": "678.25 USD",
                            "type": "text",
                          },
                        ],
                        "type": "column",
                      },
                    ],
                    "type": "column_set",
                  },
                ],
                "gap": "small",
                "type": "container",
              },
            ],
          },
        }
      `);
    });

    it('should format the report range across a year boundary', async () => {
      setNow('2027-01-19T12:00:00.000Z');

      await sut.onMonthlyReport();

      const [[licenses], [orders]] = mattermostMock.send.mock.calls;
      expect((licenses.props as any).mm_blocks[0].content[0].text).toBe(
        'Monthly licenses report for December 18 - January 18',
      );
      expect((orders.props as any).mm_blocks[0].content[0].text).toBe(
        'Monthly orders report for December 18 - January 18',
      );
    });
  });

  describe('onCreateMonthlySummary', () => {
    beforeEach(() => {
      outlineMock.createDocument.mockResolvedValue({
        id: 'doc-1',
        parentDocumentId: Constants.Outline.Documents.SupportCrewBlog,
        url: '/doc/september-2026-recap-abc123',
      });
      discordMock.createThread.mockResolvedValue({ threadId: 'thread-1' });
    });

    it.each([
      { now: '2026-09-22T00:00:00.000Z', reason: '8 days before the end of a 30-day month' },
      { now: '2026-09-22T23:59:00.000Z', reason: 'just over 8 days before the end of a 30-day month' },
      { now: '2026-09-24T00:00:00.000Z', reason: '6 days before the end of a 30-day month' },
      { now: '2026-10-23T00:00:00.000Z', reason: '8 days before the end of a 31-day month' },
      { now: '2026-10-25T00:00:00.000Z', reason: '6 days before the end of a 31-day month' },
      { now: '2026-09-01T00:00:00.000Z', reason: 'the first of the month' },
      { now: '2026-09-30T00:00:00.000Z', reason: 'the last day of the month' },
    ])('should be a no-op $reason', async ({ now }) => {
      setNow(now);

      await sut.onCreateMonthlySummary();

      expect(outlineMock.createDocument).not.toHaveBeenCalled();
      expect(discordMock.createThread).not.toHaveBeenCalled();
      expect(discordMock.sendMessage).not.toHaveBeenCalled();
    });

    it.each([
      {
        now: '2026-09-23T00:00:00.000Z',
        title: 'September 2026 recap',
        reason: 'at midnight, 7 days before the end of a 30-day month',
      },
      {
        now: '2026-09-23T12:00:00.000Z',
        title: 'September 2026 recap',
        reason: 'at noon, 7 days before the end of a 30-day month',
      },
      {
        now: '2026-10-24T00:00:00.000Z',
        title: 'October 2026 recap',
        reason: '7 days before the end of a 31-day month',
      },
      {
        now: '2026-02-21T00:00:00.000Z',
        title: 'February 2026 recap',
        reason: '7 days before the end of a 28-day month',
      },
    ])('should create the recap $reason', async ({ now, title }) => {
      setNow(now);

      await sut.onCreateMonthlySummary();

      expect(outlineMock.createDocument).toHaveBeenCalledOnce();
      expect(outlineMock.createDocument).toHaveBeenCalledWith(expect.objectContaining({ title }));
      expect(discordMock.createThread).toHaveBeenCalledOnce();
      expect(discordMock.sendMessage).toHaveBeenCalledOnce();
    });

    it('should create the recap document in the support crew blog', async () => {
      setNow('2026-09-23T00:00:00.000Z');

      await sut.onCreateMonthlySummary();

      expect(outlineMock.createDocument).toHaveBeenCalledOnce();
      expect(outlineMock.createDocument.mock.calls[0][0]).toMatchInlineSnapshot(`
        {
          "collectionId": "e2910656-714c-4871-8721-447d9353bd73",
          "icon": "pencil",
          "iconColor": "#00D084",
          "parentDocumentId": "25c227ce-7d6c-4a0e-84d2-e82fe362a609",
          "text": "
        ---

        title: September recap

        description: A recap of September, 2026, including an update on upcoming features, releases, developer updates, and more.

        publishedAt: 2026-09-30

        slug: 2026-september-recap

        authors: [Immich Team]

        type: recap

        coverAttribution: Photo by <a href="https://unsplash.com/@v2osk" class="underline">v2osk</a> on <a href="https://unsplash.com/photos/foggy-mountain-summit-1Z2niiBPg5A" class="underline">Unsplash</a>

        ---

        ![](https://outline.immich.cloud/api/attachments.redirect?id=7f44c5e3-8f91-4149-aeab-39243c313816" =5299x2981")

        Hello everyone!


        ## Roadmap update


        ## Releases


        ## Developers update - from the labyrinth

        *Our team members' unfiltered thoughts on the good, the bad, and the frustration about the current tasks they are working on.*

        ### @alextran1502

        ### @jrasm91

        ### @danieldietzler


        ## Upcoming goals


        Well, that's it for this month. As always, if you find the project helpful, you can support us at <https://buy.immich.app/>.
        ",
          "title": "September 2026 recap",
        }
      `);
    });

    it('should kick off a discord thread linking to the document and ping the support crew', async () => {
      setNow('2026-09-23T00:00:00.000Z');

      await sut.onCreateMonthlySummary();

      expect(discordMock.createThread).toHaveBeenCalledOnce();
      expect(discordMock.createThread).toHaveBeenCalledWith(Constants.Discord.Channels.SupportCrewDraftAnnouncements, {
        name: 'September 2026 recap',
        message: 'https://outline.immich.cloud/doc/september-2026-recap-abc123',
      });

      expect(discordMock.sendMessage).toHaveBeenCalledOnce();
      expect(discordMock.sendMessage).toHaveBeenCalledWith({
        channelId: Constants.Discord.Channels.SupportCrewDraftAnnouncements,
        threadId: 'thread-1',
        message: "<@&1184258769312551053> <@&1491828281811402833> let's start with this month's recap! 🚀",
      });

      expect(mattermostMock.send).not.toHaveBeenCalled();
    });

    it('should create the document before the thread, and the thread before the kickoff message', async () => {
      setNow('2026-09-23T00:00:00.000Z');

      await sut.onCreateMonthlySummary();

      const [createDocument] = outlineMock.createDocument.mock.invocationCallOrder;
      const [createThread] = discordMock.createThread.mock.invocationCallOrder;
      const [sendMessage] = discordMock.sendMessage.mock.invocationCallOrder;
      expect(createDocument).toBeLessThan(createThread);
      expect(createThread).toBeLessThan(sendMessage);
    });

    it('should still send the kickoff message (with an undefined threadId) when no thread could be created', async () => {
      // The repository returns `{}` rather than a falsy value when the channel is not thread-only, so the
      // `if (thread)` guard never short-circuits.
      setNow('2026-09-23T00:00:00.000Z');
      discordMock.createThread.mockResolvedValue({});

      await sut.onCreateMonthlySummary();

      expect(discordMock.sendMessage).toHaveBeenCalledOnce();
      expect(discordMock.sendMessage).toHaveBeenCalledWith({
        channelId: Constants.Discord.Channels.SupportCrewDraftAnnouncements,
        threadId: undefined,
        message: "<@&1184258769312551053> <@&1491828281811402833> let's start with this month's recap! 🚀",
      });
    });

    it('should not send the kickoff message when createThread resolves to nothing', async () => {
      setNow('2026-09-23T00:00:00.000Z');
      discordMock.createThread.mockResolvedValue(undefined as any);

      await sut.onCreateMonthlySummary();

      expect(outlineMock.createDocument).toHaveBeenCalledOnce();
      expect(discordMock.createThread).toHaveBeenCalledOnce();
      expect(discordMock.sendMessage).not.toHaveBeenCalled();
    });
  });
});
