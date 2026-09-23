/*
 * Plain string helpers with no platform imports. Renderers reach for these instead of `src/util`,
 * which depends on discord.js.
 */

export const shorten = (text: string, maxLength: number = 100) => {
  return text.length > maxLength ? `${text.substring(0, maxLength - 3)}...` : text;
};

/** Zulip counts its limits in code points, and a UTF-16 cut could split a surrogate pair. */
export const shortenCodePoints = (text: string, maxLength: number) => {
  const codePoints = [...text];
  return codePoints.length > maxLength ? `${codePoints.slice(0, maxLength - 3).join('')}...` : text;
};

export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** `#rrggbb` for a Mattermost accent. Deliberately not zero-padded: that is what has always been sent. */
export const asHexColor = (color: number) => `#${color.toString(16)}`;

/** Zulip has no backslash escaping, so a zero-width space after the sigil is the only way to stop a mention. */
export const neutraliseZulipMentions = (text: string) => text.replaceAll(/([@#])(?=_?\*)/g, '$1\u200B');

/**
 * Zulip counts every `[` and `]` in a link label, backslash-escaped or not, so one unbalanced bracket in an untrusted
 * string can end the label early or open a link of its own. A character reference renders as the bracket but is never
 * counted; inside inline code it shows as written.
 */
export const neutraliseZulipLabel = (text: string) =>
  neutraliseZulipMentions(text).replaceAll('[', '&#91;').replaceAll(']', '&#93;');

/** Zulip closes a fence on a line equal to its opening fence, so the fence must outrun any tilde run in the text. */
export const toZulipQuote = (text: string) => {
  const longestRun = Math.max(0, ...[...text.matchAll(/~+/g)].map(([run]) => run.length));
  const fence = '~'.repeat(Math.max(3, longestRun + 1));
  return `${fence} quote\n${text}\n${fence}`;
};

/** Zulip's default `max_message_length`, in code points: the server refuses a longer message. */
export const ZULIP_MAX_MESSAGE_LENGTH = 10_000;

export const ZULIP_MAX_TOPIC_LENGTH = 60;

export const ZULIP_RESOLVED_PREFIX = '✔ ';

export const ZULIP_MAX_UNRESOLVED_TOPIC_LENGTH = ZULIP_MAX_TOPIC_LENGTH - [...ZULIP_RESOLVED_PREFIX].length;

export const isResolvedTopic = (topic: string) => topic.startsWith(ZULIP_RESOLVED_PREFIX);

export const unresolveTopic = (topic: string) =>
  isResolvedTopic(topic) ? topic.slice(ZULIP_RESOLVED_PREFIX.length) : topic;

/**
 * Never truncated: Zulip only treats a move as a resolve when the name sent is exactly `✔ ` plus the current
 * name, and the empty "general chat" topic cannot be resolved at all.
 */
export const resolveTopic = (topic: string) =>
  isResolvedTopic(topic) || topic === '' ? topic : `${ZULIP_RESOLVED_PREFIX}${topic}`;

/**
 * Zulip's hash encoding (`encode_hash_component`), with `(` and `)` encoded too so the link survives as a Markdown
 * link target. `/with/` follows the message through later moves.
 */
export const zulipNarrowLink = (streamId: number, topic: string, messageId: number) => {
  const hash = encodeURIComponent(topic)
    .replaceAll(/[.()!'*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll('%', '.');
  return `#narrow/channel/${streamId}/topic/${hash}/with/${messageId}`;
};

/** Zulip's `FENCE_RE`, applied to a line after Python-Markdown has expanded its tabs. */
const ZULIP_FENCE = /^(`{3,}|~{3,}) *(?:\{?\.?([\w+,\-./#]+) *([^ ~`][^~`]*)?\}?)?$/;

/** Fences whose content Zulip renders as Markdown, so it is not code. */
const ZULIP_MARKDOWN_FENCES = new Set(['quote', 'quoted', 'spoiler']);

/** Python's `str.isspace()`, which decides whether a line closes a fence. */
const PYTHON_WHITESPACE = new Set([
  ...'\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000',
]);

const pythonRstrip = (line: string) => {
  let end = line.length;
  while (end > 0 && PYTHON_WHITESPACE.has(line[end - 1])) {
    end--;
  }
  return line.slice(0, end);
};

const expandTabs = (line: string) => {
  let column = 0;
  let expanded = '';
  for (const char of line) {
    const width = char === '\t' ? 4 - (column % 4) : 1;
    expanded += char === '\t' ? ' '.repeat(width) : char;
    column += width;
  }
  return expanded;
};

type Fence = { fence: string; code: boolean; line: number };
type LineKind = 'text' | 'code' | 'markdown-fence' | 'markdown-close';

const classifyLines = (lines: string[]) => {
  const kinds: LineKind[] = [];
  const open: Fence[] = [];
  for (const [index, line] of lines.entries()) {
    const top = open.at(-1);
    if (top && pythonRstrip(line) === top.fence) {
      open.pop();
      kinds.push(top.code ? 'code' : 'markdown-close');
      continue;
    }
    const match = top?.code ? null : ZULIP_FENCE.exec(expandTabs(line));
    if (match) {
      const code = !ZULIP_MARKDOWN_FENCES.has(match[2]?.toLowerCase() ?? '');
      open.push({ fence: match[1], code, line: index });
      kinds.push(code ? 'code' : 'markdown-fence');
      continue;
    }
    kinds.push(top?.code ? 'code' : 'text');
  }

  const unclosed = open.find(({ code }) => code);
  if (unclosed) {
    kinds.fill('text', unclosed.line);
  }
  return kinds;
};

/**
 * The next inline code span from `from`, `undefined` when no backtick is left, or `null` when a backtick run could be
 * paired differently by Zulip: escaped, unmatched on its line, or closed on a later one.
 */
const nextCodeSpan = (text: string, from: number) => {
  const runs = /`+/g;
  runs.lastIndex = from;
  const opener = runs.exec(text);
  if (!opener) {
    return undefined;
  }
  if (text[opener.index - 1] === '\\') {
    return null;
  }
  const lineBreak = /[\r\n]/g;
  lineBreak.lastIndex = opener.index;
  const lineEnd = lineBreak.exec(text)?.index ?? text.length;
  for (let closer = runs.exec(text); closer && closer.index < lineEnd; closer = runs.exec(text)) {
    if (closer[0].length === opener[0].length) {
      return { start: opener.index, end: closer.index + closer[0].length };
    }
  }
  return null;
};

/**
 * Applies `fn` to every part of Zulip Markdown that Zulip does not render as code, leaving code byte-identical.
 *
 * Code is what Zulip's own parser takes for it: a fenced block (other than `quote` and `spoiler`, whose content is
 * Markdown) closed by a line equal to its opening fence, and an inline span closed on the same line. Wherever the two
 * parsers could disagree, the text counts as text, since treating code as text only over-neutralises it, whereas
 * treating text as code would let it through untouched: an unclosed fence, and every backtick after one that is
 * escaped, unmatched or matched on a later line. `fn` must not add or remove backticks, tildes or line breaks, or the
 * structure it was given no longer holds.
 */
export const mapOutsideCode = (text: string, fn: (text: string) => string) => {
  const apply = (part: string) => (part ? fn(part) : part);
  if (text.includes('\x02') || text.includes('\x03')) {
    return apply(text);
  }

  const parts = text.split(/(\r\n|\r|\n)/);
  const lines = parts.filter((_, index) => index % 2 === 0);
  const kinds = classifyLines(lines);

  let inlineCode = true;
  const mapText = (segment: string) => {
    let output = '';
    let from = 0;
    while (inlineCode) {
      const span = nextCodeSpan(segment, from);
      if (span === undefined) {
        break;
      }
      if (span === null) {
        inlineCode = false;
        break;
      }
      output += apply(segment.slice(from, span.start)) + segment.slice(span.start, span.end);
      from = span.end;
    }
    return output + apply(segment.slice(from));
  };

  let output = '';
  let segment = '';
  for (const [index, line] of lines.entries()) {
    const withBreak = line + (parts[index * 2 + 1] ?? '');
    if (kinds[index] === 'text') {
      segment += withBreak;
      continue;
    }
    output += mapText(segment);
    segment = '';
    if (kinds[index] === 'markdown-fence') {
      const fence = /^(`+|~+)/.exec(line)![0];
      output += fence + apply(line.slice(fence.length)) + withBreak.slice(line.length);
    } else {
      output += withBreak;
    }
  }
  return output + mapText(segment);
};
