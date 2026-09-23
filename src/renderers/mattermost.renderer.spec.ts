import { toMattermostBlock } from 'src/renderers/mattermost.renderer';
import { describe, expect, it } from 'vitest';

const author = { name: 'octocat', url: 'https://github.com/octocat', iconUrl: 'https://example.com/a.png' };

const avatarBlock = (name: string, url: string | undefined, iconUrl: string | undefined) => ({
  type: 'container',
  gap: 'small',
  flow: 'horizontal',
  content: [
    {
      type: 'image',
      url: iconUrl,
      alt_text: `${name}'s avatar`,
      size: 'small',
      image_style: 'person',
      horizontal_alignment: 'left',
      max_width: 26,
    },
    { type: 'text', text: `[${name}](${url})`, is_subtle: true },
  ],
});

describe('toMattermostBlock', () => {
  it('should render a feed item with a small title and its body', () => {
    expect(
      toMattermostBlock({
        kind: 'feed',
        accent: 'issue.opened',
        author,
        title: 'Issue opened',
        url: 'https://example.com/1',
        body: 'Body',
      }),
    ).toEqual({
      type: 'container',
      accent_color: '#57f287',
      border: true,
      gap: 'small',
      content: [
        avatarBlock('octocat', 'https://github.com/octocat', 'https://example.com/a.png'),
        { type: 'text', text: '##### [Issue opened](https://example.com/1)', size: 'small' },
        { type: 'text', text: 'Body' },
      ],
    });
  });

  it('should render an incident author as a small subtle text line', () => {
    const { content } = toMattermostBlock({
      kind: 'incident',
      author: { name: 'GitHub Status', url: 'https://githubstatus.com' },
      title: 'Outage',
    }) as { content: unknown[] };
    expect(content[0]).toEqual({
      type: 'text',
      text: '[GitHub Status](https://githubstatus.com)',
      is_subtle: true,
      size: 'small',
    });
  });

  it('should leave an empty body slot on a feed item without a body', () => {
    const { content } = toMattermostBlock({ kind: 'feed', title: 'Issue closed', url: 'https://example.com/1' }) as {
      content: unknown[];
    };
    expect(content).toEqual([
      { type: 'text', text: '##### [Issue closed](https://example.com/1)', size: 'small' },
      undefined,
    ]);
  });

  it('should link a feed, release, incident and purchase title even when the url is empty or missing', () => {
    for (const kind of ['feed', 'release', 'incident', 'purchase'] as const) {
      const empty = toMattermostBlock({ kind, title: 'T', url: '' }) as { content: Array<{ text: string }> };
      expect(empty.content[0].text, kind).toBe('##### [T]()');

      const missing = toMattermostBlock({ kind, title: 'T' }) as { content: Array<{ text: string }> };
      expect(missing.content[0].text, kind).toBe('##### [T](undefined)');
    }
  });

  it('should never link a report or alert title', () => {
    for (const kind of ['report', 'alert'] as const) {
      const { content } = toMattermostBlock({ kind, title: 'T', url: 'https://example.com' }) as {
        content: Array<{ text: string }>;
      };
      expect(content[0], kind).toEqual({ type: 'text', text: 'T' });
    }
  });

  it('should shorten a release body to 500 characters and render it small', () => {
    const { content } = toMattermostBlock({
      kind: 'release',
      title: 'Release',
      url: 'https://example.com/r',
      body: 'y'.repeat(600),
    }) as { content: Array<{ text?: string; size?: string }> };
    expect(content[0]).toEqual({ type: 'text', text: '##### [Release](https://example.com/r)' });
    expect(content[1]).toEqual({ type: 'text', text: 'y'.repeat(497) + '...', size: 'small' });
  });

  it('should leave an empty body slot on a release without a body', () => {
    const { content } = toMattermostBlock({ kind: 'release', title: 'Release', url: 'https://example.com/r' }) as {
      content: unknown[];
    };
    expect(content).toEqual([{ type: 'text', text: '##### [Release](https://example.com/r)' }, undefined]);
  });

  it('should render an incident without a body slot and with plain text fields', () => {
    const { content } = toMattermostBlock({
      kind: 'incident',
      title: 'Outage',
      url: 'https://example.com/i',
      body: 'ignored',
      fields: [{ name: 'Incident', value: 'Details' }],
    }) as { content: unknown[] };
    expect(content).toEqual([
      { type: 'text', text: '##### [Outage](https://example.com/i)' },
      { type: 'text', text: '**Incident**' },
      { type: 'text', text: 'Details' },
    ]);
  });

  it('should render purchase fields as a divider and column set', () => {
    const { content } = toMattermostBlock({
      kind: 'purchase',
      title: 'Purchase',
      url: 'https://example.com/p',
      body: 'Price: 1 USD',
      fields: [{ name: 'Revenue', value: '1 USD', inline: true }],
    }) as { content: unknown[] };
    expect(content).toEqual([
      { type: 'text', text: '##### [Purchase](https://example.com/p)' },
      { type: 'text', text: 'Price: 1 USD' },
      { type: 'divider' },
      {
        type: 'column_set',
        columns: [
          {
            type: 'column',
            gap: 'small',
            items: [
              { type: 'text', text: '**Revenue**' },
              { type: 'text', text: '1 USD' },
            ],
          },
        ],
      },
    ]);
  });

  it('should render a feed or release author with an avatar as a horizontal container', () => {
    for (const kind of ['feed', 'release'] as const) {
      const { content } = toMattermostBlock({ kind, author, title: 'Title' }) as { content: unknown[] };
      expect(content[0], kind).toEqual(
        avatarBlock('octocat', 'https://github.com/octocat', 'https://example.com/a.png'),
      );
    }
  });

  it('should keep the avatar layout and author link when the icon or url is empty', () => {
    const { content } = toMattermostBlock({
      kind: 'feed',
      author: { name: 'octocat', url: '', iconUrl: '' },
      title: 'Title',
    }) as { content: unknown[] };
    expect(content[0]).toEqual(avatarBlock('octocat', '', ''));
  });

  it('should leave the accent colour unset without an accent', () => {
    expect(toMattermostBlock({ kind: 'alert', title: 'Title' })).toHaveProperty('accent_color', undefined);
  });

  it('should render an rss post like a feed item', () => {
    const post = {
      author: { name: 'Immich Blog', url: 'https://x/rss.xml', iconUrl: '' },
      title: 'T',
      url: 'https://x/1',
      body: 'B',
    };
    expect(toMattermostBlock({ kind: 'rss', ...post, timestamp: '2025-06-10T09:30:00.000Z' })).toEqual(
      toMattermostBlock({ kind: 'feed', ...post }),
    );
  });

  it('should label an rss post without a title with its link, and leave a post without a link unlinked', () => {
    const titleOf = (post: { title: string; url?: string }) =>
      (toMattermostBlock({ kind: 'rss', ...post }).content as Array<{ text: string } | undefined>).flatMap((block) =>
        block ? [block.text] : [],
      );
    expect(titleOf({ title: '', url: 'https://x/1' })).toEqual(['##### [https://x/1](https://x/1)']);
    expect(titleOf({ title: 'T' })).toEqual(['##### T']);
    expect(titleOf({ title: '' })).toEqual([]);
  });
});
