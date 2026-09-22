import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { roleMention } from 'discord.js';
import { DateTime } from 'luxon';
import { Constants } from 'src/constants';
import { IDatabaseRepository, ReportOptions } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IOutlineInterface } from 'src/interfaces/outline.interface';
import { NotificationService } from 'src/services/notification.service';
import { getTotal, makeLicenseFields, makeOrderFields } from 'src/util';

type ReportCadence = 'Daily' | 'Weekly' | 'Monthly';

const getEndOfYesterday = () => DateTime.now().minus({ days: 1 }).endOf('day');

/** `September 16 - September 23`: how the weekly and monthly report titles print their range. */
const formatRange = (start: DateTime, end: DateTime) => `${start.toFormat('MMMM dd')} - ${end.toFormat('MMMM dd')}`;

@Injectable()
export class ScheduleService {
  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
    @Inject(IOutlineInterface) private outline: IOutlineInterface,
    private notifications: NotificationService,
  ) {}

  @Cron(Constants.Cron.DailyReport)
  async onDailyReport() {
    const endOfYesterday = getEndOfYesterday();

    await this.sendReports({
      cadence: 'Daily',
      period: endOfYesterday.toLocaleString(DateTime.DATE_FULL),
      options: { day: endOfYesterday },
    });
  }

  @Cron(Constants.Cron.WeeklyReport)
  async onWeeklyReport() {
    const endOfYesterday = getEndOfYesterday();

    await this.sendReports({
      cadence: 'Weekly',
      period: formatRange(endOfYesterday.minus({ weeks: 1 }), endOfYesterday),
      options: { week: endOfYesterday },
    });
  }

  @Cron(Constants.Cron.MonthlyReport)
  async onMonthlyReport() {
    const endOfYesterday = getEndOfYesterday();

    await this.sendReports({
      cadence: 'Monthly',
      period: formatRange(endOfYesterday.minus({ months: 1 }), endOfYesterday),
      options: { month: endOfYesterday },
    });
  }

  /** Posts a licences report followed by an orders report for the period. */
  private async sendReports({
    cadence,
    period,
    options,
  }: {
    cadence: ReportCadence;
    period: string;
    options: ReportOptions;
  }) {
    const { server, client } = await this.database.getTotalLicenseCount(options);
    const { revenue, profit } = await this.database.getTotalFourthwallOrders(options);

    // The daily report has always said "product keys" where the weekly and monthly ones say "licenses".
    const licensesSubject = cadence === 'Daily' ? 'product keys' : 'licenses';

    await this.notifications.notify('team.reports', {
      kind: 'report',
      accent: 'report.licenses',
      title: `${cadence} ${licensesSubject} report for ${period}`,
      body: `Total: ${getTotal({ server, client })}`,
      fields: makeLicenseFields({ server, client }),
    });

    await this.notifications.notify('team.reports', {
      kind: 'report',
      accent: 'report.orders',
      title: `${cadence} orders report for ${period}`,
      body: `Revenue: ${revenue.toLocaleString()} USD; Profit: ${profit.toLocaleString()} USD`,
      fields: makeOrderFields({ revenue, profit }),
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
