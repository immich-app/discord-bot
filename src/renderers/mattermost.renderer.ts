import { asHexColor, shorten } from 'src/format';
import {
  Notification,
  NotificationAuthor,
  NotificationField,
  NotificationKind,
} from 'src/interfaces/notification.interface';
import { Palette } from 'src/renderers/palette';

export type MattermostBlock = Record<string, unknown>;

/**
 * Every layout decision, keyed by kind. Nothing here is derived from the values a notification
 * carries: a kind whose author has an avatar renders the avatar layout even when the icon is empty,
 * and a kind whose title links renders the link even when the URL is empty, exactly as the inline
 * block trees this renderer replaced did.
 */
type MattermostLayout = {
  /** A horizontal container with the author's avatar, or a small subtle text line. */
  author: 'avatar' | 'text';
  /** Render the title as an h5 link to `url`. */
  titleLink: boolean;
  /** Render the title with `size: 'small'`. */
  titleSize?: 'small';
  optionalTitleAndLink?: boolean;
  /** Whether a body slot is emitted. An empty slot leaves an `undefined` entry in `content`. */
  bodySlot: boolean;
  /** Shorten the body to this many characters. Mattermost-only truncation lives here, not in the service. */
  bodyMaxLength?: number;
  /** Render the body with `size: 'small'`. */
  bodySize?: 'small';
  /** A divider followed by a column set, or a flat run of `**name**` / value text blocks. */
  fieldsLayout: 'columns' | 'text';
};

const Layouts: Record<NotificationKind, MattermostLayout> = {
  feed: { author: 'avatar', titleLink: true, titleSize: 'small', bodySlot: true, fieldsLayout: 'columns' },
  release: {
    author: 'avatar',
    titleLink: true,
    bodySlot: true,
    bodyMaxLength: 500,
    bodySize: 'small',
    fieldsLayout: 'columns',
  },
  incident: { author: 'text', titleLink: true, bodySlot: false, fieldsLayout: 'text' },
  purchase: { author: 'text', titleLink: true, bodySlot: true, fieldsLayout: 'columns' },
  report: { author: 'text', titleLink: false, bodySlot: true, fieldsLayout: 'columns' },
  alert: { author: 'text', titleLink: false, bodySlot: true, fieldsLayout: 'columns' },
  rss: {
    author: 'avatar',
    titleLink: true,
    titleSize: 'small',
    optionalTitleAndLink: true,
    bodySlot: true,
    fieldsLayout: 'columns',
  },
};

const toAuthorBlock = (
  { name, url, iconUrl }: NotificationAuthor,
  layout: MattermostLayout['author'],
): MattermostBlock => {
  const link = `[${name}](${url})`;

  if (layout === 'text') {
    return { type: 'text', text: link, is_subtle: true, size: 'small' };
  }

  return {
    type: 'container',
    gap: 'small',
    flow: 'horizontal',
    content: [
      {
        type: 'image',
        url: iconUrl,
        alt_text: `${name}'s avatar`,
        size: 'small',
        image_style: 'person',
        horizontal_alignment: 'left',
        max_width: 26,
      },
      { type: 'text', text: link, is_subtle: true },
    ],
  };
};

const toFieldBlocks = (fields: NotificationField[], layout: MattermostLayout['fieldsLayout']): MattermostBlock[] => {
  if (layout === 'text') {
    return fields.flatMap(({ name, value }) => [
      { type: 'text', text: `**${name}**` },
      { type: 'text', text: value },
    ]);
  }

  return [
    { type: 'divider' },
    {
      type: 'column_set',
      columns: fields.map(({ name, value }) => ({
        type: 'column',
        gap: 'small',
        items: [
          { type: 'text', text: `**${name}**` },
          { type: 'text', text: value },
        ],
      })),
    },
  ];
};

const toOptionalTitle = (title: string, url: string | undefined) => {
  const label = title || url;
  if (!label) {
    return;
  }
  return url ? `##### [${label}](${url})` : `##### ${label}`;
};

export const toMattermostBlock = (notification: Notification): MattermostBlock => {
  const { kind, accent, author, title, url, body, fields } = notification;
  const layout = Layouts[kind];
  const { titleLink, titleSize, bodySlot, bodyMaxLength, bodySize, fieldsLayout } = layout;

  const content: Array<MattermostBlock | undefined> = [];

  if (author) {
    content.push(toAuthorBlock(author, layout.author));
  }

  const titleText = layout.optionalTitleAndLink
    ? toOptionalTitle(title, url)
    : titleLink
      ? `##### [${title}](${url})`
      : title;
  if (titleText !== undefined) {
    content.push({ type: 'text', text: titleText, ...(titleSize ? { size: titleSize } : {}) });
  }

  if (bodySlot) {
    content.push(
      body
        ? {
            type: 'text',
            text: bodyMaxLength ? shorten(body, bodyMaxLength) : body,
            ...(bodySize ? { size: bodySize } : {}),
          }
        : undefined,
    );
  }

  if (fields) {
    content.push(...toFieldBlocks(fields, fieldsLayout));
  }

  return {
    type: 'container',
    accent_color: accent ? asHexColor(Palette[accent]) : undefined,
    border: true,
    gap: 'small',
    content,
  };
};
