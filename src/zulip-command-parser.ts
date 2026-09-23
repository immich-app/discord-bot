/** Straight and curly double quotes: a phone keyboard curls the quotes around `text="two words"`. */
const QUOTES = new Set(['"', '“', '”']);

export type ParsedCommand = { name: string; tokens: string[] };

export type Arguments = { args: string[]; options: Record<string, string> };

export type ParseResult =
  { status: 'ignored' } | { status: 'malformed'; reason: string } | { status: 'ok'; command: ParsedCommand };

export const tokenize = (text: string): string[] | undefined => {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (const char of text) {
    if (QUOTES.has(char)) {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (quoted) {
    return undefined;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
};

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** Only newlines may precede the mention: a line indented by four spaces or a tab is a Markdown code block, which must not run a command. */
const mentionOf = (botName: string) => new RegExp(String.raw`^[\r\n]*@_?\*\*${escapeRegExp(botName)}(\|\d+)?\*\*`, 'i');

/** Zulip's "Quote and reply" starts with a silent mention of the quoted author, so a reply quoting the bot is not a command. */
const QUOTE_AND_REPLY = /^\s*\[said\]\(/;

const OPTION = /^([A-Za-z][\w-]*)=(.*)$/s;

export const parseCommand = (content: string, botName: string): ParseResult => {
  // Without a name there is nothing to mention: `@****` must not read as one.
  const mention = botName && content.match(mentionOf(botName));
  if (!mention) {
    return { status: 'ignored' };
  }
  const after = content.slice(mention[0].length);
  if (QUOTE_AND_REPLY.test(after)) {
    return { status: 'ignored' };
  }
  const tokens = tokenize(after);
  if (!tokens) {
    return { status: 'malformed', reason: 'a quote is opened and never closed' };
  }
  const [name = '', ...rest] = tokens;
  return { status: 'ok', command: { name: name.toLowerCase(), tokens: rest } };
};

export const splitArguments = (tokens: string[], keys: string[]): Arguments => {
  const args: string[] = [];
  const options: Record<string, string> = {};
  for (const token of tokens) {
    const option = token.match(OPTION);
    const key = option?.[1].toLowerCase();
    if (option && key !== undefined && keys.includes(key)) {
      options[key] = option[2];
    } else {
      args.push(token);
    }
  }
  return { args, options };
};
