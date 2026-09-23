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
