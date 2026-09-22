import { Inject, Injectable } from '@nestjs/common';
import { NotificationDestination, NotificationRoute, NotificationRoutes } from 'src/constants';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { Notification } from 'src/interfaces/notification.interface';
import { toDiscordEmbed } from 'src/renderers/discord.renderer';
import { toMattermostBlock } from 'src/renderers/mattermost.renderer';

/**
 * The one place a notification meets a platform. Services describe an event as a `Notification` and
 * name the destination it belongs to; this service looks the destination up in `NotificationRoutes`,
 * renders the notification once per platform and posts it. Adding a platform means adding it here,
 * to the route table and as a renderer, and nowhere else.
 */
@Injectable()
export class NotificationService {
  constructor(
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
    @Inject(IMattermostInterface) private mattermost: IMattermostInterface,
  ) {}

  /** Posts to every platform the destination has a route for, Discord first, one platform at a time. */
  async notify(destination: NotificationDestination, notification: Notification) {
    const { discord, mattermost }: NotificationRoute = NotificationRoutes[destination];

    if (discord) {
      await this.discord.sendMessage({
        channelId: discord.channelId,
        message: { embeds: [toDiscordEmbed(notification)] },
        ...(discord.crosspost ? { crosspost: true } : {}),
      });
    }

    if (mattermost) {
      await this.mattermost.send({
        channelId: mattermost.channelId,
        message: '',
        ...(mattermost.silent ? { silent: true } : {}),
        props: { mm_blocks: [toMattermostBlock(notification)] },
      });
    }
  }
}
