import { Colors } from 'discord.js';
import { toDiscordEmbed, toDiscordMessage } from 'src/renderers/discord.renderer';
import { describe, expect, it } from 'vitest';

describe('toDiscordEmbed', () => {
  it('should render the title, link, author and colour', () => {
    const embed = toDiscordEmbed({
      kind: 'feed',
      accent: 'pr.merged',
      author: { name: 'octocat', url: 'https://github.com/octocat', iconUrl: 'https://example.com/a.png' },
      title: 'Pull request merged',
      url: 'https://github.com/immich-app/immich/pull/1',
      body: 'Body',
    });

    expect(embed.toJSON()).toEqual({
      title: 'Pull request merged',
      url: 'https://github.com/immich-app/immich/pull/1',
      author: { name: 'octocat', url: 'https://github.com/octocat', icon_url: 'https://example.com/a.png' },
      description: 'Body',
      color: Colors.Purple,
    });
  });

  it('should keep the author url and icon_url keys when they are empty', () => {
    const embed = toDiscordEmbed({ kind: 'feed', author: { name: 'x', url: '', iconUrl: '' }, title: 'T' });
    expect(embed.toJSON().author).toStrictEqual({ name: 'x', url: '', icon_url: '' });
  });

  it('should not carry an icon_url on an incident or purchase author', () => {
    for (const kind of ['incident', 'purchase'] as const) {
      const embed = toDiscordEmbed({ kind, author: { name: 'x', url: 'https://example.com' }, title: 'T' });
      expect(embed.toJSON().author, kind).toStrictEqual({ name: 'x', url: 'https://example.com' });
    }
  });

  it('should keep the url key on a linked kind even when the url is empty or missing', () => {
    for (const kind of ['feed', 'release', 'incident', 'purchase'] as const) {
      expect(toDiscordEmbed({ kind, title: 'T', url: '' }).toJSON(), kind).toHaveProperty('url', '');
      expect(toDiscordEmbed({ kind, title: 'T' }).toJSON(), kind).toHaveProperty('url', undefined);
    }
  });

  it('should never set a url on a report or alert', () => {
    for (const kind of ['report', 'alert'] as const) {
      expect(toDiscordEmbed({ kind, title: 'T', url: 'https://example.com' }).toJSON(), kind).not.toHaveProperty('url');
    }
  });

  it('should keep the description slot on a feed item without a body', () => {
    const embed = toDiscordEmbed({ kind: 'feed', title: 'Issue closed' });
    expect(embed.toJSON()).toHaveProperty('description', undefined);
  });

  it('should keep the description slot on a release without a body', () => {
    const embed = toDiscordEmbed({ kind: 'release', title: 'New release' });
    expect(embed.toJSON()).toHaveProperty('description', undefined);
  });

  it('should not have a description slot on an incident', () => {
    const embed = toDiscordEmbed({ kind: 'incident', title: 'Outage', body: 'ignored' });
    expect(embed.toJSON()).not.toHaveProperty('description');
  });

  it('should append the alert emoji to an alert title', () => {
    const embed = toDiscordEmbed({ kind: 'alert', accent: 'release.failed', title: 'Release Workflow Failed' });
    expect(embed.toJSON().title).toBe('Release Workflow Failed <a:peepoAlert:1367804942638776423>');
  });

  it('should not decorate the title of a non-alert kind', () => {
    const embed = toDiscordEmbed({ kind: 'release', title: 'New release' });
    expect(embed.toJSON().title).toBe('New release');
  });

  it('should leave the colour unset without an accent', () => {
    const embed = toDiscordEmbed({ kind: 'feed', title: 'Closed' });
    expect(embed.toJSON()).not.toHaveProperty('color');
  });

  it('should pass inline fields through and leave inline unset otherwise', () => {
    const embed = toDiscordEmbed({
      kind: 'purchase',
      title: 'Purchase',
      fields: [
        { name: 'Revenue', value: '1 USD', inline: true },
        { name: 'Note', value: 'stacked' },
      ],
    });

    expect(embed.toJSON().fields).toEqual([
      { name: 'Revenue', value: '1 USD', inline: true },
      { name: 'Note', value: 'stacked' },
    ]);
    expect(embed.toJSON().fields?.[1]).not.toHaveProperty('inline');
  });

  describe('rss', () => {
    const post = {
      kind: 'rss' as const,
      author: {
        name: 'Immich Blog',
        url: 'https://immich.app/blog/rss.xml',
        iconUrl: 'https://immich.app/favicon.png',
      },
      title: 'Immich v2.0.0',
      url: 'https://immich.app/blog/v2',
      body: 'Summary',
      timestamp: '2025-06-10T09:30:00.000Z',
    };

    it('should send the feed as author, then the post title, summary, timestamp and link, in that order', () => {
      expect(JSON.stringify(toDiscordEmbed(post))).toBe(
        JSON.stringify({
          author: {
            name: 'Immich Blog',
            url: 'https://immich.app/blog/rss.xml',
            icon_url: 'https://immich.app/favicon.png',
          },
          title: 'Immich v2.0.0',
          description: 'Summary',
          timestamp: '2025-06-10T09:30:00.000Z',
          url: 'https://immich.app/blog/v2',
        }),
      );
    });

    it('should leave out every key the post does not have, an empty title included, which Discord refuses', () => {
      expect(toDiscordEmbed({ kind: 'rss', title: '' }).toJSON()).toStrictEqual({});
    });

    it('should never colour an RSS post', () => {
      expect(toDiscordEmbed({ ...post, accent: 'pr.merged' }).toJSON()).not.toHaveProperty('color');
    });

    it('should keep an empty title on every other kind, and never set a timestamp there', () => {
      for (const kind of ['feed', 'release', 'incident', 'purchase', 'report', 'alert'] as const) {
        const embed = toDiscordEmbed({ kind, title: '', timestamp: '2025-06-10T09:30:00.000Z' }).toJSON();
        expect(embed.title, kind).toMatch(/^( <a:peepoAlert:\d+>)?$/);
        expect(embed, kind).not.toHaveProperty('timestamp');
      }
    });
  });
});

describe('toDiscordMessage', () => {
  it('should send a log line as plain text, the detail after a colon', () => {
    expect(toDiscordMessage({ kind: 'log', title: 'Discord bot error', body: 'Error: boom' })).toBe(
      'Discord bot error: Error: boom',
    );
    expect(toDiscordMessage({ kind: 'log', title: "I'm alive, running 1.0.0@[abc](https://x)!" })).toBe(
      "I'm alive, running 1.0.0@[abc](https://x)!",
    );
    expect(toDiscordMessage({ kind: 'log', title: 'Failed', body: '' })).toBe('Failed');
  });

  it('should send every other kind as one embed', () => {
    const message = toDiscordMessage({ kind: 'alert', accent: 'release.failed', title: 'Release Workflow Failed' });
    expect(message).toEqual({ embeds: [expect.any(Object)] });
    const [embed] = (message as { embeds: [ReturnType<typeof toDiscordEmbed>] }).embeds;
    expect(embed.toJSON()).toEqual(
      toDiscordEmbed({ kind: 'alert', accent: 'release.failed', title: 'Release Workflow Failed' }).toJSON(),
    );
  });
});
