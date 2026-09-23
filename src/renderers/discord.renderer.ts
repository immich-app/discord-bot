import { APIEmbed, EmbedBuilder, MessageCreateOptions } from 'discord.js';
import { Notification, NotificationKind } from 'src/interfaces/notification.interface';
import { Palette } from 'src/renderers/palette';

/**
 * Every layout decision, keyed by kind. Each flag says whether a key is set on the embed at all;
 * kinds that set a key always set it, even when the value is empty, and kinds that do not never do.
 * Nothing is derived from the values a notification carries.
 */
type DiscordLayout = {
  /** The author carries an `icon_url`. */
  authorIcon: boolean;
  /** The embed carries a `url` the title links to. */
  titleLink: boolean;
  /** The embed carries a `description`. */
  bodySlot: boolean;
};

type EmbedNotification = Notification & { kind: Exclude<NotificationKind, 'log'> };

const Layouts: Record<Exclude<NotificationKind, 'rss' | 'log'>, DiscordLayout> = {
  feed: { authorIcon: true, titleLink: true, bodySlot: true },
  release: { authorIcon: true, titleLink: true, bodySlot: true },
  incident: { authorIcon: false, titleLink: true, bodySlot: false },
  purchase: { authorIcon: false, titleLink: true, bodySlot: true },
  report: { authorIcon: false, titleLink: false, bodySlot: true },
  alert: { authorIcon: false, titleLink: false, bodySlot: true },
};

/**
 * Discord-only decoration appended to the title. Custom-emoji markup is Discord syntax, so it lives here
 * rather than in the platform-neutral `Notification`.
 */
const TitleSuffix: Partial<Record<NotificationKind, string>> = {
  alert: ' <a:peepoAlert:1367804942638776423>',
};

const toRSSEmbed = ({ author, title, body, timestamp, url }: Notification) =>
  new EmbedBuilder({
    ...(author && { author: { name: author.name, url: author.url, icon_url: author.iconUrl } }),
    ...(title && { title }),
    ...(body && { description: body }),
    ...(timestamp && { timestamp }),
    ...(url && { url }),
  });

export const toDiscordEmbed = (notification: EmbedNotification) => {
  const { kind, accent, author, title, url, body, fields } = notification;
  if (kind === 'rss') {
    return toRSSEmbed(notification);
  }
  const { authorIcon, titleLink, bodySlot } = Layouts[kind];
  const data: APIEmbed = { title: `${title}${TitleSuffix[kind] ?? ''}` };

  if (author) {
    data.author = {
      name: author.name,
      url: author.url,
      ...(authorIcon ? { icon_url: author.iconUrl } : {}),
    };
  }

  if (titleLink) {
    data.url = url;
  }

  if (bodySlot) {
    data.description = body;
  }

  if (fields) {
    data.fields = fields.map(({ name, value, inline }) => ({
      name,
      value,
      ...(inline === undefined ? {} : { inline }),
    }));
  }

  if (accent) {
    data.color = Palette[accent];
  }

  return new EmbedBuilder(data);
};

export const toDiscordMessage = (notification: Notification): string | MessageCreateOptions => {
  const { kind, title, body } = notification;
  if (kind === 'log') {
    return body ? `${title}: ${body}` : title;
  }
  return { embeds: [toDiscordEmbed({ ...notification, kind })] };
};
