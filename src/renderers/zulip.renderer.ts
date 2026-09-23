import { shorten } from 'src/format';
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
};

const Layouts: Record<NotificationKind, ZulipLayout> = {
  feed: { titleLink: true, bodySlot: true, bodyStyle: 'quote', fieldsLayout: 'line' },
  release: { titleLink: true, bodySlot: true, bodyMaxLength: 500, bodyStyle: 'inline', fieldsLayout: 'line' },
  incident: { titleLink: true, bodySlot: false, bodyStyle: 'inline', fieldsLayout: 'block' },
  purchase: { titleLink: true, bodySlot: true, bodyStyle: 'inline', fieldsLayout: 'line' },
  report: { titleLink: false, bodySlot: true, bodyStyle: 'inline', fieldsLayout: 'line' },
  alert: { titleLink: false, bodySlot: true, bodyStyle: 'inline', fieldsLayout: 'line' },
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

/** Zulip has no backslash escaping, so a zero-width space after the sigil is the only way to stop a mention. */
export const neutraliseMentions = (text: string) => text.replaceAll(/([@#])(?=_?\*)/g, '$1\u200B');

/**
 * Python-Markdown only closes a link label when `(` or `[` directly follows `]`, so breaking just those
 * pairs stops an untrusted title forging the heading's link while leaving every other `]` as written.
 */
export const neutraliseLabel = (text: string) => neutraliseMentions(text).replaceAll(/\](?=[([])/g, ']\u200B');

const toAuthorLink = ({ name, url }: NotificationAuthor) => `— [${neutraliseLabel(name)}](${url})`;

const toHeading = ({ accent, author, title, url }: Notification, titleLink: ZulipLayout['titleLink']) => {
  const safeTitle = neutraliseLabel(title);
  return [
    accent && Emoji[accent],
    titleLink ? `**[${safeTitle}](${url})**` : `**${safeTitle}**`,
    author && toAuthorLink(author),
  ]
    .filter(Boolean)
    .join(' ');
};

/** Zulip closes a fence on a line equal to its opening fence, so the fence must outrun any tilde run in the text. */
const toQuote = (text: string) => {
  const longestRun = Math.max(0, ...[...text.matchAll(/~+/g)].map(([run]) => run.length));
  const fence = '~'.repeat(Math.max(3, longestRun + 1));
  return `${fence} quote\n${text}\n${fence}`;
};

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

  const lines = [toHeading(notification, layout.titleLink)];

  if (layout.bodySlot && body) {
    lines.push(toBody(body, layout));
  }

  if (fields) {
    lines.push(...toFieldLines(fields, layout.fieldsLayout));
  }

  return lines.join('\n');
};
