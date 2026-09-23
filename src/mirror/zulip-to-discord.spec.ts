import {
  escapeDiscordInline,
  parseZulipRefs,
  splitDiscordContent,
  toDiscordMirrorContent,
  ZulipRenderContext,
} from 'src/mirror/zulip-to-discord';
import { describe, expect, it } from 'vitest';

const REALM = 'https://chat.example.com';
const CONTRIBUTOR = '111111111111111111';
const TEAM_MEMBER = '222222222222222222';
const JUMP_DISCORD = 'https://discord.com/channels/1/2/301';
const JUMP_ZULIP = 'https://discord.com/channels/1/2/302';

const ctx: ZulipRenderContext = {
  realmOrigin: REALM,
  messages: new Map([
    [101, { jumpUrl: JUMP_DISCORD, origin: 'discord', discordAuthorId: CONTRIBUTOR, authorName: 'Contrib' }],
    [102, { jumpUrl: JUMP_ZULIP, origin: 'zulip', discordAuthorId: null, authorName: 'Zack *Z*' }],
  ]),
  discordUserByZulipId: new Map([[8, TEAM_MEMBER]]),
  emoji: (name) => ({ smile: '😄', catjam: '<a:catjam:333333333333333333>' })[name],
};

const text = (raw: string, context: ZulipRenderContext = ctx) => toDiscordMirrorContent(raw, context).text;

const quoteReply = (messageId: number, body: string, fence = '```') =>
  `@_**Someone|5** [said](${REALM}/#narrow/channel/9-dev/topic/x/near/${messageId}):\n${fence}quote\n${body}\n${fence}`;

describe('escapeDiscordInline', () => {
  it('should escape Markdown and break up every @', () => {
    expect(escapeDiscordInline('**x** _y_ @everyone')).toBe('\\*\\*x\\*\\* \\_y\\_ @\u200Beveryone');
  });
});

describe('toDiscordMirrorContent', () => {
  describe('mentions', () => {
    it.each(['@**Zack|8**', '@_**Zack|8**', '@**|8**', '@_**|8**'])(
      'should turn %s of a verified team member into a pill that does not ping',
      (mention) => {
        expect(toDiscordMirrorContent(`hi ${mention}!`, ctx)).toEqual({
          text: `hi <@${TEAM_MEMBER}>!`,
          uploads: [],
          spoilerUploads: [],
          pingUserIds: [],
        });
      },
    );

    it.each([
      { mention: '@**Alex|9**', expected: '@Alex' },
      { mention: '@_**Alex|9**', expected: '@Alex' },
      { mention: '@**|9**', expected: '@someone' },
      { mention: '@**Zack**', expected: '@Zack' },
      { mention: '@**a_b|9**', expected: '@a\\_b' },
      { mention: '@**x|y|9**', expected: '@x|y' },
    ])('should write $mention of anyone unverified, or without an ID, as text', ({ mention, expected }) => {
      expect(text(`hi ${mention}`)).toBe(`hi ${expected}`);
    });

    it.each(['all', 'everyone', 'channel', 'stream', 'topic', 'ALL'])(
      'should defuse the wildcard %s, silent or not',
      (word) => {
        expect(text(`@**${word}** @_**${word}**`)).toBe(`@\u200B${word} @\u200B${word}`);
      },
    );

    it('should write group mentions as text', () => {
      expect(text('@*backend* and @_*mobile team*')).toBe('@backend and @mobile team');
    });

    it('should defuse a literal @everyone and @here', () => {
      expect(text('@everyone and @here, @Everyone')).toBe('@\u200Beveryone and @\u200Bhere, @\u200BEveryone');
    });
  });

  describe('links', () => {
    it.each(['#**immich-alerts**', '#**immich-alerts>deploy**', '#**immich-alerts>deploy@55**'])(
      'should hide the internal names in %s',
      (link) => {
        expect(text(`see ${link} now`)).toBe('see *(Zulip link)* now');
      },
    );

    it.each([
      `${REALM}/#narrow/channel/9-dev/topic/x/near/101`,
      `${REALM}/#narrow/channel/9-dev/topic/x/with/101`,
      '#narrow/channel/9-dev/topic/x/near/101',
      '#narrow/channel/9-dev/topic/x/with/101',
    ])('should turn a link to a mirrored message into a jump link: %s', (target) => {
      expect(text(`[this one](${target})`)).toBe(`[this one](${JUMP_DISCORD})`);
    });

    it('should jump to the Discord copy of a Zulip message', () => {
      expect(text(`[that](#narrow/channel/9-dev/topic/x/near/102)`)).toBe(`[that](${JUMP_ZULIP})`);
    });

    it.each([
      `${REALM}/#narrow/channel/9-dev/topic/x/near/999`,
      '#narrow/channel/113-immich-alerts/topic/deploy',
      `${REALM}/#narrow/channel/113-immich-alerts`,
      `${REALM}/help/`,
    ])('should hide the target of any other Zulip link: %s', (target) => {
      expect(text(`[label](${target}) end`)).toBe('label *(Zulip link)* end');
    });

    it('should hide bare Zulip URLs, keeping the punctuation after them', () => {
      expect(text(`see ${REALM}/#narrow/channel/113-immich-alerts, and (${REALM}/x).`)).toBe(
        'see *(Zulip link)*, and (*(Zulip link)*).',
      );
      expect(text(`<${REALM}/#narrow/channel/113-immich-alerts>`)).toBe('*(Zulip link)*');
      expect(text('#narrow/channel/113-immich-alerts/topic/deploy')).toBe('*(Zulip link)*');
    });

    it('should leave links to other hosts alone', () => {
      expect(text('[docs](https://docs.immich.app/x) and https://github.com/immich-app/immich/pull/1')).toBe(
        '[docs](https://docs.immich.app/x) and https://github.com/immich-app/immich/pull/1',
      );
      expect(text('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))')).toBe(
        '[wiki](https://en.wikipedia.org/wiki/Foo_(bar))',
      );
      expect(text('https://chat.example.com.evil.example/x')).toBe('https://chat.example.com.evil.example/x');
    });

    it('should normalise the other link forms Zulip accepts', () => {
      expect(text('[a](<https://example.com/a b>) [b]( https://example.com/b "title" )')).toBe(
        '[a](https://example.com/a%20b) [b](https://example.com/b)',
      );
    });

    it('should keep only the label of a link to anything else', () => {
      expect(text('[help](/help) [mail](mailto:a@b.c) [top](#top)')).toBe('help mail top');
    });

    it('should translate a link label too', () => {
      expect(text(`[see #**immich-alerts** @**all**](https://example.com)`)).toBe(
        '[see *(Zulip link)* @\u200Ball](https://example.com)',
      );
    });
  });

  describe('uploads', () => {
    it('should queue uploads in order of appearance, once each', () => {
      const raw = [
        'look [a.png](/user_uploads/2/ab/xyz/a.png) here',
        `[b.txt](${REALM}/user_uploads/2/cd/uvw/b.txt)`,
        `${REALM}/user_uploads/2/ef/rst/c.pdf`,
        '[a again](/user_uploads/2/ab/xyz/a.png)',
      ].join('\n');
      expect(toDiscordMirrorContent(raw, ctx)).toEqual({
        text: 'look a.png here',
        uploads: ['/user_uploads/2/ab/xyz/a.png', '/user_uploads/2/cd/uvw/b.txt', '/user_uploads/2/ef/rst/c.pdf'],
        spoilerUploads: [],
        pingUserIds: [],
      });
    });

    it('should name the uploads linked inside a spoiler, which Discord hides by their file name only', () => {
      const raw = [
        '[a.png](/user_uploads/2/ab/xyz/a.png)',
        '```spoiler Plot twist',
        '[b.png](/user_uploads/2/ab/xyz/b.png)',
        '> see [c.png](/user_uploads/2/ab/xyz/c.png)',
        '```',
      ].join('\n');
      expect(toDiscordMirrorContent(raw, ctx)).toEqual({
        text: '**Plot twist**\n||> see c.png||',
        uploads: ['/user_uploads/2/ab/xyz/a.png', '/user_uploads/2/ab/xyz/b.png', '/user_uploads/2/ab/xyz/c.png'],
        spoilerUploads: ['/user_uploads/2/ab/xyz/b.png', '/user_uploads/2/ab/xyz/c.png'],
        pingUserIds: [],
      });
    });

    it('should remove a link that stands alone on its line and keep the label of an inline one', () => {
      expect(text('before\n  [a.png](/user_uploads/2/ab/xyz/a.png)  \nafter')).toBe('before\nafter');
      expect(text('see [a.png](/user_uploads/2/ab/xyz/a.png), then')).toBe('see a.png, then');
      expect(text(`and ${REALM}/user_uploads/2/ab/xyz/a.png too`)).toBe('and  too');
    });

    it('should strip the query and fragment from an upload path', () => {
      expect(toDiscordMirrorContent('[a](/user_uploads/2/ab/xyz/a.png?x=1#y)', ctx).uploads).toEqual([
        '/user_uploads/2/ab/xyz/a.png',
      ]);
    });

    it('should neither queue nor touch an upload link inside code', () => {
      expect(toDiscordMirrorContent('`[a](/user_uploads/2/ab/xyz/a.png)`', ctx)).toEqual({
        text: '`[a](/user_uploads/2/ab/xyz/a.png)`',
        uploads: [],
        spoilerUploads: [],
        pingUserIds: [],
      });
    });

    it('should not queue an upload of the quoted message', () => {
      const raw = `${quoteReply(999, '[old.png](/user_uploads/2/ab/xyz/old.png)')}\nmine`;
      expect(toDiscordMirrorContent(raw, ctx)).toEqual({
        text: '-# ↩ Someone said:\n> old.png\nmine',
        uploads: [],
        spoilerUploads: [],
        pingUserIds: [],
      });
    });
  });

  describe('quote and reply', () => {
    it('should reply to a Discord message with a pill, a jump link and the only ping the mirror sends', () => {
      expect(toDiscordMirrorContent(`${quoteReply(101, 'their text @**all**')}\nthanks`, ctx)).toEqual({
        text: `-# ↩ replying to <@${CONTRIBUTOR}> · [jump](${JUMP_DISCORD})\nthanks`,
        uploads: [],
        spoilerUploads: [],
        pingUserIds: [CONTRIBUTOR],
      });
    });

    it('should reply to a Zulip message by name, without a ping', () => {
      expect(toDiscordMirrorContent(`${quoteReply(102, 'x')}\nthanks`, ctx)).toEqual({
        text: `-# ↩ replying to Zack \\*Z\\* · [jump](${JUMP_ZULIP})\nthanks`,
        uploads: [],
        spoilerUploads: [],
        pingUserIds: [],
      });
    });

    it('should quote up to five lines of an unmirrored message', () => {
      const body = ['one', 'two #**immich-alerts**', 'three', 'four', 'five', 'six'].join('\n');
      expect(toDiscordMirrorContent(`${quoteReply(999, body, '````')}\nreply`, ctx)).toEqual({
        text: '-# ↩ Someone said:\n> one\n> two *(Zulip link)*\n> three\n> four\n> five …\nreply',
        uploads: [],
        spoilerUploads: [],
        pingUserIds: [],
      });
      expect(text(`${quoteReply(999, 'short', '~~~')}\nreply`)).toBe('-# ↩ Someone said:\n> short\nreply');
    });

    it('should name an unnamed quote author someone, and escape a name', () => {
      const raw = `@_**|5** [said](${REALM}/#narrow/channel/9-dev/topic/x/near/999):\n\`\`\`quote\nx\n\`\`\``;
      expect(text(raw)).toBe('-# ↩ someone said:\n> x');
      expect(text(quoteReply(999, 'x').replace('Someone', 'a_b'))).toBe('-# ↩ a\\_b said:\n> x');
    });

    it('should keep a quoted code block in the quote', () => {
      expect(text(quoteReply(999, 'look\n```js\nconst a = @**all**;\n```', '````'))).toBe(
        '-# ↩ Someone said:\n> look\n> ```js\n> const a = @**all**;\n> ```',
      );
    });

    it('should only treat a leading quote as a reply', () => {
      expect(text(`hi\n${quoteReply(101, 'x')}`)).toBe(`hi\n@Someone [said](${JUMP_DISCORD}):\n> x`);
      expect(text(`@_**Someone|5** [said](${REALM}/#narrow/channel/9-dev/topic/x/near/101):\nnot a quote`)).toBe(
        `@Someone [said](${JUMP_DISCORD}):\nnot a quote`,
      );
    });
  });

  describe('fences', () => {
    it('should turn a quote fence into quoted lines', () => {
      expect(text('before\n```quote\nline @**all**\n\nline 2\n```\nafter')).toBe(
        'before\n> line @\u200Ball\n> \n> line 2\nafter',
      );
      expect(text('~~~quote\na\n~~~')).toBe('> a');
    });

    it('should quote an unclosed quote fence to the end, as Zulip does', () => {
      expect(text('```quote\na\nb')).toBe('> a\n> b');
    });

    it('should keep a code block inside a quote as code', () => {
      expect(text('~~~quote\nsee\n```py\nx = "@**all**"\n```\n~~~')).toBe('> see\n> ```py\n> x = "@**all**"\n> ```');
    });

    it('should turn a spoiler into a bold title over a Discord spoiler', () => {
      expect(text('```spoiler Plot :smile:\nhe was @**Zack|8**\nall along\n```')).toBe(
        `**Plot 😄**\n||he was <@${TEAM_MEMBER}>\nall along||`,
      );
      expect(text('~~~ spoiler\nx\n~~~')).toBe('**Spoiler**\n||x||');
      expect(text('```spoiler Empty\n```')).toBe('**Empty**');
    });

    it('should turn a math fence into a tex code block', () => {
      expect(text('```math\nx^2 @**all**\n```')).toBe('```tex\nx^2 @**all**\n```');
      expect(text('~~~math\nx\n~~~')).toBe('```tex\nx\n```');
    });

    it('should turn a tilde code fence into backticks unless its content holds backticks', () => {
      expect(text('~~~js\nconst a = 1;\n~~~')).toBe('```js\nconst a = 1;\n```');
      expect(text('~~~\n```\n~~~')).toBe('~~~\n```\n~~~');
    });

    it('should leave other code blocks byte-identical', () => {
      const raw = [
        '```js',
        '@**all** @**Zack|8** #**immich-alerts** :smile: <time:2024-01-01T00:00:00Z>',
        `[a](/user_uploads/2/ab/xyz/a.png) ${REALM}/#narrow/x @everyone /me`,
        '```',
        'and `@**all** #**x** :smile:` inline, ``${file#*.}`` too',
      ].join('\n');
      expect(toDiscordMirrorContent(raw, ctx)).toEqual({
        text: raw,
        uploads: [],
        spoilerUploads: [],
        pingUserIds: [],
      });
    });

    it('should translate the text of an unclosed code fence, which errs toward rewriting too much', () => {
      expect(text('```\n@**all**')).toBe('```\n@\u200Ball');
    });
  });

  describe('everything else', () => {
    it('should turn a Zulip time into a Discord timestamp', () => {
      expect(text('at <time:2024-01-01T00:00:00Z> or <time:2024-01-01T01:00:00+01:00>')).toBe(
        'at <t:1704067200:f> or <t:1704067200:f>',
      );
    });

    it('should leave a time that does not parse', () => {
      expect(text('<time:whenever>')).toBe('<time:whenever>');
    });

    it('should italicise a /me message', () => {
      expect(text('/me waves at @**Zack|8**\nsecond line')).toBe(`*waves at <@${TEAM_MEMBER}>*\nsecond line`);
      expect(text('/meh')).toBe('/meh');
      expect(text('hi\n/me waves')).toBe('hi\n/me waves');
    });

    it('should resolve unicode and custom emoji, and leave unknown ones', () => {
      expect(text(':smile: :catjam: :nope: 10:30:45')).toBe('😄 <a:catjam:333333333333333333> :nope: 10:30:45');
    });

    it('should mark a late message with when it was sent', () => {
      expect(text('hello', { ...ctx, lateTimestamp: 1_700_000_000 })).toBe('hello\n-# sent <t:1700000000:f>');
      expect(text('', { ...ctx, lateTimestamp: 1_700_000_000 })).toBe('-# sent <t:1700000000:f>');
    });

    it('should read CRLF line breaks as Zulip does', () => {
      expect(text('```quote\r\na\r\n```\r\nb')).toBe('> a\nb');
    });

    it('should never pass the characters it uses internally through', () => {
      expect(text('a\uE000b\uE001c\uE002d')).toBe('a\uFFFDb\uFFFDc\uFFFDd');
    });

    it('should drop trailing blank lines', () => {
      expect(text('hi\n\n[a.png](/user_uploads/2/ab/xyz/a.png)\n')).toBe('hi');
    });
  });
});

describe('parseZulipRefs', () => {
  it('should list what the message refers to', () => {
    const raw = [
      quoteReply(101, 'quoted @**Q|3**'),
      'hi @**Zack|8** @**Alex|9** @**all** :smile: :catjam:',
      `[m](#narrow/channel/9-dev/topic/x/with/102) [n](${REALM}/#narrow/channel/9-dev/topic/x/near/103)`,
      '[a](/user_uploads/2/ab/xyz/a.png)',
    ].join('\n');
    expect(parseZulipRefs(raw, REALM)).toEqual({
      quoteReply: { messageId: 101, senderId: 5, senderName: 'Someone' },
      messageIds: [101, 102, 103],
      userIds: [5, 3, 8, 9],
      uploads: ['/user_uploads/2/ab/xyz/a.png'],
      emojiNames: ['smile', 'catjam'],
    });
  });

  it('should find nothing in plain text', () => {
    expect(parseZulipRefs('hello', REALM)).toEqual({
      quoteReply: undefined,
      messageIds: [],
      userIds: [],
      uploads: [],
      emojiNames: [],
    });
  });
});

describe('splitDiscordContent', () => {
  const lengths = (parts: string[]) => parts.map((part) => part.length);

  it('should keep a short message in one part', () => {
    expect(splitDiscordContent('hello')).toEqual(['hello']);
  });

  it('should return no parts for an empty message', () => {
    expect(splitDiscordContent('')).toEqual([]);
    expect(splitDiscordContent(' \n ')).toEqual([]);
  });

  it('should split at the last paragraph break that fits', () => {
    const first = `${'a'.repeat(1000)}\nline\n\n${'b'.repeat(500)}`;
    const second = 'c'.repeat(600);
    expect(splitDiscordContent(`${first}\n\n${second}`)).toEqual([first, second]);
  });

  it('should split at a line break when there is no paragraph break', () => {
    expect(splitDiscordContent(`${'a'.repeat(1500)}\n${'b'.repeat(1500)}`)).toEqual([
      'a'.repeat(1500),
      'b'.repeat(1500),
    ]);
  });

  it('should split at a space when there is no line break', () => {
    const words = Array.from({ length: 500 }, (_, index) => `w${index % 10}xyz`).join(' ');
    const parts = splitDiscordContent(words);
    expect(parts.join(' ')).toBe(words);
    expect(parts.every((part) => !part.startsWith(' ') && !part.endsWith(' '))).toBe(true);
  });

  it('should cut hard without splitting a surrogate pair', () => {
    const parts = splitDiscordContent('😀'.repeat(1500));
    expect(parts.join('')).toBe('😀'.repeat(1500));
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(2000);
      expect([...part].every((char) => char === '😀')).toBe(true);
    }
  });

  it('should close a code block at the end of a part and reopen it at the start of the next', () => {
    const code = Array.from({ length: 400 }, (_, index) => `line ${index}`).join('\n');
    const parts = splitDiscordContent(`intro\n\`\`\`ts\n${code}\n\`\`\`\noutro`);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0].startsWith('intro\n```ts\n')).toBe(true);
    expect(parts[0].endsWith('\n```')).toBe(true);
    for (const part of parts.slice(1)) {
      expect(part.startsWith('```ts\n')).toBe(true);
    }
    expect(parts.at(-1)!.endsWith('\n```\noutro')).toBe(true);
    for (const part of parts) {
      expect(part.split('\n').filter((line) => line.startsWith('```')).length % 2).toBe(0);
    }
    expect(
      parts
        .map((part, index) => (index === 0 ? part : part.slice('```ts\n'.length)))
        .map((part, index, all) => (index === all.length - 1 ? part : part.slice(0, -'\n```'.length)))
        .join('\n'),
    ).toBe(`intro\n\`\`\`ts\n${code}\n\`\`\`\noutro`);
  });

  it('should not reopen a code block that closed before the split', () => {
    const snippet = '```js\nconst a = 1;\n```';
    const prose = Array.from({ length: 700 }, (_, index) => `w${index % 10}xy`).join(' ');
    const parts = splitDiscordContent(`${snippet}\n${prose}`);

    expect(parts[0]).toBe(snippet);
    expect(lengths(parts)).toEqual([22, 1994, 1504]);
    for (const part of parts.slice(1)) {
      expect(part).not.toContain('```');
    }
    expect(parts.slice(1).join(' ')).toBe(prose);
  });

  it('should not end a part on the opening line of a code block', () => {
    const parts = splitDiscordContent(`${'a'.repeat(1990)}\n\`\`\`js\n${'b\n'.repeat(900)}\`\`\``);
    expect(parts[0]).toBe('a'.repeat(1990));
    expect(parts[1].startsWith('```js\nb\n')).toBe(true);
  });

  it('should not reopen a code block that the next part would close at once', () => {
    const code = 'x'.repeat(1990);
    const parts = splitDiscordContent(`\`\`\`\n${code}\n\`\`\`\n${'after '.repeat(10)}`);
    expect(parts).toEqual([`\`\`\`\n${code}\n\`\`\``, 'after '.repeat(10).trim()]);
  });

  it('should stop at six parts, the last cut with an ellipsis', () => {
    const parts = splitDiscordContent('word '.repeat(4000));
    expect(parts).toHaveLength(6);
    expect(parts[5].endsWith('…')).toBe(true);
    expect(Math.max(...lengths(parts))).toBeLessThanOrEqual(2000);
  });

  it('should close a code block before the ellipsis', () => {
    const parts = splitDiscordContent(`\`\`\`\n${'code line\n'.repeat(2000)}\`\`\``);
    expect(parts).toHaveLength(6);
    expect(parts[5].endsWith('\n```…')).toBe(true);
  });

  it('should keep a 10,000 code point message within the limits', () => {
    for (const input of ['😀'.repeat(10_000), 'x'.repeat(10_000), `${'y '.repeat(2500)}${'😀'.repeat(5000)}`]) {
      const parts = splitDiscordContent(input);
      expect(parts.length).toBeLessThanOrEqual(6);
      expect(Math.max(...lengths(parts))).toBeLessThanOrEqual(2000);
      expect(parts.every((part) => part.trim() !== '')).toBe(true);
      expect(parts.join('').match(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)).toBeNull();
    }
  });

  it('should not reopen a code block whose opening line would not leave room for anything else', () => {
    const parts = splitDiscordContent(`\`\`\`${'l'.repeat(20)}\n${'code '.repeat(10)}`, 16, 20);
    expect(Math.max(...lengths(parts))).toBeLessThanOrEqual(16);
    expect(parts.slice(1).some((part) => part.startsWith('```'))).toBe(false);
  });

  it('should respect a smaller limit and part count', () => {
    expect(splitDiscordContent('aaa bbb ccc ddd', 8, 2)).toEqual(['aaa', 'bbb…']);
  });
});
