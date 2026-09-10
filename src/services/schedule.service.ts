import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Colors, roleMention } from 'discord.js';
import { DateTime } from 'luxon';
import { Constants } from 'src/constants';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { IOutlineInterface } from 'src/interfaces/outline.interface';
import { getTotal, makeLicenseFields, makeOrderFields } from 'src/util';

@Injectable()
export class ScheduleService {
  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
    @Inject(IOutlineInterface) private outline: IOutlineInterface,
    @Inject(IMattermostInterface) private mattermost: IMattermostInterface,
  ) {}

  @Cron(Constants.Cron.DailyReport)
  async onDailyReport() {
    const endOfYesterday = DateTime.now().minus({ days: 1 }).endOf('day');
    const { server, client } = await this.database.getTotalLicenseCount({ day: endOfYesterday });
    const { revenue, profit } = await this.database.getTotalFourthwallOrders({ day: endOfYesterday });

    await this.mattermost.send({
      channelId: Constants.Mattermost.Channels.Purchases,
      message: '',
      props: {
        mm_blocks: [
          {
            type: 'container',
            accent_color: `#${Colors.Purple.toString(16)}`,
            border: true,
            gap: 'small',
            content: [
              {
                type: 'text',
                text: `Daily product keys report for ${endOfYesterday.toLocaleString(DateTime.DATE_FULL)}`,
              },
              { type: 'text', text: `Total: ${getTotal({ server, client })}` },
              { type: 'divider' },
              {
                type: 'column_set',
                columns: makeLicenseFields({ server, client }).map(({ name, value }) => ({
                  type: 'column',
                  gap: 'small',
                  items: [
                    { type: 'text', text: `**${name}**` },
                    { type: 'text', text: value },
                  ],
                })),
              },
            ],
          },
        ],
      },
    });

    await this.mattermost.send({
      channelId: Constants.Mattermost.Channels.Purchases,
      message: '',
      props: {
        mm_blocks: [
          {
            type: 'container',
            accent_color: `#${Colors.DarkPurple.toString(16)}`,
            border: true,
            gap: 'small',
            content: [
              {
                type: 'text',
                text: `Daily orders report for ${endOfYesterday.toLocaleString(DateTime.DATE_FULL)}`,
              },
              {
                type: 'text',
                text: `Revenue: ${revenue.toLocaleString()} USD; Profit: ${profit.toLocaleString()} USD`,
              },
              { type: 'divider' },
              {
                type: 'column_set',
                columns: makeOrderFields({ revenue, profit }).map(({ name, value }) => ({
                  type: 'column',
                  gap: 'small',
                  items: [
                    { type: 'text', text: `**${name}**` },
                    { type: 'text', text: value },
                  ],
                })),
              },
            ],
          },
        ],
      },
    });
  }

  @Cron(Constants.Cron.WeeklyReport)
  async onWeeklyReport() {
    const endOfYesterday = DateTime.now().minus({ days: 1 }).endOf('day');
    const lastWeek = endOfYesterday.minus({ weeks: 1 });
    const { server, client } = await this.database.getTotalLicenseCount({ week: endOfYesterday });
    const { revenue, profit } = await this.database.getTotalFourthwallOrders({ week: endOfYesterday });

    await this.mattermost.send({
      channelId: Constants.Mattermost.Channels.Purchases,
      message: '',
      props: {
        mm_blocks: [
          {
            type: 'container',
            accent_color: `#${Colors.Purple.toString(16)}`,
            border: true,
            gap: 'small',
            content: [
              {
                type: 'text',
                text: `Weekly licenses report for ${lastWeek.toFormat('MMMM dd')} - ${endOfYesterday.toFormat('MMMM dd')}`,
              },
              { type: 'text', text: `Total: ${getTotal({ server, client })}` },
              { type: 'divider' },
              {
                type: 'column_set',
                columns: makeLicenseFields({ server, client }).map(({ name, value }) => ({
                  type: 'column',
                  gap: 'small',
                  items: [
                    { type: 'text', text: `**${name}**` },
                    { type: 'text', text: value },
                  ],
                })),
              },
            ],
          },
        ],
      },
    });

    await this.mattermost.send({
      channelId: Constants.Mattermost.Channels.Purchases,
      message: '',
      props: {
        mm_blocks: [
          {
            type: 'container',
            accent_color: `#${Colors.DarkPurple.toString(16)}`,
            border: true,
            gap: 'small',
            content: [
              {
                type: 'text',
                text: `Weekly orders report for ${lastWeek.toFormat('MMMM dd')} - ${endOfYesterday.toFormat('MMMM dd')}`,
              },
              {
                type: 'text',
                text: `Revenue: ${revenue.toLocaleString()} USD; Profit: ${profit.toLocaleString()} USD`,
              },
              { type: 'divider' },
              {
                type: 'column_set',
                columns: makeOrderFields({ revenue, profit }).map(({ name, value }) => ({
                  type: 'column',
                  gap: 'small',
                  items: [
                    { type: 'text', text: `**${name}**` },
                    { type: 'text', text: value },
                  ],
                })),
              },
            ],
          },
        ],
      },
    });
  }

  @Cron(Constants.Cron.MonthlyReport)
  async onMonthlyReport() {
    const endOfYesterday = DateTime.now().minus({ days: 1 }).endOf('day');
    const lastMonth = endOfYesterday.minus({ months: 1 });
    const { server, client } = await this.database.getTotalLicenseCount({ month: endOfYesterday });
    const { revenue, profit } = await this.database.getTotalFourthwallOrders({ month: endOfYesterday });

    await this.mattermost.send({
      channelId: Constants.Mattermost.Channels.Purchases,
      message: '',
      props: {
        mm_blocks: [
          {
            type: 'container',
            accent_color: `#${Colors.Purple.toString(16)}`,
            border: true,
            gap: 'small',
            content: [
              {
                type: 'text',
                text: `Monthly licenses report for ${lastMonth.toFormat('MMMM dd')} - ${endOfYesterday.toFormat('MMMM dd')}`,
              },
              { type: 'text', text: `Total: ${getTotal({ server, client })}` },
              { type: 'divider' },
              {
                type: 'column_set',
                columns: makeLicenseFields({ server, client }).map(({ name, value }) => ({
                  type: 'column',
                  gap: 'small',
                  items: [
                    { type: 'text', text: `**${name}**` },
                    { type: 'text', text: value },
                  ],
                })),
              },
            ],
          },
        ],
      },
    });

    await this.mattermost.send({
      channelId: Constants.Mattermost.Channels.Purchases,
      message: '',
      props: {
        mm_blocks: [
          {
            type: 'container',
            accent_color: `#${Colors.DarkPurple.toString(16)}`,
            border: true,
            gap: 'small',
            content: [
              {
                type: 'text',
                text: `Monthly orders report for ${lastMonth.toFormat('MMMM dd')} - ${endOfYesterday.toFormat('MMMM dd')}`,
              },
              {
                type: 'text',
                text: `Revenue: ${revenue.toLocaleString()} USD; Profit: ${profit.toLocaleString()} USD`,
              },
              { type: 'divider' },
              {
                type: 'column_set',
                columns: makeOrderFields({ revenue, profit }).map(({ name, value }) => ({
                  type: 'column',
                  gap: 'small',
                  items: [
                    { type: 'text', text: `**${name}**` },
                    { type: 'text', text: value },
                  ],
                })),
              },
            ],
          },
        ],
      },
    });
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async onCreateMonthlySummary() {
    const endOfMonth = DateTime.now().endOf('month');

    if (Math.floor(endOfMonth.diffNow('days').days) !== 7) {
      return;
    }

    const name = `${endOfMonth.monthLong} ${endOfMonth.year} recap`;
    const response = await this.outline.createDocument({
      collectionId: Constants.Outline.Collections.SupportCrew,
      parentDocumentId: Constants.Outline.Documents.SupportCrewBlog,
      title: name,
      icon: 'pencil',
      iconColor: '#00D084',
      text: `
---

title: ${endOfMonth.monthLong} recap

description: A recap of ${endOfMonth.monthLong}, ${endOfMonth.year}, including an update on upcoming features, releases, developer updates, and more.

publishedAt: ${endOfMonth.toFormat('yyyy-LL-dd')}

slug: ${endOfMonth.year}-${endOfMonth.monthLong.toLowerCase()}-recap

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


\
Well, that's it for this month. As always, if you find the project helpful, you can support us at <https://buy.immich.app/>.
`,
    });
    const thread = await this.discord.createThread(Constants.Discord.Channels.SupportCrewDraftAnnouncements, {
      name,
      message: Constants.Urls.Outline + response.url,
    });

    if (thread) {
      await this.discord.sendMessage({
        channelId: Constants.Discord.Channels.SupportCrewDraftAnnouncements,
        threadId: thread.threadId,
        message: `${roleMention(Constants.Discord.Roles.SupportCrew)} ${roleMention(Constants.Discord.Roles.Immich)} let's start with this month's recap! 🚀`,
      });
    }
  }
}
