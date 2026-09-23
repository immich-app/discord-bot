import { escapeMarkdown } from 'discord.js';
import { scanZulipFences, splitOutsideCode, ZulipFence } from 'src/format';

export type ZulipRefs = {
  quoteReply?: { messageId: number; senderId?: number; senderName: string };
  messageIds: number[];
  userIds: number[];
  uploads: string[];
  emojiNames: string[];
};

export type ZulipMessageRef = {
  jumpUrl: string;
  origin: 'discord' | 'zulip';
  discordAuthorId: string | null;
  authorName: string;
};

export type ZulipRenderContext = {
  realmOrigin: string;
  messages: Map<number, ZulipMessageRef>;
  /** Mirrored messages deleted on either side, which a reply must not quote back. */
  deletedMessageIds: Set<number>;
  /** Verified team members only. */
  discordUserByZulipId: Map<number, string>;
  /** Unicode, or `<:name:id>` / `<a:name:id>` for a custom emote. */
  emoji: (name: string) => string | undefined;
  /** Set when the message is mirrored late, as its Zulip `timestamp` in seconds. */
  lateTimestamp?: number;
};

/** `spoilerUploads` are the uploads linked inside a spoiler, which Discord hides only by their file name. */
export type DiscordRendered = { text: string; uploads: string[]; spoilerUploads: string[]; pingUserIds: string[] };

type Lookups = {
  message: (id: number) => ZulipMessageRef | undefined;
  deleted: (id: number) => boolean;
  discordUser: (zulipId: number) => string | undefined;
  emoji: (name: string) => string | undefined;
};

/** Marks a line to drop once the fences are converted; the input never contains it. */
const DROP = '\uE002';
const RESERVED = /[\uE000-\uE002]/g;
const DROPPED_LINE = /^[\s>]*\uE002\s*$/;

const ZULIP_LINK = '*(Zulip link)*';
const WILDCARDS = new Set(['all', 'everyone', 'channel', 'stream', 'topic']);

export const escapeDiscordInline = (text: string) => escapeMarkdown(text).replaceAll('@', '@\u200B');

const QUOTE_REPLY = /^@_\*\*([^*\n]*?)(?:\|(\d+))?\*\* \[[^\]\n]*\]\([^()\s]*\/(?:near|with)\/(\d+)[^()\s]*\):[ \t]*$/;

const INLINE = new RegExp(
  [
    String.raw`\[(?<label>(?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(?:<(?<angled>[^<>\n]*)>|(?<target>(?:[^\s()<>]|\([^\s()<>]*\))*))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)`,
    String.raw`(?<mention>@(?<silent>_?)\*\*(?<name>[^*\n]+)\*\*)`,
    String.raw`(?<group>@_?\*(?<groupName>[^*\n]+)\*)`,
    String.raw`(?<stream>#\*\*[^*\n]+\*\*)`,
    String.raw`<time:(?<time>[^>\n]*)>`,
    String.raw`<(?<angledUrl>https?:\/\/[^\s<>]+)>`,
    String.raw`(?<url>https?:\/\/[^\s<>]+)`,
    String.raw`(?<narrow>#narrow\/[^\s<>]*)`,
    String.raw`:(?<emoji>[\w+-]+):`,
  ].join('|'),
  'gi',
);

/** Zulip's autolinker leaves trailing punctuation, and an unbalanced closing parenthesis, out of the URL. */
const splitUrlTail = (url: string) => {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    const body = url.slice(0, end);
    if ('.,;:!?\'"*_'.includes(last) || (last === ')' && body.split(')').length > body.split('(').length)) {
      end--;
      continue;
    }
    return { url: url.slice(0, end), tail: url.slice(end) };
  }
};

/** Zulip reads a time it cannot parse as a date as Unix seconds, as it does nine digits or more, up to the year 9999. */
const UNIX_SECONDS = /^\s*(\d{9,}(?:\.\d+)?)\s*$/;
const MAX_UNIX_SECONDS = 253_402_300_799;

const toUnixSeconds = (value: string) => {
  const unix = UNIX_SECONDS.exec(value);
  if (unix) {
    const seconds = Math.floor(Number(unix[1]));
    return seconds <= MAX_UNIX_SECONDS ? seconds : undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
};

type QuoteReply = { name: string; senderId?: number; messageId: number; fence: ZulipFence; last: number };

const findQuoteReply = (lines: string[], lineFences: (ZulipFence | null)[]): QuoteReply | undefined => {
  const match = QUOTE_REPLY.exec(lines[0]);
  const fence = lineFences[1];
  if (!match || !fence || fence.open !== 1 || fence.code || !['quote', 'quoted'].includes(fence.lang)) {
    return undefined;
  }
  return {
    name: match[1],
    senderId: match[2] === undefined ? undefined : Number(match[2]),
    messageId: Number(match[3]),
    fence,
    last: fence.close ?? lines.length - 1,
  };
};

const isQuoteFence = (fence: ZulipFence) => !fence.code && (fence.lang === 'quote' || fence.lang === 'quoted');
const isSpoilerFence = (fence: ZulipFence) => !fence.code && fence.lang === 'spoiler';

/**
 * Discord only renders ``` as a code fence, so a closed `~~~` fence becomes one, unless its content holds a ``` that
 * would end it early.
 */
const discordFence = (fence: ZulipFence, lines: string[]) => {
  if (!fence.code || fence.close === null) {
    return undefined;
  }
  const lang = fence.lang === 'math' ? 'tex' : fence.lang;
  if (fence.fence.startsWith('`')) {
    return fence.lang === 'math' ? { open: `${fence.fence}${lang}`, close: fence.fence } : undefined;
  }
  const body = lines.slice(fence.open + 1, fence.close);
  return body.some((line) => line.includes('```')) ? undefined : { open: `\`\`\`${lang}`, close: '```' };
};

const render = (raw: string, realmOrigin: string, lookups: Lookups, lateTimestamp?: number) => {
  const text = raw.replaceAll(/\r\n?/g, '\n').replaceAll(RESERVED, '\uFFFD');
  const lines = text.split('\n');
  const { fences, lineFences } = scanZulipFences(lines);
  const reply = findQuoteReply(lines, lineFences);
  const realmHost = new URL(realmOrigin).hostname;

  const lineOffsets: number[] = [];
  let lineOffset = 0;
  for (const line of lines) {
    lineOffsets.push(lineOffset);
    lineOffset += line.length + 1;
  }
  const replyEnd = reply ? (lineOffsets[reply.last + 1] ?? text.length) : 0;

  const uploads: string[] = [];
  const spoilerUploads = new Set<string>();
  const pingUserIds: string[] = [];

  const enclosedBy = (index: number, test: (fence: ZulipFence) => boolean) => {
    let fence = lineFences[index];
    if (fence && (index === fence.open || index === fence.close)) {
      fence = fence.parent;
    }
    for (; fence; fence = fence.parent) {
      if (test(fence)) {
        return true;
      }
    }
    return false;
  };

  const realmUrl = (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.hostname === realmHost ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  const uploadPath = (target: string) => {
    const path = target.startsWith('/') ? target.split(/[?#]/)[0] : realmUrl(target)?.pathname;
    return path?.startsWith('/user_uploads/') ? path : undefined;
  };

  /** Whether the upload is attached to the Discord copy, so its link can go. */
  const queueUpload = (path: string, start: number | undefined) => {
    if (start === undefined || start < replyEnd) {
      return false;
    }
    if (!uploads.includes(path)) {
      uploads.push(path);
    }
    if (
      enclosedBy(
        lineOffsets.findLastIndex((offset) => offset <= start),
        isSpoilerFence,
      )
    ) {
      spoilerUploads.add(path);
    }
    return true;
  };

  const aloneOnLine = (start: number, end: number) => {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = text.indexOf('\n', end);
    return (
      text.slice(lineStart, start).replace(/^[\s>]*/, '') === '' &&
      text.slice(end, lineEnd === -1 ? text.length : lineEnd).trim() === ''
    );
  };

  /** `start` is the offset of `part` in `text`, or `undefined` for a link label, which queues nothing. */
  const translate = (part: string, start: number | undefined): string =>
    part
      .replaceAll(INLINE, (match: string, ...args: unknown[]) => {
        const groups = args.at(-1) as Record<string, string | undefined>;
        const index = args.at(-3) as number;
        const at = start === undefined ? undefined : start + index;

        if (groups.label !== undefined) {
          const label = translate(groups.label, undefined);
          const target = (groups.angled ?? groups.target ?? '').trim();
          const upload = uploadPath(target);
          if (upload) {
            return queueUpload(upload, at) && aloneOnLine(at!, at! + match.length) ? DROP : label;
          }
          if (target.startsWith('#narrow/') || realmUrl(target)) {
            const messageId = /\/(?:near|with)\/(\d+)/.exec(target)?.[1];
            const message = messageId === undefined ? undefined : lookups.message(Number(messageId));
            return message ? `[${label}](${message.jumpUrl})` : `${label} ${ZULIP_LINK}`;
          }
          return /^https?:\/\//i.test(target) ? `[${label}](${target.replaceAll(' ', '%20')})` : label;
        }

        if (groups.mention !== undefined) {
          const name = groups.name!;
          const byId = /^(.*)\|(\d+)$/s.exec(name);
          if (!byId && WILDCARDS.has(name.toLowerCase())) {
            return `@\u200B${name}`;
          }
          const discordId = byId ? lookups.discordUser(Number(byId[2])) : undefined;
          if (discordId) {
            return `<@${discordId}>`;
          }
          const fullName = byId ? byId[1] : name;
          return `@${escapeDiscordInline(fullName.trim()) || 'someone'}`;
        }

        if (groups.group !== undefined) {
          return `@${escapeDiscordInline(groups.groupName!)}`;
        }

        if (groups.stream !== undefined) {
          return ZULIP_LINK;
        }

        if (groups.time !== undefined) {
          const seconds = toUnixSeconds(groups.time);
          return seconds === undefined ? match : `<t:${seconds}:f>`;
        }

        const bare = groups.angledUrl ?? groups.url;
        if (bare !== undefined) {
          const { url, tail } = groups.angledUrl === undefined ? splitUrlTail(bare) : { url: bare, tail: '' };
          if (!realmUrl(url)) {
            return match;
          }
          const upload = uploadPath(url);
          if (upload && queueUpload(upload, at)) {
            return (aloneOnLine(at!, at! + match.length) ? DROP : '') + tail;
          }
          return ZULIP_LINK + tail;
        }

        if (groups.narrow !== undefined) {
          return ZULIP_LINK;
        }

        return lookups.emoji(groups.emoji!) ?? match;
      })
      .replaceAll(/@(everyone|here)\b/gi, '@\u200B$1');

  let translated = '';
  let offset = 0;
  for (const { text: part, code } of splitOutsideCode(text)) {
    translated += code ? part : translate(part, offset);
    offset += part.length;
  }

  const output = translated.split('\n');
  const inReply = (index: number) => reply !== undefined && index <= reply.last;
  for (const fence of fences) {
    if (fence === reply?.fence || isQuoteFence(fence)) {
      output[fence.open] = DROP;
      if (fence.close !== null) {
        output[fence.close] = DROP;
      }
      continue;
    }
    if (isSpoilerFence(fence)) {
      const header = output[fence.open].slice(fence.fence.length);
      const title = header
        .replace(/^\s*\{?\.?[^\s}]+/, '')
        .replace(/\}\s*$/, '')
        .trim();
      output[fence.open] = `**${title || 'Spoiler'}**`;
      if (fence.close !== null) {
        output[fence.close] = DROP;
      }
      continue;
    }
    const converted = discordFence(fence, lines);
    if (converted) {
      output[fence.open] = converted.open;
      output[fence.close!] = converted.close;
    }
  }

  for (const fence of fences.filter(isSpoilerFence)) {
    const end = fence.close ?? lines.length;
    const content = [...output.keys()].slice(fence.open + 1, end).filter((index) => !DROPPED_LINE.test(output[index]));
    if (content.length > 0) {
      output[content[0]] = `||${output[content[0]]}`;
      output[content.at(-1)!] = `${output[content.at(-1)!]}||`;
    }
  }

  for (const [index, line] of output.entries()) {
    if (enclosedBy(index, (fence) => isQuoteFence(fence) && fence !== reply?.fence) && !DROPPED_LINE.test(line)) {
      output[index] = `> ${line}`;
    }
  }

  const visible = (indexes: number[]) =>
    indexes.filter((index) => !DROPPED_LINE.test(output[index])).map((index) => output[index].replaceAll(DROP, ''));

  const head: string[] = [];
  let body: string[];
  if (reply) {
    const target = lookups.message(reply.messageId);
    if (target?.origin === 'discord' && target.discordAuthorId) {
      head.push(`-# ↩ replying to <@${target.discordAuthorId}> · [jump](${target.jumpUrl})`);
      pingUserIds.push(target.discordAuthorId);
    } else if (target) {
      head.push(`-# ↩ replying to ${escapeDiscordInline(target.authorName)} · [jump](${target.jumpUrl})`);
    } else if (lookups.deleted(reply.messageId)) {
      head.push('-# ↩ replying to a deleted message');
    } else {
      head.push(`-# ↩ ${escapeDiscordInline(reply.name.trim()) || 'someone'} said:`);
      const quote = visible([...output.keys()].slice(reply.fence.open + 1, reply.fence.close ?? lines.length));
      const shown = quote.slice(0, 5).map((line) => (line.startsWith('> ') ? line : `> ${line}`));
      if (quote.length > 5) {
        shown[4] = `${shown[4]} …`;
      }
      head.push(...shown);
    }
    body = visible([...output.keys()].filter((index) => !inReply(index)));
  } else {
    body = visible([...output.keys()]);
    const me = /^\/me (.*\S.*)$/.exec(body[0] ?? '');
    if (lines[0].startsWith('/me ') && me) {
      body[0] = `*${me[1].trim()}*`;
    }
  }

  let result = [...head, body.join('\n').replace(/^\n+/, '')]
    .filter((part) => part !== '')
    .join('\n')
    .trimEnd();
  if (lateTimestamp !== undefined) {
    result = `${result}${result ? '\n' : ''}-# sent <t:${lateTimestamp}:f>`;
  }
  return { text: result, uploads, spoilerUploads: [...spoilerUploads], pingUserIds, reply };
};

export const parseZulipRefs = (raw: string, realmOrigin: string): ZulipRefs => {
  const messageIds = new Set<number>();
  const userIds = new Set<number>();
  const emojiNames = new Set<string>();
  const { uploads, reply } = render(raw, realmOrigin, {
    message: (id) => void messageIds.add(id),
    deleted: () => false,
    discordUser: (id) => void userIds.add(id),
    emoji: (name) => void emojiNames.add(name),
  });
  return {
    quoteReply: reply && { messageId: reply.messageId, senderId: reply.senderId, senderName: reply.name },
    messageIds: [...messageIds],
    userIds: [...userIds],
    uploads,
    emojiNames: [...emojiNames],
  };
};

export const toDiscordMirrorContent = (raw: string, ctx: ZulipRenderContext): DiscordRendered => {
  const { text, uploads, spoilerUploads, pingUserIds } = render(
    raw,
    ctx.realmOrigin,
    {
      message: (id) => ctx.messages.get(id),
      deleted: (id) => ctx.deletedMessageIds.has(id),
      discordUser: (id) => ctx.discordUserByZulipId.get(id),
      emoji: ctx.emoji,
    },
    ctx.lateTimestamp,
  );
  return { text, uploads, spoilerUploads, pingUserIds };
};

const openFenceAtEnd = (text: string) => {
  let open: string | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      open = open === undefined ? line : undefined;
    }
  }
  return open;
};

const splitPoint = (chunk: string, room: number, after: number) => {
  for (const separator of ['\n\n', '\n', ' ']) {
    const index = chunk.lastIndexOf(separator, room);
    if (index > after) {
      return { end: index, next: index + separator.length };
    }
  }
  let end = room;
  const code = chunk.charCodeAt(end - 1);
  if (code >= 0xd8_00 && code <= 0xdb_ff && end - 1 > after) {
    end--;
  }
  return { end, next: end };
};

/**
 * Splits text into Discord messages of at most `max` UTF-16 units. A code block cut in two is closed at the end of one
 * part and reopened with the same opening line at the start of the next; the last part allowed is cut short with `…`.
 */
export const splitDiscordContent = (text: string, max = 2000, maxParts = 6) => {
  const close = '\n```';
  const parts: string[] = [];
  let rest = text;
  let reopen = '';
  while (rest.trim() !== '') {
    const chunk = reopen ? `${reopen}\n${rest}` : rest;
    if (chunk.length <= max) {
      parts.push(chunk);
      break;
    }
    const last = parts.length === maxParts - 1;
    const room = max - close.length - (last ? 1 : 0);
    const prefix = reopen ? reopen.length + 1 : 0;
    if (prefix >= room) {
      reopen = '';
      continue;
    }
    let { end, next } = splitPoint(chunk, room, prefix);
    let open = openFenceAtEnd(chunk.slice(0, end));
    const lastLine = chunk.lastIndexOf('\n', end - 1) + 1;
    if (open !== undefined && lastLine > prefix && chunk.slice(lastLine, end) === open) {
      end = lastLine - 1;
      next = lastLine;
      open = undefined;
    }
    const part = chunk.slice(0, end) + (open === undefined ? '' : close);
    if (last) {
      parts.push(`${part}…`);
      break;
    }
    parts.push(part);
    rest = chunk.slice(next).replace(/^\n+/, '');
    reopen = open ?? '';
    if (open !== undefined && /^```[ \t]*(\n|$)/.test(rest)) {
      rest = rest.replace(/^```[ \t]*\n?/, '');
      reopen = '';
    }
  }
  return parts.map((part) => part.trimEnd()).filter((part) => part !== '');
};
