import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DateTime } from 'luxon';
import { Constants } from 'src/constants';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';

@Injectable()
export class MattermostService {
  constructor(@Inject(IMattermostInterface) private mattermost: IMattermostInterface) {}

  @Cron('*/1 * * * *')
  async handleJoinNewChannels() {
    for await (const channel of this.mattermost.streamChannels(Constants.Mattermost.Teams.Immich)) {
      if (channel.create_at > DateTime.now().minus({ days: 1 }).toMillis()) {
        await this.mattermost.joinChannel(channel.id);
      }
    }
  }
}
