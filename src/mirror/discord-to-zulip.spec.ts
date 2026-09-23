import { ZULIP_MAX_MESSAGE_LENGTH } from 'src/format';
import { DiscordSourceMessage } from 'src/interfaces/discord-mirror.interface';
import {
  DiscordRenderContext,
  discordSourceHash,
  escapeZulipInline,
  toZulipAttachmentLines,
  toZulipMirrorBody,
  toZulipReplySnippet,
  zulipAuthorHeader,
  ZulipHeaderContext,
  zulipMirrorContent,
  zulipMirrorLead,
} from 'src/mirror/discord-to-zulip';
import { describe, expect, it } from 'vitest';

const TEAM_MEMBER = '222222222222222222';
const CONTRIBUTOR = '333333333333333333';
const ROLE = '444444444444444444';
const CHANNEL = '555555555555555555';
const JUMP_URL = 'https://discord.com/channels/1/2/3';

const ctx: DiscordRenderContext = { zulipUserByDiscordId: new Map([[TEAM_MEMBER, 8]]) };

const message = (overrides: Partial<DiscordSourceMessage> = {}): DiscordSourceMessage => ({
  id: '3',
  guildId: '1',
  channelId: '2',
  threadId: null,
  threadName: null,
  createdTimestamp: 1_700_000_000_000,
  jumpUrl: JUMP_URL,
  author: { id: CONTRIBUTOR, username: 'contrib123', displayName: 'contrib123' },
  silent: false,
  content: '',
  mentions: { users: { [TEAM_MEMBER]: 'Zack', [CONTRIBUTOR]: 'Alex' }, roles: { [ROLE]: 'Core' }, channels: {} },
  attachments: [],
  stickers: [],
  poll: null,
  forwarded: [],
  replyTo: null,
  ...overrides,
});

const mirror = (dto: DiscordSourceMessage, header: Partial<ZulipHeaderContext> = {}, attachments = '') =>
  zulipMirrorContent(zulipAuthorHeader(dto, { ...ctx, ...header }), toZulipMirrorBody(dto, ctx), attachments);

/** The mirrored message after the `**contrib123**: ` header. */
const body = (content: string, overrides: Partial<DiscordSourceMessage> = {}) => {
  const output = mirror(message({ content, ...overrides }));
  const header = /^\*\*contrib123\*\*(?::\n|: )/.exec(output)![0];
  return output.slice(header.length);
};

const ZWSP = '\u200B';

describe('escapeZulipInline', () => {
  it('should turn every character Zulip could read as syntax into a character reference', () => {
    expect(escapeZulipInline('\\*_`~[]()<>#@:$|!{}')).toBe(
      '&#92;&#42;&#95;&#96;&#126;&#91;&#93;&#40;&#41;&#60;&#62;&#35;&#64;&#58;&#36;&#124;&#33;&#123;&#125;',
    );
  });

  it('should collapse whitespace, strip bidi controls and keep plain text', () => {
    expect(escapeZulipInline('  Alex \n\t Smith\u202E  ')).toBe('Alex Smith');
    expect(escapeZulipInline('Zoë 😀')).toBe('Zoë 😀');
  });
});

describe('zulipAuthorHeader', () => {
  it('should mention a verified team member silently, by ID', () => {
    const dto = message({ author: { id: TEAM_MEMBER, username: 'zack', displayName: 'Zack' }, content: 'hi' });
    expect(mirror(dto)).toBe('@_**|8**: hi');
  });

  it('should show the username alone when it is the display name, ignoring case', () => {
    expect(mirror(message({ content: 'hi', author: { id: CONTRIBUTOR, username: 'alex', displayName: 'Alex' } }))).toBe(
      '**alex**: hi',
    );
  });

  it('should show the username when the display name differs', () => {
    const author = { id: CONTRIBUTOR, username: 'contrib123', displayName: 'Alex (Immich)' };
    expect(mirror(message({ content: 'hi', author }))).toBe('**Alex &#40;Immich&#41;** (&#64;contrib123): hi');
  });

  it('should entity-escape a hostile display name completely', () => {
    const author = { id: CONTRIBUTOR, username: 'x_y', displayName: '**x** [a](b) @**all**' };
    expect(mirror(message({ content: 'hi', author }))).toBe(
      '**&#42;&#42;x&#42;&#42; &#91;a&#93;&#40;b&#41; &#64;&#42;&#42;all&#42;&#42;** (&#64;x&#95;y): hi',
    );
  });

  it('should keep a contributor from starting the message with a command', () => {
    for (const content of ['/poll Lunch?', '/todo x', '/me waves']) {
      expect(mirror(message({ content })).startsWith('**contrib123**: /')).toBe(true);
    }
  });

  it('should add when a late message was sent', () => {
    expect(mirror(message({ content: 'hi' }), { late: true })).toBe(
      '**contrib123** · <time:2023-11-14T22:13:20.000Z>: hi',
    );
  });

  describe('replies', () => {
    const LINK = '#narrow/channel/7/topic/bugs/with/42';

    it('should mention the team member whose Zulip message a contributor replies to', () => {
      const reply = { origin: 'zulip' as const, zulipSenderId: 8, link: LINK };
      expect(mirror(message({ content: 'hi' }), { reply })).toBe(`**contrib123** ↩ @**|8** [said](${LINK}): hi`);
      expect(mirror(message({ content: 'hi', silent: true }), { reply })).toBe(
        `**contrib123** ↩ @_**|8** [said](${LINK}): hi`,
      );
    });

    it('should name the author of a mirrored Discord message, silently for a team member', () => {
      const toTeam = { origin: 'discord' as const, discordAuthorId: TEAM_MEMBER, authorName: 'Zack', link: LINK };
      expect(mirror(message({ content: 'hi' }), { reply: toTeam })).toBe(
        `**contrib123** ↩ @_**|8** [said](${LINK}): hi`,
      );
      const toContributor = { origin: 'discord' as const, discordAuthorId: CONTRIBUTOR, authorName: '*A*', link: LINK };
      expect(mirror(message({ content: 'hi' }), { reply: toContributor })).toBe(
        `**contrib123** ↩ **&#42;A&#42;** [said](${LINK}): hi`,
      );
    });

    it('should name the author of an unmirrored message without a link', () => {
      expect(mirror(message({ content: 'hi' }), { reply: { origin: 'unmirrored', authorName: 'Alex' } })).toBe(
        '**contrib123** ↩ **Alex**: hi',
      );
      expect(mirror(message({ content: 'hi' }), { reply: { origin: 'unmirrored', authorName: null } })).toBe(
        '**contrib123** ↩ **someone**: hi',
      );
    });

    it('should quote the message replied to in the lead', () => {
      const header = zulipAuthorHeader(message(), { ...ctx, reply: { origin: 'unmirrored', authorName: 'Alex' } });
      const lead = zulipMirrorLead(header, toZulipReplySnippet('their <@222222222222222222> point', ctx));
      expect(zulipMirrorContent(lead, toZulipMirrorBody(message({ content: 'mine' }), ctx), '')).toBe(
        '**contrib123** ↩ **Alex**:\n~~~ quote\ntheir @_**|8** point\n~~~\nmine',
      );
    });

    it('should cut the quote to 200 code points without exposing what was code', () => {
      const snippet = toZulipReplySnippet(`${'x'.repeat(185)} \`a @**all** b\` and more`, ctx);
      expect(snippet).toBe(`${'x'.repeat(185)} \`a @**all**...`);
      const content = zulipMirrorContent(zulipMirrorLead('**contrib123**', snippet), 'mine', '');
      expect(content).toBe(`**contrib123**:\n~~~ quote\n${'x'.repeat(185)} \`a @${ZWSP}**all**...\n~~~\nmine`);
    });
  });
});

describe('toZulipMirrorBody', () => {
  describe('neutralising Zulip syntax', () => {
    it.each(['@**all**', '@_**all**', '@**everyone**', '@*team*', '@_*team*', '#**immich-alerts>x**', '#**s>t@5**'])(
      'should neutralise %s outside code',
      (syntax) => {
        expect(body(`hey ${syntax} there`)).toBe(`hey ${syntax[0]}${ZWSP}${syntax.slice(1)} there`);
      },
    );

    it('should leave fenced and inline code byte-identical', () => {
      const code = '```sh\necho ${file#*.} @**all** #**immich-alerts** <@222222222222222222> [a](/b)\n```';
      expect(body(`${code}\nand \`\${file#*.} @**all**\` ~~~ inline`)).toBe(
        `${code}\nand \`\${file#*.} @**all**\` ~~~ inline`,
      );
      expect(body('~~~\n@**all**\n~~~')).toBe('~~~\n@**all**\n~~~');
    });

    it('should defuse every link a contributor writes in Zulip syntax', () => {
      expect(body('[x](/user_uploads/1/a/b/c.txt "t") [y]( #narrow/channel/1 ) ![z](/r) [w](<#narrow/x>)')).toBe(
        '&#91;x&#93;(/user_uploads/1/a/b/c.txt "t") y !z w',
      );
      expect(body('a [b] c](/x) [d')).toBe('a &#91;b&#93; c&#93;(/x) &#91;d');
    });

    it('should keep a contributor from smuggling in the markers of the mirror', () => {
      expect(body('\uE000@**all**\uE001 [x](/y) a\0b')).toBe(`\uFFFD@${ZWSP}**all**\uFFFD x a\uFFFDb`);
    });

    it('should leave @everyone and @here, which are not Zulip syntax', () => {
      expect(body('@everyone @here')).toBe('@everyone @here');
    });
  });

  describe('Discord syntax', () => {
    it.each([
      { content: '<@222222222222222222>', silent: false, expected: '@**|8**' },
      { content: '<@!222222222222222222>', silent: false, expected: '@**|8**' },
      { content: '<@222222222222222222>', silent: true, expected: '@_**|8**' },
    ])('should mention a verified team member for $content, silent: $silent', ({ content, silent, expected }) => {
      expect(body(`hi ${content} ok`, { silent })).toBe(`hi ${expected} ok`);
    });

    it('should write other mentions as escaped text', () => {
      expect(body('<@333333333333333333> <@666666666666666666> <@&444444444444444444> <@&777777777777777777>')).toBe(
        '&#64;Alex &#64;unknown-user &#64;Core &#64;unknown-role',
      );
      expect(
        body('<#555555555555555555> <#888888888888888888>', {
          mentions: { users: {}, roles: {}, channels: { [CHANNEL]: 'dev_ops' } },
        }),
      ).toBe('&#35;dev&#95;ops &#35;unknown-channel');
    });

    it('should put a space before a mention Zulip would not render after the character before it', () => {
      expect(body('cc,<@222222222222222222> (<@222222222222222222>)')).toBe('cc, @**|8** (@**|8**)');
    });

    it('should map custom emotes to the names emote sync gives them', () => {
      expect(body('<:catJam:123456789012345678> <a:party_parrot_:123456789012345678>')).toBe(':catjam: :party_parrot:');
    });

    it('should turn timestamps into Zulip times', () => {
      expect(body('<t:1700000000> <t:1700000000:R> <t:9999999999999:R>')).toBe(
        '<time:2023-11-14T22:13:20.000Z> <time:2023-11-14T22:13:20.000Z> <t:9999999999999:R>',
      );
    });

    it('should turn a slash command mention into its name', () => {
      expect(body('try </release notes:123456789012345678>')).toBe('try /release notes');
    });

    it('should drop -# at the start of a line only', () => {
      expect(body('-# small\nnot -# this\n```\n-# code\n```')).toBe('small\nnot -# this\n```\n-# code\n```');
    });

    it('should unwrap links that suppress their embed', () => {
      expect(body('see <https://github.com/immich-app/immich>')).toBe('see https://github.com/immich-app/immich');
    });

    it('should keep http links, with a neutralised label and a target Zulip cannot read into', () => {
      expect(body('[@**all** [x]](<https://ex.com/a b>) [c\\](https://ex.com/@**all**_(x)$$y$$)')).toBe(
        `[@${ZWSP}**all** &#91;x&#93;](https://ex.com/a%20b) [c&#92;](https://ex.com/@%2A%2Aall%2A%2A_%28x%29%24%24y%24%24)`,
      );
    });

    it('should leave a link whose label holds code to the final pass, which defuses it', () => {
      expect(body('[`c`](https://ex.com/@**all**)')).toBe(`&#91;\`c\`&#93;(https://ex.com/@${ZWSP}**all**)`);
    });

    it('should keep only the label of any other link', () => {
      expect(
        body('[a](/user_uploads/1/a/b/c.txt) [b](#narrow/channel/1) [c](javascript:alert(1)) [](https://x.y)'),
      ).toBe('a b c https://x.y');
    });

    it('should wrap a message with a spoiler in a spoiler block', () => {
      expect(body('look ||the butler|| did it')).toBe('~~~ spoiler Spoiler\nlook the butler did it\n~~~');
      expect(body('||```\ncode\n```||')).toBe('~~~ spoiler Spoiler\n```\ncode\n```\n~~~');
      expect(body('||a~~~~b||')).toBe('~~~~~ spoiler Spoiler\na~~~~b\n~~~~~');
      expect(body('a || b')).toBe('a || b');
      expect(body('`||x||`')).toBe('`||x||`');
    });

    it('should quote everything from a >>> line on', () => {
      expect(body('mine\n>>> quoted @**all**\nstill quoted')).toBe(
        `mine\n~~~ quote\nquoted @${ZWSP}**all**\nstill quoted\n~~~`,
      );
      expect(body('>>> -# all quoted')).toBe('~~~ quote\nall quoted\n~~~');
      expect(body('> -# quoted')).toBe('> quoted');
      expect(body('not >>> quoted')).toBe('not >>> quoted');
      expect(body('```\n>>> code\n```')).toBe('```\n>>> code\n```');
    });

    it('should translate inside the >>> quote and the spoiler together', () => {
      expect(body('||secret||\n>>> <@222222222222222222>')).toBe(
        '~~~~ spoiler Spoiler\nsecret\n~~~ quote\n@**|8**\n~~~\n~~~~',
      );
    });
  });

  describe('other message parts', () => {
    it('should list stickers, the poll and forwarded messages after the text', () => {
      const dto = message({
        content: 'look',
        stickers: ['Wave *'],
        poll: 'Lunch @**all**?',
        forwarded: ['fwd <@222222222222222222> @**all**', ''],
      });
      expect(mirror(dto)).toBe(
        [
          '**contrib123**: look',
          '*&#91;sticker: Wave &#42;&#93;*',
          '*&#91;poll: Lunch &#64;&#42;&#42;all&#42;&#42;?&#93;*',
          '*&#91;forwarded message&#93;*',
          '~~~ quote',
          `fwd @_**|8** @${ZWSP}**all**`,
          '~~~',
          '*&#91;forwarded message&#93;*',
        ].join('\n'),
      );
    });

    it('should give an empty message an empty body, which the mirror skips', () => {
      expect(toZulipMirrorBody(message({ content: '' }), ctx)).toBe('');
      expect(toZulipMirrorBody(message({ content: '-# ' }), ctx)).toBe('');
    });
  });
});

describe('toZulipAttachmentLines', () => {
  it('should link uploads, strip brackets from the names, and list spoilers in a spoiler block', () => {
    const lines = toZulipAttachmentLines(
      [
        { name: 'screen [1].png', spoiler: false, url: '/user_uploads/2/ab/xyz/screen-1.png' },
        { name: 'SPOILER_plot.png', spoiler: true, url: '/user_uploads/2/cd/uvw/SPOILER_plot.png' },
        { name: 'huge @**all**.mp4', spoiler: false, url: null },
        { name: 'SPOILER_x.bin', spoiler: true, url: null },
      ],
      JUMP_URL,
    );
    expect(zulipMirrorContent('**contrib123**', '', lines)).toBe(
      [
        '**contrib123**: [screen 1.png](/user_uploads/2/ab/xyz/screen-1.png)',
        `*(attachment not mirrored: huge &#64;&#42;&#42;all&#42;&#42;.mp4, see [Discord](${JUMP_URL}))*`,
        '~~~ spoiler Spoiler',
        '[SPOILER_plot.png](/user_uploads/2/cd/uvw/SPOILER_plot.png)',
        `*(attachment not mirrored: SPOILER&#95;x.bin, see [Discord](${JUMP_URL}))*`,
        '~~~',
      ].join('\n'),
    );
  });

  it('should keep a label from ending the link early', () => {
    const lines = toZulipAttachmentLines(
      [{ name: 'a`b\\c @**all**', spoiler: false, url: '/user_uploads/1/a/b/c' }],
      '',
    );
    expect(zulipMirrorContent('**x**', 'hi', lines)).toBe(
      `**x**: hi\n[a&#96;b&#92;c @${ZWSP}**all**](/user_uploads/1/a/b/c)`,
    );
  });

  it('should list nothing without attachments', () => {
    expect(toZulipAttachmentLines([], JUMP_URL)).toBe('');
  });
});

describe('zulipMirrorContent', () => {
  it.each([
    '```\nx\n```',
    '~~~\nx\n~~~',
    '> q',
    '# h',
    '- a',
    '* a',
    '+ a',
    '1. a',
    '2) a',
    '| a |',
    '    code',
    '\tcode',
  ])('should start a body that opens with block syntax on a line of its own: %j', (content) => {
    expect(zulipMirrorContent('**x**', content, '')).toBe(`**x**:\n${content}`);
  });

  it('should put an inline body on the header line', () => {
    expect(zulipMirrorContent('**x**', 'hello', '')).toBe('**x**: hello');
    expect(zulipMirrorContent('**x**', '', '')).toBe('**x**: ');
  });

  it('should rebuild an edit from the stored lead and attachments', () => {
    const header = zulipAuthorHeader(message(), { ...ctx, reply: { origin: 'unmirrored', authorName: 'Alex' } });
    const lead = zulipMirrorLead(header, toZulipReplySnippet('x', ctx));
    const attachments = toZulipAttachmentLines(
      [{ name: 'a.png', spoiler: false, url: '/user_uploads/1/a/b/a.png' }],
      '',
    );
    expect(zulipMirrorContent(lead, toZulipMirrorBody(message({ content: 'edited' }), ctx), attachments)).toBe(
      '**contrib123** ↩ **Alex**:\n~~~ quote\nx\n~~~\nedited\n[a.png](/user_uploads/1/a/b/a.png)',
    );
  });

  it('should cut to the Zulip message limit and neutralise what the cut exposes', () => {
    const content = zulipMirrorContent('**x**', `${'y'.repeat(ZULIP_MAX_MESSAGE_LENGTH - 20)} \`@**all**\` tail`, '');
    expect([...content]).toHaveLength(ZULIP_MAX_MESSAGE_LENGTH);
    expect(content.endsWith(`\`@${ZWSP}**all*...`)).toBe(true);
  });

  it('should cut short enough that the neutralised message still fits', () => {
    const content = zulipMirrorContent('**x**', '[]'.repeat(ZULIP_MAX_MESSAGE_LENGTH), '');
    expect([...content].length).toBeLessThanOrEqual(ZULIP_MAX_MESSAGE_LENGTH);
    expect(content).toMatch(/^\*\*x\*\*: (&#91;&#93;)+(&#91;)?\.\.\.$/);
  });

  it('should drop a marker the cut leaves unclosed', () => {
    const body = toZulipMirrorBody(
      message({ content: `${'y'.repeat(ZULIP_MAX_MESSAGE_LENGTH - 15)} <@222222222222222222>` }),
      ctx,
    );
    const content = zulipMirrorContent('**x**', body, '');
    expect(content).not.toMatch(/[\uE000-\uE002]/);
    expect(content.endsWith(`@${ZWSP}**...`)).toBe(true);
  });
});

describe('discordSourceHash', () => {
  const hash = (overrides: Partial<DiscordSourceMessage>) => discordSourceHash(message({ content: 'x', ...overrides }));

  it('should change with the content, stickers, poll and forwarded messages', () => {
    const base = hash({});
    expect(hash({})).toBe(base);
    expect(base).toMatch(/^[\da-f]{64}$/);
    for (const change of [{ content: 'y' }, { stickers: ['s'] }, { poll: 'q' }, { forwarded: ['f'] }]) {
      expect(hash(change)).not.toBe(base);
    }
  });

  it('should ignore attachments, embeds and flags', () => {
    const attachments = [{ id: '1', name: 'a', url: 'u', size: 1, contentType: null, spoiler: false }];
    expect(hash({ attachments, silent: true })).toBe(hash({}));
  });
});
