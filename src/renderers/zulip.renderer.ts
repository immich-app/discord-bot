import { neutraliseZulipLabel, neutraliseZulipMentions, shorten, toZulipQuote } from 'src/format';
import {
  Notification,
  NotificationAccent,
  NotificationAuthor,
  NotificationField,
  NotificationKind,
} from 'src/interfaces/notification.interface';

type ZulipLayout = {
  titleLink: boolean;
  bodySlot: boolean;
  bodyMaxLength?: number;
  bodyStyle: 'quote' | 'inline';
  fieldsLayout: 'line' | 'block';
  timestampSlot?: boolean;
  optionalTitleAndLink?: boolean;
};

const Layouts: Record<NotificationKind, ZulipLayout> = {
  feed: { titleLink: true, bodySlot: true, bodyStyle: 'quote', fieldsLayout: 'line' },
  release: { titleLink: true, bodySlot: true, bodyMaxLength: 500, bodyStyle: 'inline', fieldsLayout: 'line' },
  incident: { titleLink: true, bodySlot: false, bodyStyle: 'inline', fieldsLayout: 'block' },
  purchase: { titleLink: true, bodySlot: true, bodyStyle: 'inline', fieldsLayout: 'line' },
  report: { titleLink: false, bodySlot: true, bodyStyle: 'inline', fieldsLayout: 'line' },
  alert: { titleLink: false, bodySlot: true, bodyStyle: 'inline', fieldsLayout: 'line' },
  rss: {
    titleLink: true,
    bodySlot: true,
    bodyStyle: 'quote',
    fieldsLayout: 'line',
    timestampSlot: true,
    optionalTitleAndLink: true,
  },
};

/** Unicode rather than `:names:`, because Zulip shows an unknown `:name:` as literal text. */
export const Emoji: Record<NotificationAccent, string> = {
  'pr.opened': '🆕',
  'pr.draft': '📝',
  'pr.merged': '🔀',
  'pr.closed': '❌',
  'issue.opened': '🆕',
  'issue.reopened': '🔁',
  'issue.closed': '✅',
  'discussion.created': '💬',
  'discussion.reopened': '🔁',
  'discussion.deleted': '🗑️',
  'discussion.answered': '✅',
  'incident.resolved': '✅',
  'incident.minor': '⚠️',
  'incident.major': '🚨',
  'incident.unknown': '❓',
  'purchase.live': '💰',
  'purchase.test': '🧪',
  'order.placed': '🛒',
  'order.cancelled': '❌',
  'order.test': '🧪',
  'report.licenses': '🔑',
  'report.orders': '📦',
  'release.failed': '🚨',
};

export const neutraliseMentions = neutraliseZulipMentions;

export const neutraliseLabel = neutraliseZulipLabel;

/**
 * A link target cannot end its link early: Python-Markdown ends it at a `)` or whitespace, and a feed post's link
 * is written by anyone, so `https://x/)@**all**` would otherwise mention the whole stream after a broken link.
 */
const toLinkTarget = (url?: string) =>
  url?.replaceAll(/[()\s]/g, (char) => ({ '(': '%28', ')': '%29' })[char] ?? encodeURIComponent(char));

const toAuthorLink = ({ name, url }: NotificationAuthor) => `— [${neutraliseLabel(name)}](${toLinkTarget(url)})`;

const toTitle = (title: string, url: string | undefined, titleLink: ZulipLayout['titleLink']) => {
  const safeTitle = neutraliseLabel(title);
  return titleLink ? `**[${safeTitle}](${toLinkTarget(url)})**` : `**${safeTitle}**`;
};

const toOptionalTitle = (title: string, url: string | undefined) => {
  const label = title || toLinkTarget(url);
  return label && toTitle(label, url, !!url);
};

const toHeading = ({ accent, author, title, url, timestamp }: Notification, layout: ZulipLayout) =>
  [
    accent && Emoji[accent],
    layout.optionalTitleAndLink ? toOptionalTitle(title, url) : toTitle(title, url, layout.titleLink),
    author && toAuthorLink(author),
    layout.timestampSlot && timestamp && `· <time:${timestamp}>`,
  ]
    .filter(Boolean)
    .join(' ');

const toQuote = toZulipQuote;

const toBody = (body: string, { bodyMaxLength, bodyStyle }: ZulipLayout) => {
  const text = neutraliseMentions(bodyMaxLength ? shorten(body, bodyMaxLength) : body);
  return bodyStyle === 'quote' ? toQuote(text) : text;
};

/** Line breaks become spaces so untrusted text can never start a line and open a fence, heading or fake field. */
const toOneLine = (text: string) => text.replaceAll(/\s*[\r\n]\s*/g, ' ');

const toFieldLines = (fields: NotificationField[], layout: ZulipLayout['fieldsLayout']) =>
  fields.map(({ name, value }) => {
    const [safeName, safeValue] = [toOneLine(neutraliseMentions(name)), neutraliseMentions(value)];
    return layout === 'line' ? `**${safeName}:** ${toOneLine(safeValue)}` : `**${safeName}**\n${toQuote(safeValue)}`;
  });

export const toZulipMessage = (notification: Notification) => {
  const { kind, body, fields } = notification;
  const layout = Layouts[kind];

  const lines = [toHeading(notification, layout)];

  if (layout.bodySlot && body) {
    lines.push(toBody(body, layout));
  }

  if (fields) {
    lines.push(...toFieldLines(fields, layout.fieldsLayout));
  }

  return lines.filter(Boolean).join('\n');
};
