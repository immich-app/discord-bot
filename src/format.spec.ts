import {
  asHexColor,
  isResolvedTopic,
  mapOutsideCode,
  neutraliseZulipLabel,
  neutraliseZulipMentions,
  plural,
  resolveTopic,
  scanZulipFences,
  shorten,
  shortenCodePoints,
  splitOutsideCode,
  toZulipQuote,
  unresolveTopic,
  ZULIP_MAX_MESSAGE_LENGTH,
  ZULIP_MAX_TOPIC_LENGTH,
  ZULIP_MAX_UNRESOLVED_TOPIC_LENGTH,
  ZULIP_RESOLVED_PREFIX,
  zulipNarrowLink,
} from 'src/format';
import { describe, expect, it } from 'vitest';

describe('shorten', () => {
  it('should leave text at or under the limit alone', () => {
    expect(shorten('abc', 3)).toBe('abc');
  });

  it('should cut to the limit including the ellipsis', () => {
    expect(shorten('abcdefgh', 6)).toBe('abc...');
  });

  it('should default to 100 characters', () => {
    expect(shorten('x'.repeat(101))).toBe('x'.repeat(97) + '...');
  });
});

describe('asHexColor', () => {
  it('should format a colour as #rrggbb', () => {
    expect(asHexColor(0x57_f2_87)).toBe('#57f287');
  });

  it('should not zero-pad, matching what has always been sent', () => {
    expect(asHexColor(0x00_ff_00)).toBe('#ff00');
  });
});

describe('shortenCodePoints', () => {
  it('should leave text at or under the limit alone', () => {
    expect(shortenCodePoints('abc', 3)).toBe('abc');
  });

  it('should cut to the limit including the ellipsis', () => {
    expect(shortenCodePoints('abcdefgh', 6)).toBe('abc...');
  });

  it('should count code points, never cutting inside a surrogate pair', () => {
    expect(shortenCodePoints('😀😀😀😀', 4)).toBe('😀😀😀😀');
    expect(shortenCodePoints('😀😀😀😀😀', 4)).toBe('😀...');
    expect(shorten('😀😀😀😀', 4)).not.toBe('😀😀😀😀');
  });
});

describe('neutraliseZulipMentions', () => {
  it.each(['@**all**', '@_**Zack**', '@*core*', '#**general**'])('should break up %s', (mention) => {
    expect(neutraliseZulipMentions(mention)).toBe(`${mention[0]}\u200B${mention.slice(1)}`);
  });

  it('should leave plain text, emails and bold alone', () => {
    for (const text of ['zack@example.com', '**bold**', '#123', '@zack', 'a # b']) {
      expect(neutraliseZulipMentions(text)).toBe(text);
    }
  });
});

describe('neutraliseZulipLabel', () => {
  it('should turn a `](url)` that would repoint the link into text', () => {
    expect(neutraliseZulipLabel('Click here for the fix ](https://evil.example) thanks')).toBe(
      'Click here for the fix &#93;(https://evil.example) thanks',
    );
    expect(neutraliseZulipLabel('[x](https://evil.example)')).toBe('&#91;x&#93;(https://evil.example)');
  });

  it.each([
    { text: 'A lone ] bracket', expected: 'A lone &#93; bracket' },
    { text: 'fix: emoji :]', expected: 'fix: emoji :&#93;' },
    { text: 'lone [ bracket', expected: 'lone &#91; bracket' },
    { text: String.raw`a\[b\]`, expected: String.raw`a\&#91;b\&#93;` },
  ])('should keep the unbalanced bracket in $text from ending or opening a label', ({ text, expected }) => {
    expect(neutraliseZulipLabel(text)).toBe(expected);
  });

  it('should reference balanced brackets too, which Zulip renders as written', () => {
    expect(neutraliseZulipLabel('[owner/repo] Fix [BUG] thumbnails')).toBe(
      '&#91;owner/repo&#93; Fix &#91;BUG&#93; thumbnails',
    );
  });

  it('should leave a title without brackets or mentions as it is', () => {
    for (const text of ['feat(server): add a thing', 'f(x) & <b>', 'zack@example.com', '']) {
      expect(neutraliseZulipLabel(text), text).toBe(text);
    }
  });

  it('should neutralise mentions on the way', () => {
    expect(neutraliseZulipLabel('@**all**](x)')).toBe('@\u200B**all**&#93;(x)');
  });
});

describe('plural', () => {
  it('should add an s to every count but one', () => {
    expect(plural(0, 'thread')).toBe('0 threads');
    expect(plural(1, 'thread')).toBe('1 thread');
    expect(plural(2, 'open pull request')).toBe('2 open pull requests');
  });
});

describe('toZulipQuote', () => {
  it('should wrap text in a three-tilde quote fence', () => {
    expect(toZulipQuote('hello')).toBe('~~~ quote\nhello\n~~~');
  });

  it('should always outrun the longest tilde run inside', () => {
    expect(toZulipQuote('a\n~~~~\nb')).toBe('~~~~~ quote\na\n~~~~\nb\n~~~~~');
  });
});

describe('Zulip topic helpers', () => {
  it('should leave room for the resolved prefix within the topic limit', () => {
    expect(ZULIP_MAX_TOPIC_LENGTH).toBe(60);
    expect(ZULIP_RESOLVED_PREFIX).toBe('✔ ');
    expect(ZULIP_MAX_UNRESOLVED_TOPIC_LENGTH).toBe(58);
    expect(ZULIP_MAX_MESSAGE_LENGTH).toBe(10_000);
  });

  it('should tell a resolved topic by its exact prefix', () => {
    expect(isResolvedTopic('✔ #1234: fix')).toBe(true);
    expect(isResolvedTopic('#1234: fix')).toBe(false);
    expect(isResolvedTopic('✔#1234: fix')).toBe(false);
  });

  it('should strip the resolved prefix only from a resolved topic', () => {
    expect(unresolveTopic('✔ #1234: fix')).toBe('#1234: fix');
    expect(unresolveTopic('#1234: fix')).toBe('#1234: fix');
  });

  it('should resolve a topic once, never the empty one, and never cut it', () => {
    expect(resolveTopic('#1234: fix')).toBe('✔ #1234: fix');
    expect(resolveTopic('✔ #1234: fix')).toBe('✔ #1234: fix');
    expect(resolveTopic('')).toBe('');
    expect([...resolveTopic('x'.repeat(60))]).toHaveLength(62);
  });
});

describe('zulipNarrowLink', () => {
  it('should link the message in its topic by stream ID', () => {
    expect(zulipNarrowLink(120, '#dev', 456)).toBe('#narrow/channel/120/topic/.23dev/with/456');
  });

  it('should encode parentheses so the link survives as a Markdown link target', () => {
    const link = zulipNarrowLink(120, 'foo (2)', 456);

    expect(link).toBe('#narrow/channel/120/topic/foo.20.282.29/with/456');
    expect(link).not.toMatch(/[()]/);
  });

  it("should encode like Zulip's own hash encoding", () => {
    expect(zulipNarrowLink(1, "it's done! *really*. ok~", 2)).toBe(
      '#narrow/channel/1/topic/it.27s.20done.21.20.2Areally.2A.2E.20ok~/with/2',
    );
    expect(zulipNarrowLink(1, '✔ résumé', 2)).toBe('#narrow/channel/1/topic/.E2.9C.94.20r.C3.A9sum.C3.A9/with/2');
  });
});

describe('mapOutsideCode', () => {
  const mark = (text: string) => `«${text}»`;

  it.each([
    { name: 'text without code', text: 'a @**all** b', expected: '«a @**all** b»' },
    {
      name: 'inline code spans',
      text: 'run `npm ci` then ``a ` b`` now',
      expected: '«run »`npm ci`« then »``a ` b``« now»',
    },
    {
      name: 'a closed backtick fence',
      text: 'before\n```\n@**all**\n```\nafter',
      expected: '«before\n»```\n@**all**\n```\n«after»',
    },
    {
      name: 'a closed tilde fence, whose unmatched backtick leaves later spans alone',
      text: '~~~py\nx = `a\n~~~\n`b` c',
      expected: '~~~py\nx = `a\n~~~\n`b`« c»',
    },
    {
      name: 'a longer fence, which only a line of its own length closes',
      text: '````\n```\n@**all**\n```\n````\nx',
      expected: '````\n```\n@**all**\n```\n````\n«x»',
    },
    {
      name: 'a math fence, whose TeX is not Markdown',
      text: '```math\n@**all**\n```',
      expected: '```math\n@**all**\n```',
    },
    {
      name: 'CRLF line breaks',
      text: 'a\r\n```\r\nb\r\n```\r\nc',
      expected: '«a\r\n»```\r\nb\r\n```\r\n«c»',
    },
    {
      name: 'Unicode whitespace after a closing fence, which Python strips',
      text: '```\nx\n```\u00a0\ny',
      expected: '```\nx\n```\u00a0\n«y»',
    },
  ])('should leave code alone around $name', ({ text, expected }) => {
    expect(mapOutsideCode(text, mark)).toBe(expected);
  });

  it.each([
    {
      name: 'quote and spoiler fences, header included, whose content Zulip renders as Markdown',
      text: '```quote\n@**all**\n```\n```spoiler @**all**\n@**all**\n```',
      expected: '```«quote»\n«@**all**\n»```\n```«spoiler @**all**»\n«@**all**\n»```',
    },
    {
      name: 'a quote holding a code fence',
      text: '```quote\n~~~\n```\n@**all**\n~~~\n@**all**\n```',
      expected: '```«quote»\n~~~\n```\n@**all**\n~~~\n«@**all**\n»```',
    },
    {
      name: 'a tab after the fence, which Python-Markdown expands to a space',
      text: '```\tQuote\n@**all**\n```',
      expected: '```«\tQuote»\n«@**all**\n»```',
    },
    {
      name: 'a lone carriage return, which Zulip reads as a line break',
      text: '```\r@**all**\r```\r@**all**',
      expected: '```\r@**all**\r```\r«@**all**»',
    },
    {
      name: 'a closing line longer than the fence, which Zulip does not take as closing it',
      text: '```\nx\n````\n```\n@**all**\n```',
      expected: '```\nx\n````\n```\n«@**all**\n```»',
    },
    {
      name: 'every span after one Zulip continues across an empty fence',
      text: '`a\n```\n```\n` @**all** `b`',
      expected: '«`a\n»```\n```\n«` @**all** `b`»',
    },
  ])('should treat as text $name', ({ text, expected }) => {
    expect(mapOutsideCode(text, mark)).toBe(expected);
  });

  it.each([
    { name: 'an unclosed backtick fence', text: '```\n`@**all**`' },
    { name: 'an unclosed tilde fence', text: '~~~\n@**all**' },
    { name: 'an indented fence', text: ' ```\n@**all**\n```' },
    { name: 'a fence that does not start its line', text: 'text ```\n@**all**\n```' },
    { name: 'an unmatched backtick, and every span after it', text: 'it is 5`\n`x` @**all** `y`' },
    { name: 'a span closed on a later line', text: '`a\n` @**all** `b`' },
    { name: 'an escaped backtick', text: '\\`a` @**all** `b`' },
    { name: 'escaped backslashes before a backtick', text: '\\\\`a` @**all** `b`' },
    { name: 'a run with no partner of its own length', text: '``a` @**all** `b`' },
    { name: 'text holding STX, which Python-Markdown strips', text: '`\u0002``\n@**all**\n```\n@**all**' },
  ])('should treat all of $name as text', ({ text }) => {
    expect(mapOutsideCode(text, mark)).toBe(mark(text));
  });

  it('should keep a shell expansion in inline code byte-identical while neutralising the text', () => {
    expect(mapOutsideCode('`${file#*.}` and #**stream**', neutraliseZulipMentions)).toBe(
      '`${file#*.}` and #\u200B**stream**',
    );
  });

  it('should hand over nothing for a message that is all code', () => {
    const calls: string[] = [];

    expect(mapOutsideCode('```\nx\n```', (text) => (calls.push(text), text))).toBe('```\nx\n```');
    expect(calls).toEqual([]);
  });
});

describe('splitOutsideCode', () => {
  it('should split text into code and text parts that join back into it', () => {
    const text = 'a `b` c\n```quote\nd\n```\n```\ne\n```';
    const segments = splitOutsideCode(text);
    expect(segments).toEqual([
      { text: 'a ', code: false },
      { text: '`b`', code: true },
      { text: ' c\n', code: false },
      { text: '```', code: true },
      { text: 'quote', code: false },
      { text: '\n', code: true },
      { text: 'd\n', code: false },
      { text: '```\n', code: true },
      { text: '```\n', code: true },
      { text: 'e\n', code: true },
      { text: '```', code: true },
    ]);
    expect(segments.map(({ text }) => text).join('')).toBe(text);
  });

  it('should return nothing for empty text', () => {
    expect(splitOutsideCode('')).toEqual([]);
  });
});

describe('scanZulipFences', () => {
  it('should nest fences as Zulip does and find the line that closes each', () => {
    const lines = ['a', '````quote', 'b', '```py', 'c', '```', '````', '~~~ Spoiler x', 'd'];
    const { fences, lineFences } = scanZulipFences(lines);
    const [quote, code, spoiler] = fences;
    expect(fences).toHaveLength(3);
    expect(quote).toMatchObject({ fence: '````', lang: 'quote', code: false, open: 1, close: 6, parent: null });
    expect(code).toMatchObject({ fence: '```', lang: 'py', code: true, open: 3, close: 5, parent: quote });
    expect(spoiler).toMatchObject({ fence: '~~~', lang: 'spoiler', code: false, open: 7, close: null, parent: null });
    expect(lineFences).toEqual([null, quote, quote, code, code, code, quote, spoiler, spoiler]);
  });

  it('should not open a fence inside code', () => {
    const { fences } = scanZulipFences(['```', '~~~quote', '```']);
    expect(fences).toHaveLength(1);
    expect(fences[0]).toMatchObject({ lang: '', code: true, open: 0, close: 2 });
  });
});
