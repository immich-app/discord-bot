import { NotificationAccent, NotificationKind } from 'src/interfaces/notification.interface';
import { Palette } from 'src/renderers/palette';
import { Emoji, neutraliseLabel, neutraliseMentions, toZulipMessage } from 'src/renderers/zulip.renderer';
import { describe, expect, it } from 'vitest';

const author = { name: 'octocat', url: 'https://github.com/octocat', iconUrl: 'https://example.com/a.png' };
const fields = [
  { name: 'Revenue', value: '1 USD', inline: true },
  { name: 'Profit', value: '0.5 USD', inline: true },
];

const DiscordOnly = [/<a?:\w+:\d+>/, /__/, /(^|\s)_\S[^_]*\S_(\s|$)/];

describe('toZulipMessage', () => {
  it('should render a feed item as an emoji, a bold title link, the author and a quoted body', () => {
    expect(
      toZulipMessage({
        kind: 'feed',
        accent: 'pr.merged',
        author,
        title: '[immich-app/immich] Pull request merged: #1 Fix thing',
        url: 'https://github.com/immich-app/immich/pull/1',
        body: 'Body',
      }),
    ).toBe(
      [
        '🔀 **[[immich-app/immich] Pull request merged: #1 Fix thing](https://github.com/immich-app/immich/pull/1)** — [octocat](https://github.com/octocat)',
        '~~~ quote',
        'Body',
        '~~~',
      ].join('\n'),
    );
  });

  it('should render a feed item without a body as the heading alone', () => {
    expect(toZulipMessage({ kind: 'feed', accent: 'issue.closed', title: 'Issue closed', url: 'https://x/1' })).toBe(
      '✅ **[Issue closed](https://x/1)**',
    );
  });

  it('should render a release with its one-line slogan body inline, not quoted', () => {
    expect(
      toZulipMessage({
        kind: 'release',
        author,
        title: '[immich-app/immich] New release: v2.4.0',
        url: 'https://github.com/immich-app/immich/releases/tag/v2.4.0',
        body: '🎉 Release time! 🚀',
      }),
    ).toBe(
      [
        '**[[immich-app/immich] New release: v2.4.0](https://github.com/immich-app/immich/releases/tag/v2.4.0)** — [octocat](https://github.com/octocat)',
        '🎉 Release time! 🚀',
      ].join('\n'),
    );
  });

  it('should render a release without a body as the heading alone', () => {
    expect(toZulipMessage({ kind: 'release', author, title: 'New release: v1.0.0', url: 'https://x/r' })).toBe(
      '**[New release: v1.0.0](https://x/r)** — [octocat](https://github.com/octocat)',
    );
  });

  it('should shorten a release body to 500 characters as insurance, like Mattermost', () => {
    expect(toZulipMessage({ kind: 'release', title: 'T', url: 'https://x/r', body: 'y'.repeat(600) })).toBe(
      `**[T](https://x/r)**\n${'y'.repeat(497)}...`,
    );
  });

  it('should not shorten a feed body: the service already did', () => {
    const message = toZulipMessage({ kind: 'feed', title: 'T', url: 'https://x', body: 'y'.repeat(600) });
    expect(message).toContain('y'.repeat(600));
  });

  it('should render an incident without a body and each field as a bold name over its quoted value', () => {
    expect(
      toZulipMessage({
        kind: 'incident',
        accent: 'incident.major',
        author: { name: 'GitHub Status', url: 'https://githubstatus.com' },
        title: 'Major outage',
        url: 'https://x/i',
        body: 'ignored',
        fields: [{ name: 'Incident with Actions', value: 'We are investigating.\nNext update in 30 minutes.' }],
      }),
    ).toBe(
      [
        '🚨 **[Major outage](https://x/i)** — [GitHub Status](https://githubstatus.com)',
        '**Incident with Actions**',
        '~~~ quote',
        'We are investigating.',
        'Next update in 30 minutes.',
        '~~~',
      ].join('\n'),
    );
  });

  it('should render a purchase with its body inline and one line per field', () => {
    expect(
      toZulipMessage({
        kind: 'purchase',
        accent: 'purchase.live',
        author: { name: 'Stripe', url: 'https://stripe.com' },
        title: 'Immich server product key purchased',
        url: 'https://x/p',
        body: 'Price: 100 USD',
        fields,
      }),
    ).toBe(
      [
        '💰 **[Immich server product key purchased](https://x/p)** — [Stripe](https://stripe.com)',
        'Price: 100 USD',
        '**Revenue:** 1 USD',
        '**Profit:** 0.5 USD',
      ].join('\n'),
    );
  });

  it('should render a report with a plain bold title, its body inline and one line per field', () => {
    expect(
      toZulipMessage({
        kind: 'report',
        accent: 'report.orders',
        title: 'Daily orders report for 2026-09-21',
        url: 'https://ignored',
        body: 'Revenue: 1 USD; Profit: 0.5 USD',
        fields,
      }),
    ).toBe(
      [
        '📦 **Daily orders report for 2026-09-21**',
        'Revenue: 1 USD; Profit: 0.5 USD',
        '**Revenue:** 1 USD',
        '**Profit:** 0.5 USD',
      ].join('\n'),
    );
  });

  it('should render an alert with a plain bold title and its body inline', () => {
    expect(
      toZulipMessage({
        kind: 'alert',
        accent: 'release.failed',
        title: 'Release Workflow Failed',
        body: '[Release v1.2.0](https://github.com/immich-app/immich/actions/runs/1)',
      }),
    ).toBe('🚨 **Release Workflow Failed**\n[Release v1.2.0](https://github.com/immich-app/immich/actions/runs/1)');
  });

  it('should render purchase and report fields identically', () => {
    const lines = (kind: NotificationKind) => toZulipMessage({ kind, title: 'T', fields }).split('\n').slice(1);
    expect(lines('purchase')).toEqual(['**Revenue:** 1 USD', '**Profit:** 0.5 USD']);
    expect(lines('report')).toEqual(lines('purchase'));
  });

  it('should link a feed, release, incident and purchase title even when the url is empty or missing', () => {
    for (const kind of ['feed', 'release', 'incident', 'purchase'] as const) {
      expect(toZulipMessage({ kind, title: 'T', url: '' }), kind).toBe('**[T]()**');
      expect(toZulipMessage({ kind, title: 'T' }), kind).toBe('**[T](undefined)**');
    }
  });

  it('should never link a report or alert title', () => {
    for (const kind of ['report', 'alert'] as const) {
      expect(toZulipMessage({ kind, title: 'T', url: 'https://example.com' }), kind).toBe('**T**');
    }
  });

  it('should attribute every kind the same way, without an avatar', () => {
    for (const kind of ['feed', 'release', 'incident', 'purchase', 'report', 'alert'] as const) {
      expect(toZulipMessage({ kind, author, title: 'T', url: 'https://x' }), kind).toMatch(
        /^\*\*.*\*\* — \[octocat\]\(https:\/\/github\.com\/octocat\)$/,
      );
    }
  });

  it('should ignore the body of an incident', () => {
    expect(toZulipMessage({ kind: 'incident', title: 'T', url: 'https://x', body: 'ignored' })).toBe(
      '**[T](https://x)**',
    );
  });

  it('should start with no emoji without an accent', () => {
    expect(toZulipMessage({ kind: 'feed', title: 'T', url: 'https://x' })).toBe('**[T](https://x)**');
  });

  describe('accents', () => {
    it('should map every accent to an emoji', () => {
      expect(Object.keys(Emoji).sort()).toEqual(Object.keys(Palette).sort());
    });

    it.each(Object.keys(Emoji) as NotificationAccent[])('should lead with the emoji for %s', (accent) => {
      const message = toZulipMessage({ kind: 'feed', accent, title: 'T', url: 'https://x' });
      expect(message).toBe(`${Emoji[accent]} **[T](https://x)**`);
      expect(Emoji[accent]).toMatch(/^\p{Extended_Pictographic}/u);
    });

    it('should distinguish an outcome from its opposite', () => {
      expect(Emoji['pr.merged']).not.toBe(Emoji['pr.closed']);
      expect(Emoji['issue.opened']).not.toBe(Emoji['issue.closed']);
      expect(Emoji['order.placed']).not.toBe(Emoji['order.cancelled']);
      expect(Emoji['incident.resolved']).not.toBe(Emoji['incident.major']);
      expect(Emoji['purchase.live']).not.toBe(Emoji['purchase.test']);
    });
  });

  describe('markdown', () => {
    const rich = (kind: NotificationKind) =>
      toZulipMessage({
        kind,
        accent: 'release.failed',
        author,
        title: 'Release Workflow Failed',
        url: 'https://x',
        body: 'Body with *emphasis* and **bold**',
        fields,
      });

    it.each(['feed', 'release', 'incident', 'purchase', 'report', 'alert'] as const)(
      'should emit no Discord-only markdown for %s',
      (kind) => {
        for (const pattern of DiscordOnly) {
          expect(rich(kind)).not.toMatch(pattern);
        }
      },
    );

    it('should never carry the Discord alert emoji into an alert', () => {
      const message = toZulipMessage({ kind: 'alert', accent: 'release.failed', title: 'Release Workflow Failed' });
      expect(message).not.toContain('peepoAlert');
      expect(message).not.toMatch(/<a?:/);
    });

    it('should quote with tildes so a backtick code fence in the body nests instead of closing the quote', () => {
      const message = toZulipMessage({ kind: 'feed', title: 'T', url: 'https://x', body: '```ts\nconst a = 1;\n```' });
      expect(message).toBe('**[T](https://x)**\n~~~ quote\n```ts\nconst a = 1;\n```\n~~~');
    });

    it('should fence the quote with more tildes than any run in the body, so no body line can close it', () => {
      const body = '~~~\n# Escaped heading\n@**all** hi\n~~~~~\nmore';
      const message = toZulipMessage({ kind: 'feed', title: 'T', url: 'https://x', body });
      const lines = message.split('\n');
      expect(lines[1]).toBe('~~~~~~ quote');
      expect(lines.at(-1)).toBe('~~~~~~');
      expect(lines.slice(2, -1)).toEqual(['~~~', '# Escaped heading', '@\u200B**all** hi', '~~~~~', 'more']);
    });

    it('should use the shortest fence when the body has fewer than three tildes in a row', () => {
      const message = toZulipMessage({ kind: 'feed', title: 'T', url: 'https://x', body: 'a ~~ b' });
      expect(message).toBe('**[T](https://x)**\n~~~ quote\na ~~ b\n~~~');
    });

    it('should lengthen the fence when a body line is exactly the default fence', () => {
      const message = toZulipMessage({ kind: 'feed', title: 'T', url: 'https://x', body: '~~~' });
      expect(message).toBe('**[T](https://x)**\n~~~~ quote\n~~~\n~~~~');
    });

    it('should separate every part with a single newline, which Zulip renders as a line break', () => {
      const message = toZulipMessage({ kind: 'purchase', title: 'T', url: 'https://x', body: 'B', fields });
      expect(message.split('\n')).toHaveLength(4);
      expect(message).not.toContain('\n\n');
    });
  });

  describe('injection', () => {
    const Mentions = [
      '@**all**',
      '@**everyone**',
      '@**Full Name**',
      '@**Full Name|42**',
      '@_**Full Name**',
      '@*admins*',
      '@_*admins*',
      '#**general**',
      '#**general>topic**',
    ];
    const ZulipMention = /[@#]_?\*/;

    it.each(Mentions)('should neutralise %s with a zero-width space after the sigil', (mention) => {
      expect(neutraliseMentions(mention)).toBe(`${mention[0]}\u200B${mention.slice(1)}`);
      expect(neutraliseMentions(mention)).not.toMatch(ZulipMention);
    });

    it('should leave text without mention syntax untouched', () => {
      for (const text of ['a@b.c', 'issue #12', '@octocat', '**bold**', 'x * y', '#hashtag', '']) {
        expect(neutraliseMentions(text), text).toBe(text);
      }
    });

    it('should neutralise a mention in a GitHub title', () => {
      const message = toZulipMessage({
        kind: 'feed',
        title: '[immich-app/immich] Issue opened: #1 @**all** look',
        url: 'https://x',
      });
      expect(message).toBe('**[[immich-app/immich] Issue opened: #1 @\u200B**all** look](https://x)**');
    });

    it('should neutralise a mention in a merch order message field', () => {
      const message = toZulipMessage({
        kind: 'purchase',
        title: 'Immich merch purchased',
        url: 'https://x',
        fields: [{ name: 'Message', value: 'thanks @*admins* #**general**' }],
      });
      expect(message.split('\n')[1]).toBe('**Message:** thanks @\u200B*admins* #\u200B**general**');
    });

    it('should neutralise a mention in an incident update, name and value alike', () => {
      const message = toZulipMessage({
        kind: 'incident',
        title: 'T',
        url: 'https://x',
        fields: [{ name: 'Incident @**all**', value: 'Investigating.\ncc @_**Full Name**' }],
      });
      expect(message.split('\n').slice(1)).toEqual([
        '**Incident @\u200B**all****',
        '~~~ quote',
        'Investigating.',
        'cc @\u200B_**Full Name**',
        '~~~',
      ]);
    });

    it('should neutralise a mention in a quoted body, an inline body and an author name', () => {
      expect(toZulipMessage({ kind: 'feed', title: 'T', url: 'https://x', body: 'hi @**all**' })).toContain(
        '\nhi @\u200B**all**\n',
      );
      expect(toZulipMessage({ kind: 'alert', title: 'T', body: '[@**all**](https://x)' })).toContain(
        '[@\u200B**all**](https://x)',
      );
      expect(
        toZulipMessage({ kind: 'feed', title: 'T', url: 'https://x', author: { name: '@**all**', url: 'https://a' } }),
      ).toContain('— [@\u200B**all**](https://a)');
    });

    it('should never emit mention syntax for any kind', () => {
      for (const kind of ['feed', 'release', 'incident', 'purchase', 'report', 'alert'] as const) {
        const message = toZulipMessage({
          kind,
          author: { name: '@**a**', url: 'https://a' },
          title: '@**t**',
          url: 'https://x',
          body: '@**b**',
          fields: [{ name: '@**n**', value: '@**v**' }],
        });
        expect(message, kind).not.toMatch(ZulipMention);
      }
    });

    describe('link labels', () => {
      const LabelBreak = /\][([]/;
      const forged = '[immich-app/immich] Issue opened: #99 Crash on upload](https://evil.example/phish) [';

      it('should put a zero-width space between a `]` and a following `(` or `[`, so a smuggled pair cannot close the label', () => {
        expect(neutraliseLabel('a](https://evil) [b')).toBe('a]\u200B(https://evil) [b');
        expect(neutraliseLabel('a][ref]')).toBe('a]\u200B[ref]');
        expect(neutraliseLabel('a](https://evil) [b')).not.toMatch(LabelBreak);
      });

      it('should neutralise mentions as well, since a label gets no other pass', () => {
        expect(neutraliseLabel('@**all**](x)')).toBe('@\u200B**all**]\u200B(x)');
      });

      it('should leave every other `]` alone, so a bracketed title reads and copies as written', () => {
        for (const text of [
          'octocat',
          'Fix [BUG] thumbnails',
          '[immich-app/immich] Fix thing',
          'Fix [thing',
          'x (y)',
          '',
        ]) {
          expect(neutraliseLabel(text), text).toBe(text);
        }
      });

      it('should render a title with a plain [BUG] prefix unchanged inside the heading link', () => {
        expect(toZulipMessage({ kind: 'feed', title: 'Fix [BUG] thumbnails', url: 'https://x' })).toBe(
          '**[Fix [BUG] thumbnails](https://x)**',
        );
        expect(toZulipMessage({ kind: 'report', title: '[BUG] report' })).toBe('**[BUG] report**');
      });

      it('should not let a GitHub title repoint the heading link', () => {
        const message = toZulipMessage({
          kind: 'feed',
          accent: 'issue.opened',
          author,
          title: forged,
          url: 'https://github.com/immich-app/immich/issues/99',
        });
        expect(message).toBe(
          '🆕 **[[immich-app/immich] Issue opened: #99 Crash on upload]\u200B(https://evil.example/phish) [](https://github.com/immich-app/immich/issues/99)** — [octocat](https://github.com/octocat)',
        );
        expect(message).not.toContain('](https://evil.example/phish)');
      });

      it('should not let an author name repoint the author link', () => {
        const message = toZulipMessage({
          kind: 'feed',
          title: 'T',
          url: 'https://x',
          author: { name: 'octocat](https://evil.example/phish) [', url: 'https://github.com/octocat' },
        });
        expect(message).toBe(
          '**[T](https://x)** — [octocat]\u200B(https://evil.example/phish) [](https://github.com/octocat)',
        );
      });

      it('should only ever emit the label break the renderer wrote itself, for every kind', () => {
        for (const kind of ['feed', 'release', 'incident', 'purchase', 'report', 'alert'] as const) {
          const message = toZulipMessage({
            kind,
            author: { name: 'a](https://evil) [', url: 'https://a' },
            title: 't](https://evil) [',
            url: 'https://x',
          });
          const breaks = [...message.matchAll(/\]\((\S*?)\)/g)].map(([, url]) => url);
          expect(breaks, kind).toEqual(
            kind === 'report' || kind === 'alert' ? ['https://a'] : ['https://x', 'https://a'],
          );
          expect(message, kind).not.toContain('](https://evil');
        }
      });

      it('should leave a body and a field value alone: they are not link labels', () => {
        const body = '[Release v1.2.0](https://github.com/immich-app/immich/actions/runs/1)';
        expect(toZulipMessage({ kind: 'alert', title: 'T', body })).toBe(`**T**\n${body}`);
        expect(toZulipMessage({ kind: 'feed', title: 'T', url: 'https://x', body: 'see [a](https://b)' })).toContain(
          '\nsee [a](https://b)\n',
        );
        expect(
          toZulipMessage({
            kind: 'purchase',
            title: 'T',
            url: 'https://x',
            fields: [{ name: 'n]', value: 'v](https://b)' }],
          }),
        ).toContain('\n**n]:** v](https://b)');
      });

      it('should neutralise a plain bold title too, so a report or alert heading cannot carry a forged link', () => {
        for (const kind of ['report', 'alert'] as const) {
          expect(toZulipMessage({ kind, title: '[a](https://evil)' }), kind).toBe('**[a]\u200B(https://evil)**');
        }
      });
    });

    describe('field values', () => {
      it('should keep a merch order message on its line: a fence, heading or fake field in it never starts a line', () => {
        const message = toZulipMessage({
          kind: 'purchase',
          title: 'Immich merch purchased',
          url: 'https://x',
          fields: [
            {
              name: 'Message',
              value: 'thanks **a lot**\n```\n# not a heading\n```\n**Revenue:** 1000000 USD @**all**',
            },
            { name: 'Revenue', value: '1 USD' },
          ],
        });
        expect(message.split('\n').slice(1)).toEqual([
          '**Message:** thanks **a lot** ``` # not a heading ``` **Revenue:** 1000000 USD @\u200B**all**',
          '**Revenue:** 1 USD',
        ]);
      });

      it('should collapse every line break in a line value, with the whitespace around it, to one space', () => {
        const message = toZulipMessage({
          kind: 'purchase',
          title: 'T',
          url: 'https://x',
          fields: [{ name: 'Message', value: 'a \r\n\r\n b\n  c\rd' }],
        });
        expect(message.split('\n')[1]).toBe('**Message:** a b c d');
      });

      it('should quote an incident update like a feed body, so a fence in it cannot swallow the message', () => {
        const message = toZulipMessage({
          kind: 'incident',
          title: 'T',
          url: 'https://x',
          fields: [{ name: 'Update', value: 'Investigating.\n~~~\n# heading\n**Fake:** field @**all**' }],
        });
        expect(message.split('\n').slice(1)).toEqual([
          '**Update**',
          '~~~~ quote',
          'Investigating.',
          '~~~',
          '# heading',
          '**Fake:** field @\u200B**all**',
          '~~~~',
        ]);
      });

      it('should keep a field name on one line in either layout', () => {
        const name = 'Incident\n~~~\nname';
        expect(toZulipMessage({ kind: 'purchase', title: 'T', url: 'https://x', fields: [{ name, value: 'v' }] })).toBe(
          '**[T](https://x)**\n**Incident ~~~ name:** v',
        );
        expect(toZulipMessage({ kind: 'incident', title: 'T', url: 'https://x', fields: [{ name, value: 'v' }] })).toBe(
          '**[T](https://x)**\n**Incident ~~~ name**\n~~~ quote\nv\n~~~',
        );
      });
    });
  });
});
