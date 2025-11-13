import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DateTime } from 'luxon';
import { getConfig } from 'src/config';
import { Constants } from 'src/constants';
import { IHolidaysInterface } from 'src/interfaces/holidays.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';

@Injectable()
export class ZulipService {
  constructor(
    @Inject(IHolidaysInterface) private holidays: IHolidaysInterface,
    @Inject(IZulipInterface) private zulip: IZulipInterface,
  ) {}

  async init() {
    const { zulip } = getConfig();
    if (zulip.bot.apiKey !== 'dev' && zulip.user.apiKey !== 'dev') {
      await this.zulip.init(zulip);
    }
  }

  @Cron(Constants.Cron.HolidayInfo)
  async notifyHoliday() {
    const tomorrow = DateTime.now().plus({ days: 1 });
    const holidays = await this.holidays.getHolidays('US', tomorrow.year);

    const holiday = holidays.find(({ date }) => date === tomorrow.toISODate());

    if (!holiday) {
      return;
    }

    let content: string | undefined;

    if (holiday.global) {
      content = `Tomorrow is a federal holiday: ${holiday.name}. Most likely there won't be any meetings tomorrow, otherwise Steve will correct me :kekw:`;
    } else if (holiday.counties?.includes('US-TX')) {
      content = `Tomorrow is a holiday in Texas: ${holiday.name}. It's possible that there won't be any meetings tomorrow. If there are, @**Steve** can let you know.`;
    }

    if (content) {
      await this.zulip.sendMessage({
        stream: Constants.Zulip.Streams.FUTOStaff,
        topic: 'Holidays',
        content,
      });
    }
  }
}
