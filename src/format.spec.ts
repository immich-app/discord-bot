import {
  asHexColor,
  neutraliseZulipLabel,
  neutraliseZulipMentions,
  plural,
  shorten,
  shortenCodePoints,
  toZulipQuote,
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
