import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DateTime } from 'luxon';
import { getConfig } from 'src/config';
import { Constants } from 'src/constants';
import { HolidayDto, IHolidaysInterface } from 'src/interfaces/holidays.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';

@Injectable()
export class ZulipService {
  private logger = new Logger(ZulipService.name);

  constructor(
    @Inject(IHolidaysInterface) private holidays: IHolidaysInterface,
    @Inject(IZulipInterface) private zulip: IZulipInterface,
  ) {}

  async init() {
    const { zulip } = getConfig();
    if (zulip.bot.apiKey !== 'dev' && zulip.user.apiKey !== 'dev') {
      await this.zulip.init(zulip);
      await this.checkSubscriptions();
    }
  }

  private async checkSubscriptions() {
    try {
      const subscriptions = await this.zulip.getSubscriptions();
      const subscribed = new Set(subscriptions.map(({ streamId }) => streamId));
      for (const streamId of Constants.Zulip.RequiredSubscriptions) {
        if (!subscribed.has(streamId)) {
          const name = Object.entries(Constants.Zulip.Streams).find(([, id]) => id === streamId)?.[0];
          this.logger.warn(
            `The Zulip bot is not subscribed to stream ${streamId} (${name}): posts to it will fail until an admin subscribes it`,
          );
        }
      }
    } catch (error) {
      this.logger.error('Could not check the Zulip subscriptions of the bot', error);
    }
  }

  @Cron(Constants.Cron.HolidayInfo)
  async notifyHoliday() {
    const tomorrow = DateTime.now().plus({ days: 1 });
    const holidays = await this.holidays.getHolidays('US', tomorrow.year);

    const isRelevantHoliday = (holiday: HolidayDto) =>
      holiday.types?.includes('Public') && (holiday.global || holiday.counties?.includes('US-TX'));
    const holiday = holidays.find((holiday) => holiday.date === tomorrow.toISODate() && isRelevantHoliday(holiday));

    if (!holiday) {
      return;
    }

    await this.zulip.sendMessage({
      stream: Constants.Zulip.Streams.FUTOStaff,
      topic: 'Holidays',
      content: `Tomorrow is a federal holiday: ${holiday.name}. There won't be any meetings tomorrow.`,
    });
  }
}
