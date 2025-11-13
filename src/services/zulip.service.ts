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

    if (holiday.global) {
      const content = `Tomorrow is a federal holiday: ${holiday.name}. Most likely there won't be any meetings tomorrow, otherwise Steve will correct me :kekw:`;

      await this.zulip.sendMessage({
        stream: Constants.Zulip.Streams.FUTOStaff,
        topic: 'Holidays',
        content,
      });
    }
  }
}
