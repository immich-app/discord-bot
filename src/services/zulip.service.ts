import { Inject, Injectable } from '@nestjs/common';
import { getConfig } from 'src/config';
import { IZulipInterface } from 'src/interfaces/zulip.interface';

@Injectable()
export class ZulipService {
  constructor(@Inject(IZulipInterface) private zulip: IZulipInterface) {}

  async init() {
    const { zulip } = getConfig();
    if (zulip.bot.apiKey !== 'dev' && zulip.user.apiKey !== 'dev') {
      await this.zulip.init(zulip);
    }
  }
}
