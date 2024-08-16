import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Colors, EmbedBuilder } from 'discord.js';
import { DateTime } from 'luxon';
import { Constants } from 'src/constants';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';
import { getTotal, makeLicenseFields } from 'src/util';

@Injectable()
export class ReportService {
  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
  ) {}

  @Cron(Constants.Cron.DailyReport)
  async onDailyReport() {
    const endOfYesterday = DateTime.now().minus({ days: 1 }).endOf('day');
    const { server, client } = await this.database.getTotalLicenseCount({ day: endOfYesterday });

    await this.discord.sendMessage(DiscordChannel.Stripe, {
      embeds: [
        new EmbedBuilder()
          .setTitle(`Daily report for ${endOfYesterday.toLocaleString(DateTime.DATE_FULL)}`)
          .setDescription(`Total: ${getTotal({ server, client })}`)
          .setColor(Colors.Purple)
          .setFields(makeLicenseFields({ server, client })),
      ],
    });
  }

  @Cron(Constants.Cron.WeeklyReport)
  async onWeeklyReport() {
    const endOfYesterday = DateTime.now().minus({ days: 1 }).endOf('day');
    const lastWeek = endOfYesterday.minus({ weeks: 1 });
    const { server, client } = await this.database.getTotalLicenseCount({ week: endOfYesterday });

    await this.discord.sendMessage(DiscordChannel.Stripe, {
      embeds: [
        new EmbedBuilder()
          .setTitle(`Weekly report for ${lastWeek.toFormat('MMMM dd')} - ${endOfYesterday.toFormat('MMMM dd')}`)
          .setDescription(`Total: ${getTotal({ server, client })}`)
          .setColor(Colors.Purple)
          .setFields(makeLicenseFields({ server, client })),
      ],
    });
  }

  @Cron(Constants.Cron.MonthlyReport)
  async onMonthlyReport() {
    const endOfYesterday = DateTime.now().minus({ days: 1 }).endOf('day');
    const lastMonth = endOfYesterday.minus({ months: 1 });
    const { server, client } = await this.database.getTotalLicenseCount({ month: endOfYesterday });

    await this.discord.sendMessage(DiscordChannel.Stripe, {
      embeds: [
        new EmbedBuilder()
          .setTitle(`Monthly report for ${lastMonth.toFormat('MMMM dd')} - ${endOfYesterday.toFormat('MMMM dd')}`)
          .setDescription(`Total: ${getTotal({ server, client })}`)
          .setColor(Colors.Purple)
          .setFields(makeLicenseFields({ server, client })),
      ],
    });
  }
}
