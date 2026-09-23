import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationDestination, NotificationRoute, NotificationRoutes } from 'src/constants';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { Notification } from 'src/interfaces/notification.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';
import { toDiscordEmbed } from 'src/renderers/discord.renderer';
import { toMattermostBlock } from 'src/renderers/mattermost.renderer';
import { toZulipMessage } from 'src/renderers/zulip.renderer';

type Platform = keyof NotificationRoute;

/**
 * The one place a notification meets a platform. Services describe an event as a `Notification` and
 * name the destination it belongs to; this service looks the destination up in `NotificationRoutes`,
 * renders the notification once per platform and posts it. Adding a platform means adding it here,
 * to the route table and as a renderer, and nowhere else.
 */
@Injectable()
export class NotificationService {
  private logger = new Logger(NotificationService.name);

  constructor(
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
    @Inject(IMattermostInterface) private mattermost: IMattermostInterface,
    @Inject(IZulipInterface) private zulip: IZulipInterface,
  ) {}

  /**
   * Never rejects on a send failure: callers post one event to several destinations in sequence, so a
   * rejection would skip every destination after it.
   */
  async notify(destination: NotificationDestination, notification: Notification) {
    const { discord, mattermost, zulip }: NotificationRoute = NotificationRoutes[destination];
    const delivered: boolean[] = [];

    if (discord) {
      const render = () => ({
        channelId: discord.channelId,
        message: { embeds: [toDiscordEmbed(notification)] },
        ...(discord.crosspost ? { crosspost: true } : {}),
      });
      delivered.push(await this.deliver(destination, 'discord', render, (dto) => this.discord.sendMessage(dto)));
    }

    if (mattermost) {
      const render = () => ({
        channelId: mattermost.channelId,
        message: '',
        ...(mattermost.silent ? { silent: true } : {}),
        props: { mm_blocks: [toMattermostBlock(notification)] },
      });
      delivered.push(await this.deliver(destination, 'mattermost', render, (post) => this.mattermost.send(post)));
    }

    if (zulip && this.zulip.isInitialised()) {
      const render = () => ({ stream: zulip.stream, topic: zulip.topic, content: toZulipMessage(notification) });
      delivered.push(await this.deliver(destination, 'zulip', render, (payload) => this.zulip.sendMessage(payload)));
    }

    if (delivered.length > 0 && !delivered.includes(true)) {
      this.logger.fatal(`Could not notify ${destination} on any platform: notification dropped`);
    }
  }

  /** Only the send is isolated: a renderer error is a bug and must propagate, not be logged as an outage. */
  private async deliver<T>(
    destination: NotificationDestination,
    platform: Platform,
    render: () => T,
    send: (payload: T) => Promise<unknown>,
  ) {
    const payload = render();
    try {
      await send(payload);
      return true;
    } catch (error) {
      this.logger.error(`Could not notify ${destination} on ${platform}: ${error}`, (error as Error)?.stack);
      return false;
    }
  }
}
