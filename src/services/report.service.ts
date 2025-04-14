import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Colors, EmbedBuilder } from 'discord.js';
import { DateTime } from 'luxon';
import { Constants } from 'src/constants';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';
import { getTotal, makeLicenseFields, makeOrderFields } from 'src/util';

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
    const { revenue, profit } = await this.database.getTotalFourthwallOrders({ day: endOfYesterday });

    await this.discord.sendMessage({
      channelId: DiscordChannel.Stripe,
      message: {
        embeds: [
          new EmbedBuilder()
            .setTitle(`Daily licenses report for ${endOfYesterday.toLocaleString(DateTime.DATE_FULL)}`)
            .setDescription(`Total: ${getTotal({ server, client })}`)
            .setColor(Colors.Purple)
            .setFields(makeLicenseFields({ server, client })),
        ],
      },
    });

    await this.discord.sendMessage({
      channelId: DiscordChannel.Stripe,
      message: {
        embeds: [
          new EmbedBuilder()
            .setTitle(`Daily orders report for ${endOfYesterday.toLocaleString(DateTime.DATE_FULL)}`)
            .setDescription(`Revenue: ${revenue.toLocaleString()} USD; Profit: ${profit.toLocaleString()} USD`)
            .setColor(Colors.DarkPurple)
            .setFields(makeOrderFields({ revenue, profit })),
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

    await this.discord.sendMessage({
      channelId: DiscordChannel.Stripe,
      message: {
        embeds: [
          new EmbedBuilder()
            .setTitle(
              `Weekly licenses report for ${lastWeek.toFormat('MMMM dd')} - ${endOfYesterday.toFormat('MMMM dd')}`,
            )
            .setDescription(`Total: ${getTotal({ server, client })}`)
            .setColor(Colors.Purple)
            .setFields(makeLicenseFields({ server, client })),
        ],
      },
    });

    await this.discord.sendMessage({
      channelId: DiscordChannel.Stripe,
      message: {
        embeds: [
          new EmbedBuilder()
            .setTitle(
              `Weekly orders report for ${lastWeek.toFormat('MMMM dd')} - ${endOfYesterday.toFormat('MMMM dd')}`,
            )
            .setDescription(`Revenue: ${revenue.toLocaleString()} USD; Profit: ${profit.toLocaleString()} USD`)
            .setColor(Colors.DarkPurple)
            .setFields(makeOrderFields({ revenue, profit })),
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

    await this.discord.sendMessage({
      channelId: DiscordChannel.Stripe,
      message: {
        embeds: [
          new EmbedBuilder()
            .setTitle(
              `Monthly licenses report for ${lastMonth.toFormat('MMMM dd')} - ${endOfYesterday.toFormat('MMMM dd')}`,
            )
            .setDescription(`Total: ${getTotal({ server, client })}`)
            .setColor(Colors.Purple)
            .setFields(makeLicenseFields({ server, client })),
        ],
      },
    });

    await this.discord.sendMessage({
      channelId: DiscordChannel.Stripe,
      message: {
        embeds: [
          new EmbedBuilder()
            .setTitle(
              `Monthly orders report for ${lastMonth.toFormat('MMMM dd')} - ${endOfYesterday.toFormat('MMMM dd')}`,
            )
            .setDescription(`Revenue: ${revenue.toLocaleString()} USD; Profit: ${profit.toLocaleString()} USD`)
            .setColor(Colors.DarkPurple)
            .setFields(makeOrderFields({ revenue, profit })),
        ],
      },
    });
  }
}
