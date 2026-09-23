import { createHash } from 'node:crypto';
import {
  mapOutsideCode,
  neutraliseZulipLabel,
  neutraliseZulipMentions,
  shortenCodePoints,
  splitOutsideCode,
  toZulipQuote,
  ZULIP_MAX_MESSAGE_LENGTH,
} from 'src/format';
import { DiscordSourceMessage } from 'src/interfaces/discord-mirror.interface';
import { stripBidiControls } from 'src/mirror/names';
import { toZulipEmojiName } from 'src/services/chat.service';

export type DiscordRenderContext = {
  /** Verified team members only. */
  zulipUserByDiscordId: Map<string, number>;
};

export type ZulipReplyTarget =
  | { origin: 'zulip'; zulipSenderId: number; link: string }
  | { origin: 'discord'; discordAuthorId: string; authorName: string | null; link: string }
  | { origin: 'unmirrored'; authorName: string | null };

export type ZulipHeaderContext = DiscordRenderContext & { reply?: ZulipReplyTarget | null; late?: boolean };

export type ZulipAttachmentResult = { name: string; spoiler: boolean; url: string | null };

type TranslatedMessage = Pick<DiscordSourceMessage, 'content' | 'mentions' | 'silent'>;

/*
 * Everything the mirror means Zulip to render as syntax (its own mentions and links) travels between these two markers
 * until `zulipMirrorContent` has neutralised the whole message, which is the only point where Zulip's reading of the
 * text is final. The markers never reach Zulip, and are stripped from anything a Discord user wrote.
 */
const OPEN = '\uE000';
const CLOSE = '\uE001';
const RESERVED = /[\0\uE000-\uE002]/g;
const PROTECTED = /\uE000([^\uE000\uE001]*)\uE001/g;
const PROTECTED_SPLIT = /(\uE000[^\uE000\uE001]*\uE001)/;

/** Characters Zulip reads before the link itself, so they must not reach a link target. */
const URL_UNSAFE = /[\s`*$<>()[\]\\"']/g;

const INLINE_ESCAPES = /[\\*_`~[\]()<>#@:$|!{}]/g;

/** Zulip only renders `@**...**` after whitespace, a quote, an opening bracket, `/` or `<`. */
const MENTION_ALLOWED_BEFORE = /[\s'"({[/<]/;

const BLOCK_START = /^(?:```|~~~|>|#|-|\*|\+|\d+[.)]|\||\t| {4})/;

const DISCORD_INLINE = new RegExp(
  [
    String.raw`\[(?<label>(?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(?:<(?<angled>[^<>\n]*)>|(?<target>(?:[^\s()<>]|\([^\s()<>]*\))*))\s*\)`,
    String.raw`<(?<bare>https?:\/\/[^\s<>]+)>`,
    String.raw`<@!?(?<user>\d+)>`,
    String.raw`<@&(?<role>\d+)>`,
    String.raw`<#(?<channel>\d+)>`,
    String.raw`<a?:(?<emote>\w+):\d+>`,
    String.raw`<t:(?<unix>-?\d{1,13})(?::[tTdDfFR])?>`,
    String.raw`<\/(?<command>[^:<>\n]+):\d+>`,
  ].join('|'),
  'g',
);

const protect = (text: string) => `${OPEN}${text.replaceAll(RESERVED, '')}${CLOSE}`;

const percentEncode = (char: string) =>
  char.charCodeAt(0) < 0x80
    ? `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
    : encodeURIComponent(char);

const safeUrl = (url: string) => url.replaceAll(RESERVED, '').replaceAll(URL_UNSAFE, percentEncode);

const safeLabel = (label: string) =>
  neutraliseZulipLabel(label.replaceAll(RESERVED, '').replaceAll(/\s+/g, ' ').trim())
    .replaceAll('`', '&#96;')
    .replaceAll('\\', '&#92;');

const zulipMention = (zulipUserId: number, silent: boolean) => protect(`@${silent ? '_' : ''}**|${zulipUserId}**`);

const zulipLink = (label: string, url: string) => protect(`[${safeLabel(label)}](${safeUrl(url)})`);

const zulipFence = (kind: string, content: string) => {
  const longestRun = Math.max(0, ...[...content.matchAll(/~+/g)].map(([run]) => run.length));
  const fence = '~'.repeat(Math.max(3, longestRun + 1));
  return `${fence} ${kind}\n${content}\n${fence}`;
};

export const escapeZulipInline = (text: string) =>
  stripBidiControls(text)
    .replaceAll(RESERVED, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .replaceAll(INLINE_ESCAPES, (char) => `&#${char.charCodeAt(0)};`);

const withOffsets = (text: string) => {
  let start = 0;
  return splitOutsideCode(text).map(({ text: part, code }) => {
    const segment = { start, end: start + part.length, code };
    start = segment.end;
    return segment;
  });
};

const mapTextSegments = (text: string, fn: (part: string, start: number) => string) =>
  withOffsets(text)
    .map(({ start, end, code }) => (code ? text.slice(start, end) : fn(text.slice(start, end), start)))
    .join('');

const translateInline = (part: string, message: TranslatedMessage, ctx: DiscordRenderContext) =>
  part.replaceAll(DISCORD_INLINE, (match: string, ...args: unknown[]) => {
    const groups = args.at(-1) as Record<string, string | undefined>;

    if (groups.label !== undefined) {
      const url = (groups.angled ?? groups.target ?? '').trim();
      if (!/^https?:\/\//i.test(url)) {
        return neutraliseZulipLabel(groups.label);
      }
      return groups.label.trim() ? zulipLink(groups.label, url) : url;
    }
    if (groups.bare !== undefined) {
      return groups.bare;
    }
    if (groups.user !== undefined) {
      const zulipUserId = ctx.zulipUserByDiscordId.get(groups.user);
      return zulipUserId === undefined
        ? `&#64;${escapeZulipInline(message.mentions.users[groups.user] ?? 'unknown-user')}`
        : zulipMention(zulipUserId, message.silent);
    }
    if (groups.role !== undefined) {
      return `&#64;${escapeZulipInline(message.mentions.roles[groups.role] ?? 'unknown-role')}`;
    }
    if (groups.channel !== undefined) {
      return `&#35;${escapeZulipInline(message.mentions.channels[groups.channel] ?? 'unknown-channel')}`;
    }
    if (groups.emote !== undefined) {
      return `:${toZulipEmojiName(groups.emote)}:`;
    }
    if (groups.unix !== undefined) {
      const date = new Date(Number(groups.unix) * 1000);
      return Number.isNaN(date.getTime()) ? match : `<time:${date.toISOString()}>`;
    }
    return `/${groups.command!.trim()}`;
  });

const translateMessage = (message: TranslatedMessage, ctx: DiscordRenderContext) => {
  let text = message.content.replaceAll(/\r\n?/g, '\n').replaceAll(RESERVED, '\uFFFD');

  const bars = withOffsets(text)
    .filter(({ code }) => !code)
    .reduce((count, { start, end }) => count + text.slice(start, end).split('||').length - 1, 0);
  const spoiler = bars >= 2;
  if (spoiler) {
    text = mapTextSegments(text, (part) => part.replaceAll('||', ''));
  }

  const atLineStart = (start: number) => start === 0 || text[start - 1] === '\n';
  text = mapTextSegments(text, (part, start) =>
    part.replaceAll(/(^|\n)((?:>>> |> )?)-# /g, (match: string, lineBreak: string, quote: string, index: number) =>
      lineBreak || atLineStart(start + index) ? `${lineBreak}${quote}` : match,
    ),
  );

  const segments = withOffsets(text);
  let quoteAt = -1;
  for (const { start, end, code } of segments) {
    if (code || quoteAt >= 0) {
      continue;
    }
    for (const match of text.slice(start, end).matchAll(/(^|\n)>>> /g)) {
      const at = start + match.index + match[1].length;
      if (atLineStart(at)) {
        quoteAt = at;
        break;
      }
    }
  }

  const translateRange = (from: number, to: number) =>
    segments
      .filter(({ start, end }) => end > from && start < to)
      .map(({ start, end, code }) => {
        const part = text.slice(Math.max(start, from), Math.min(end, to));
        return code ? part : translateInline(part, message, ctx);
      })
      .join('');

  const body =
    quoteAt < 0
      ? translateRange(0, text.length)
      : [translateRange(0, quoteAt).trimEnd(), toZulipQuote(translateRange(quoteAt + 4, text.length))]
          .filter(Boolean)
          .join('\n');
  return spoiler ? zulipFence('spoiler Spoiler', body) : body;
};

/**
 * The body of a Discord message in Zulip Markdown, still carrying the markers `zulipMirrorContent` resolves; it is only
 * ever passed on to that.
 */
export const toZulipMirrorBody = (dto: DiscordSourceMessage, ctx: DiscordRenderContext) => {
  const parts = [translateMessage(dto, ctx).trimEnd()];
  for (const sticker of dto.stickers) {
    parts.push(`*[sticker: ${escapeZulipInline(sticker)}]*`);
  }
  if (dto.poll !== null) {
    parts.push(`*[poll: ${escapeZulipInline(dto.poll)}]*`);
  }
  for (const content of dto.forwarded) {
    const forwarded = translateMessage({ content, mentions: dto.mentions, silent: true }, ctx).trimEnd();
    parts.push(forwarded.trim() ? `*[forwarded message]*\n${toZulipQuote(forwarded)}` : '*[forwarded message]*');
  }
  return parts.filter((part) => part.trim() !== '').join('\n');
};

/** The quoted part of the message a Discord reply answers. */
export const toZulipReplySnippet = (content: string, ctx: DiscordRenderContext) =>
  shortenCodePoints(
    translateMessage({ content, mentions: { users: {}, roles: {}, channels: {} }, silent: true }, ctx).trim(),
    200,
  );

const bold = (name: string | null) => `**${escapeZulipInline(name ?? '') || 'someone'}**`;

const replySuffix = (reply: ZulipReplyTarget, ctx: DiscordRenderContext, silent: boolean) => {
  switch (reply.origin) {
    case 'zulip': {
      return ` ↩ ${zulipMention(reply.zulipSenderId, silent)} ${zulipLink('said', reply.link)}`;
    }
    case 'discord': {
      const zulipUserId = ctx.zulipUserByDiscordId.get(reply.discordAuthorId);
      const who = zulipUserId === undefined ? bold(reply.authorName) : zulipMention(zulipUserId, true);
      return ` ↩ ${who} ${zulipLink('said', reply.link)}`;
    }
    case 'unmirrored': {
      return ` ↩ ${bold(reply.authorName)}`;
    }
  }
};

export const zulipAuthorHeader = (dto: DiscordSourceMessage, ctx: ZulipHeaderContext) => {
  const zulipUserId = ctx.zulipUserByDiscordId.get(dto.author.id);
  let author: string;
  if (zulipUserId === undefined) {
    const username = escapeZulipInline(dto.author.username) || 'unknown-user';
    const displayName = escapeZulipInline(dto.author.displayName);
    author =
      !displayName || displayName.toLowerCase() === username.toLowerCase()
        ? `**${username}**`
        : `**${displayName}** (&#64;${username})`;
  } else {
    author = zulipMention(zulipUserId, true);
  }
  const reply = ctx.reply ? replySuffix(ctx.reply, ctx, dto.silent) : '';
  const late = ctx.late ? ` · <time:${new Date(dto.createdTimestamp).toISOString()}>` : '';
  return `${author}${reply}${late}`;
};

/** What an edit keeps: the header, and the quote of the message replied to when there is one. */
export const zulipMirrorLead = (header: string, replySnippet: string | null) =>
  replySnippet ? `${header}:\n${toZulipQuote(replySnippet)}\n` : header;

export const toZulipAttachmentLines = (attachments: ZulipAttachmentResult[], jumpUrl: string) => {
  const line = ({ name, url }: ZulipAttachmentResult) =>
    url === null
      ? `*(attachment not mirrored: ${escapeZulipInline(name)}, see ${zulipLink('Discord', jumpUrl)})*`
      : zulipLink(name.replaceAll(/[[\]]/g, ''), url);
  const lines = attachments.filter(({ spoiler }) => !spoiler).map(line);
  const spoilers = attachments.filter(({ spoiler }) => spoiler).map(line);
  if (spoilers.length > 0) {
    lines.push(zulipFence('spoiler Spoiler', spoilers.join('\n')));
  }
  return lines.join('\n');
};

const neutraliseUnprotected = (text: string) =>
  text
    .split(PROTECTED_SPLIT)
    .map((piece, index) =>
      index % 2 === 1 ? piece : neutraliseZulipMentions(piece).replaceAll('[', '&#91;').replaceAll(']', '&#93;'),
    )
    .join('');

const finalise = (content: string) =>
  mapOutsideCode(content, neutraliseUnprotected)
    .replaceAll(PROTECTED, (_match: string, payload: string, offset: number, whole: string) => {
      const before = whole[offset - 1];
      return payload.startsWith('@') && before !== undefined && !MENTION_ALLOWED_BEFORE.test(before)
        ? ` ${payload}`
        : payload;
    })
    .replaceAll(RESERVED, '');

/**
 * The Zulip message: the lead, then the body and the attachment lines. Everything Zulip reads as text is neutralised
 * here, against the final message, so that no cut, quote or fence can change what counts as code afterwards. The cut
 * comes first and shrinks until the neutralised message fits, since Zulip would otherwise cut it again itself.
 */
export const zulipMirrorContent = (lead: string, body: string, attachments: string) => {
  const rest = [body.trimEnd(), attachments].filter(Boolean).join('\n');
  const separator = lead.endsWith('\n') ? '' : BLOCK_START.test(rest) ? ':\n' : ': ';
  const full = `${lead}${separator}${rest}`;
  for (let limit = ZULIP_MAX_MESSAGE_LENGTH; ;) {
    const content = finalise(shortenCodePoints(full, limit));
    const length = [...content].length;
    if (length <= ZULIP_MAX_MESSAGE_LENGTH) {
      return content;
    }
    limit = Math.min(limit - 1, Math.floor((limit * ZULIP_MAX_MESSAGE_LENGTH) / length));
  }
};

export const discordSourceHash = (dto: Pick<DiscordSourceMessage, 'content' | 'stickers' | 'poll' | 'forwarded'>) =>
  createHash('sha256')
    .update(JSON.stringify([dto.content, dto.stickers, dto.poll, dto.forwarded]))
    .digest('hex');
