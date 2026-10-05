import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationDestination, NotificationRoute, NotificationRoutes } from 'src/constants';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { Notification, NotificationTarget } from 'src/interfaces/notification.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';
import { toDiscordMessage } from 'src/renderers/discord.renderer';
import { toZulipMessage } from 'src/renderers/zulip.renderer';

type Platform = keyof NotificationRoute;
type DiscordRoute = NonNullable<NotificationRoute['discord']>;
type ZulipRoute = NonNullable<NotificationRoute['zulip']>;

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
    @Inject(IZulipInterface) private zulip: IZulipInterface,
  ) {}

  /**
   * Never rejects on a send failure: callers post one event to several destinations in sequence, so a
   * rejection would skip every destination after it.
   */
  async notify(destination: NotificationDestination, notification: Notification) {
    const { discord, zulip }: NotificationRoute = NotificationRoutes[destination];
    const delivered: boolean[] = [];

    if (discord && this.discord.isReady()) {
      delivered.push(await this.toDiscord(destination, notification, discord));
    }

    if (zulip && this.zulip.isInitialised()) {
      delivered.push(await this.toZulip(destination, notification, zulip));
    }

    if (delivered.length > 0 && !delivered.includes(true)) {
      this.logger.fatal(`Could not notify ${destination} on any platform: notification dropped`);
    }
  }

  async notifyTarget(target: NotificationTarget, notification: Notification): Promise<boolean> {
    switch (target.platform) {
      case 'discord': {
        return this.discord.isReady() && this.toDiscord(`channel ${target.channelId}`, notification, target);
      }
      case 'zulip': {
        const label = `stream ${target.stream}, topic "${target.topic}"`;
        return this.zulip.isInitialised() && this.toZulip(label, notification, target);
      }
    }
  }

  private toDiscord(label: string, notification: Notification, { channelId, crosspost }: DiscordRoute) {
    const render = () => ({
      channelId,
      message: toDiscordMessage(notification),
      ...(crosspost ? { crosspost: true } : {}),
    });
    return this.deliver(label, 'discord', render, (dto) => this.discord.sendMessage(dto));
  }

  private toZulip(label: string, notification: Notification, { stream, topic }: ZulipRoute) {
    const render = () => ({ stream, topic, content: toZulipMessage(notification) });
    return this.deliver(label, 'zulip', render, (payload) => this.zulip.sendMessage(payload));
  }

  /** Only the send is isolated: a renderer error is a bug and must propagate, not be logged as an outage. */
  private async deliver<T>(label: string, platform: Platform, render: () => T, send: (payload: T) => Promise<unknown>) {
    const payload = render();
    try {
      await send(payload);
      return true;
    } catch (error) {
      this.logger.error(`Could not notify ${label} on ${platform}: ${error}`, (error as Error)?.stack);
      return false;
    }
  }
}

export const toNotificationTarget = ({
  service,
  channelId,
  topic,
}: {
  service: Platform;
  channelId: string;
  topic: string | null;
}): NotificationTarget =>
  service === 'zulip'
    ? { platform: 'zulip', stream: Number(channelId), topic: topic ?? '' }
    : { platform: 'discord', channelId };
