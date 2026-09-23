import { Logger } from '@nestjs/common';
import { EmbedBuilder } from 'discord.js';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { FeedItem, IRSSInterface, PostItem } from 'src/interfaces/rss.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';
import { RSSFeed } from 'src/schema';
import { NotificationService } from 'src/services/notification.service';
import { RSSService } from 'src/services/rss.service';
import { Mocked, afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

const newDatabaseMock = (): Mocked<
  Pick<IDatabaseRepository, 'createRSSFeed' | 'getRSSFeeds' | 'removeRSSFeed' | 'updateRSSFeed'>
> => ({
  createRSSFeed: vitest.fn(),
  getRSSFeeds: vitest.fn().mockResolvedValue([]),
  removeRSSFeed: vitest.fn(),
  updateRSSFeed: vitest.fn(),
});

const newDiscordMock = (): Mocked<IDiscordInterface> => ({
  login: vitest.fn(),
  isReady: vitest.fn().mockReturnValue(true),
  onHandlerError: vitest.fn(),
  sendMessage: vitest.fn(),
  createEmote: vitest.fn(),
  getEmotes: vitest.fn(),
  setThreadArchived: vitest.fn(),
  createThread: vitest.fn(),
  updateThread: vitest.fn(),
});

const newMattermostMock = (): Mocked<IMattermostInterface> => ({
  isInitialised: vitest.fn().mockReturnValue(true),
  init: vitest.fn(),
  registerEventListener: vitest.fn() as any,
  send: vitest.fn(),
  reply: vitest.fn(),
  updatePost: vitest.fn(),
  createEmote: vitest.fn(),
  listEmoji: vitest.fn(),
  streamChannels: vitest.fn(),
  joinChannel: vitest.fn(),
  registerCommand: vitest.fn() as any,
  runCommand: vitest.fn(),
  openDialog: vitest.fn(),
  submitDialog: vitest.fn(),
});

const newZulipMock = (): Mocked<IZulipInterface> => ({
  init: vitest.fn(),
  isInitialised: vitest.fn().mockReturnValue(true),
  sendMessage: vitest.fn().mockResolvedValue({ id: 1 }),
  sendDirectMessage: vitest.fn(),
  createEmote: vitest.fn(),
  getMessage: vitest.fn(),
  updateMessage: vitest.fn(),
  listEmoji: vitest.fn(),
  getSubscriptions: vitest.fn(),
  getOwnUser: vitest.fn(),
  getUser: vitest.fn(),
  getStream: vitest.fn(),
  getMessages: vitest.fn(),
  registerQueue: vitest.fn(),
  getEvents: vitest.fn(),
  deleteQueue: vitest.fn(),
  deleteMessage: vitest.fn(),
  uploadFile: vitest.fn(),
  downloadUpload: vitest.fn(),
  getStreamMessagesBefore: vitest.fn(),
  getEmojiCodes: vitest.fn(),
});

const newRSSMock = (): Mocked<IRSSInterface> => ({
  getFeed: vitest.fn(),
});

const url = 'https://immich.app/blog/rss.xml';
const channelId = '1234567890';

const feed: FeedItem = { title: 'Immich Blog', profileImageUrl: 'https://immich.app/favicon.png' };

const makePost = (id: string, overrides: Partial<PostItem> = {}): PostItem => ({
  id,
  title: `Post ${id}`,
  summary: `Summary of ${id}`,
  link: `https://immich.app/blog/${id}`,
  pubDate: 'Tue, 10 Jun 2025 09:30:00 GMT',
  ...overrides,
});

const makeRow = (overrides: Partial<RSSFeed> = {}): RSSFeed => ({
  url,
  channelId,
  service: 'discord',
  topic: null,
  lastId: 'old',
  title: 'Immich Blog',
  profileImageUrl: 'https://immich.app/favicon.png',
  ...overrides,
});

describe(RSSService.name, () => {
  let sut: RSSService;
  let databaseMock: ReturnType<typeof newDatabaseMock>;
  let discordMock: Mocked<IDiscordInterface>;
  let zulipMock: Mocked<IZulipInterface>;
  let rssMock: Mocked<IRSSInterface>;

  const sent = () => discordMock.sendMessage.mock.calls.map(([dto]) => JSON.parse(JSON.stringify(dto)));

  const sentEmbeds = () => sent().map(({ message }) => message.embeds);

  const embedFor = async (post: PostItem, fetchedFeed: FeedItem = feed) => {
    rssMock.getFeed.mockResolvedValue({ feed: fetchedFeed, posts: [post] });
    await sut.initFeed(url, channelId);
    const embeds = sentEmbeds();
    expect(embeds).toHaveLength(1);
    expect(embeds[0]).toHaveLength(1);
    return embeds[0][0];
  };

  beforeEach(() => {
    databaseMock = newDatabaseMock();
    discordMock = newDiscordMock();
    zulipMock = newZulipMock();
    rssMock = newRSSMock();
    const notifications = new NotificationService(discordMock, newMattermostMock(), zulipMock);
    sut = new RSSService(databaseMock as unknown as IDatabaseRepository, notifications, rssMock);
  });

  afterEach(() => {
    vitest.restoreAllMocks();
  });

  describe('the Discord embed for a post', () => {
    it('should send one EmbedBuilder, and nothing else, to the feed channel', async () => {
      rssMock.getFeed.mockResolvedValue({ feed, posts: [makePost('p1')] });

      await sut.initFeed(url, channelId);

      expect(discordMock.sendMessage).toHaveBeenCalledOnce();
      expect(discordMock.sendMessage.mock.calls[0]).toStrictEqual([
        { channelId, message: { embeds: [expect.any(EmbedBuilder)] } },
      ]);
    });

    it('should show the feed as author and the post title, summary, date and link', async () => {
      const embed = await embedFor(
        makePost('p1', { title: 'Immich v2.0.0', summary: 'Release **v2.0.0** is out: <b>stable</b> at last' }),
      );

      expect(embed).toStrictEqual({
        author: { name: 'Immich Blog', icon_url: 'https://immich.app/favicon.png', url },
        title: 'Immich v2.0.0',
        description: 'Release **v2.0.0** is out: <b>stable</b> at last',
        timestamp: '2025-06-10T09:30:00.000Z',
        url: 'https://immich.app/blog/p1',
      });
    });

    it('should send the whole message as the JSON Discord receives', async () => {
      rssMock.getFeed.mockResolvedValue({ feed, posts: [makePost('p1')] });

      await sut.initFeed(url, channelId);

      expect(sent()).toStrictEqual([
        {
          channelId,
          message: {
            embeds: [
              {
                author: { name: 'Immich Blog', icon_url: 'https://immich.app/favicon.png', url },
                title: 'Post p1',
                description: 'Summary of p1',
                timestamp: '2025-06-10T09:30:00.000Z',
                url: 'https://immich.app/blog/p1',
              },
            ],
          },
        },
      ]);
    });

    it('should link the author to the subscribed feed URL, not to the post or the site', async () => {
      const embed = await embedFor(makePost('p1', { link: 'https://example.com/elsewhere' }));

      expect(embed.author.url).toBe(url);
      expect(embed.url).toBe('https://example.com/elsewhere');
    });

    it('should keep a summary of exactly 4096 characters as it is', async () => {
      const summary = 'a'.repeat(4096);

      const embed = await embedFor(makePost('p1', { summary }));

      expect(embed.description).toBe(summary);
    });

    it('should shorten a longer summary to 4096 characters, the last three an ellipsis', async () => {
      const embed = await embedFor(makePost('p1', { summary: 'a'.repeat(4093) + 'bcdefgh' }));

      expect(embed.description).toHaveLength(4096);
      expect(embed.description).toBe('a'.repeat(4093) + '...');
    });

    // `shorten` counts UTF-16 units, so the cut can split a surrogate pair.
    it('should shorten a summary over 4096 UTF-16 units even when it is under 4096 code points, splitting a surrogate pair', async () => {
      const summary = 'a'.repeat(4090) + '😀'.repeat(4);
      expect(summary).toHaveLength(4098);
      expect([...summary]).toHaveLength(4094);

      const embed = await embedFor(makePost('p1', { summary }));

      expect(embed.description).toBe('a'.repeat(4090) + '😀' + '\uD83D' + '...');
      expect(embed.description).toHaveLength(4096);
      expect(embed.description.at(4092)).toBe('\uD83D');
    });

    it('should keep a summary of exactly 4096 UTF-16 units that ends in a surrogate pair as it is', async () => {
      const summary = 'a'.repeat(4094) + '😀';
      expect(summary).toHaveLength(4096);

      const embed = await embedFor(makePost('p1', { summary }));

      expect(embed.description).toBe(summary);
    });

    it('should keep a title of exactly 256 characters as it is', async () => {
      const title = 't'.repeat(256);

      const embed = await embedFor(makePost('p1', { title }));

      expect(embed.title).toBe(title);
    });

    it.each([
      ['an RFC 822 date in GMT', 'Tue, 10 Jun 2025 09:30:00 GMT', '2025-06-10T09:30:00.000Z'],
      ['an RFC 822 date with an offset', 'Tue, 10 Jun 2025 11:30:00 +0200', '2025-06-10T09:30:00.000Z'],
      ['an ISO 8601 date', '2025-06-10T09:30:00Z', '2025-06-10T09:30:00.000Z'],
      ['an ISO 8601 date with milliseconds and an offset', '2025-06-10T04:30:00.123-05:00', '2025-06-10T09:30:00.123Z'],
    ])('should send %s as an ISO timestamp in UTC', async (_, pubDate, timestamp) => {
      const embed = await embedFor(makePost('p1', { pubDate }));

      expect(embed.timestamp).toBe(timestamp);
    });
  });

  describe('missing fields (the null branches)', () => {
    it('should leave the title out when the post has none', async () => {
      const embed = await embedFor(makePost('p1', { title: undefined }));

      expect(embed).not.toHaveProperty('title');
      expect(embed).toHaveProperty('description', 'Summary of p1');
    });

    it.each([
      ['undefined', undefined],
      ['empty', ''],
    ])('should leave the description out when the summary is %s', async (_, summary) => {
      const embed = await embedFor(makePost('p1', { summary }));

      expect(embed).not.toHaveProperty('description');
      expect(embed).toHaveProperty('title', 'Post p1');
    });

    it.each([
      ['undefined', undefined],
      ['empty', ''],
    ])('should leave the timestamp out when the date is %s', async (_, pubDate) => {
      const embed = await embedFor(makePost('p1', { pubDate }));

      expect(embed).not.toHaveProperty('timestamp');
      expect(embed).toHaveProperty('title', 'Post p1');
    });

    it('should leave the URL out when the post has no link', async () => {
      const embed = await embedFor(makePost('p1', { link: undefined }));

      expect(embed).not.toHaveProperty('url');
      expect(embed).toHaveProperty('title', 'Post p1');
    });

    it.each([
      ['undefined', undefined],
      ['empty', ''],
    ])('should leave the author out, image and all, when the feed title is %s', async (_, title) => {
      const embed = await embedFor(makePost('p1'), { title, profileImageUrl: 'https://immich.app/favicon.png' });

      expect(embed).not.toHaveProperty('author');
      expect(embed).toHaveProperty('title', 'Post p1');
    });

    it('should send the author without an icon when the feed has a title but no image', async () => {
      const embed = await embedFor(makePost('p1'), { title: 'Immich Blog' });

      expect(embed.author).toStrictEqual({ name: 'Immich Blog', url });
    });

    it('should skip a post with nothing but an ID from a feed with nothing, which Discord would refuse as an empty embed, and store it as the last post', async () => {
      vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      rssMock.getFeed.mockResolvedValue({ feed: {}, posts: [{ id: 'p1' }] });

      await sut.initFeed(url, channelId);

      expect(discordMock.sendMessage).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).toHaveBeenCalledExactlyOnceWith(
        `Skipping p1 of the RSS feed ${url}: it has nothing to post`,
      );
      expect(databaseMock.updateRSSFeed).toHaveBeenCalledExactlyOnceWith({
        url,
        channelId,
        service: 'discord',
        lastId: 'p1',
        profileImageUrl: undefined,
        title: undefined,
      });
    });

    it('should send a post with nothing but an ID as the feed author alone, and store it as the last post', async () => {
      rssMock.getFeed.mockResolvedValue({ feed, posts: [{ id: 'p1' }] });

      await sut.initFeed(url, channelId);

      expect(sent()).toStrictEqual([
        {
          channelId,
          message: { embeds: [{ author: { name: 'Immich Blog', url, icon_url: 'https://immich.app/favicon.png' } }] },
        },
      ]);
      expect(databaseMock.updateRSSFeed).toHaveBeenCalledExactlyOnceWith({
        url,
        channelId,
        service: 'discord',
        lastId: 'p1',
        ...feed,
      });
    });

    it('should send a post with nothing but an ID and a date from a feed with nothing as the timestamp alone', async () => {
      rssMock.getFeed.mockResolvedValue({ feed: {}, posts: [{ id: 'p1', pubDate: 'Tue, 10 Jun 2025 09:30:00 GMT' }] });

      await sut.initFeed(url, channelId);

      expect(sent()).toStrictEqual([{ channelId, message: { embeds: [{ timestamp: '2025-06-10T09:30:00.000Z' }] } }]);
    });
  });

  describe('posts the embed builder refuses, delivered with the bad field cut or dropped', () => {
    const embed = {
      author: { name: 'Immich Blog', icon_url: 'https://immich.app/favicon.png', url },
      title: 'Post p1',
      description: 'Summary of p1',
      timestamp: '2025-06-10T09:30:00.000Z',
      url: 'https://immich.app/blog/p1',
    };
    const without = (key: keyof typeof embed) => Object.fromEntries(Object.entries(embed).filter(([k]) => k !== key));
    const [untitled, unlinked, undated] = [without('title'), without('url'), without('timestamp')];

    it.each([
      [
        'a title over 256 characters, cut to 256',
        makePost('p1', { title: 't'.repeat(257) }),
        { ...embed, title: 't'.repeat(253) + '...' },
      ],
      ['an empty title, without the title', makePost('p1', { title: '' }), untitled],
      ['a relative link, without the link', makePost('p1', { link: '/blog/p1' }), unlinked],
      ['an empty link, without the link', makePost('p1', { link: '' }), unlinked],
      ['a date that does not parse, without the timestamp', makePost('p1', { pubDate: 'not a date' }), undated],
    ])('should send a post with %s, and store it as the last post', async (_, post, expected) => {
      rssMock.getFeed.mockResolvedValue({ feed, posts: [post] });

      await sut.initFeed(url, channelId);

      expect(sentEmbeds()).toStrictEqual([[expected]]);
      expect(databaseMock.updateRSSFeed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ lastId: 'p1' }));
    });

    it.each([
      [
        'a title over 256 characters, cut to 256',
        { ...feed, title: 'f'.repeat(257) },
        { ...embed, author: { ...embed.author, name: 'f'.repeat(253) + '...' } },
      ],
      [
        'an image URL that is not absolute, without the icon',
        { ...feed, profileImageUrl: '/favicon.png' },
        { ...embed, author: { name: 'Immich Blog', url } },
      ],
    ])('should send a post of a feed with %s, and store it as the last post', async (_, fetchedFeed, expected) => {
      rssMock.getFeed.mockResolvedValue({ feed: fetchedFeed, posts: [makePost('p1')] });

      await sut.initFeed(url, channelId);

      expect(sentEmbeds()).toStrictEqual([[expected]]);
      expect(databaseMock.updateRSSFeed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ lastId: 'p1' }));
    });

    it('should not stop a poll at a post the embed builder would refuse, sending every post and storing the newest', async () => {
      databaseMock.getRSSFeeds.mockResolvedValue([makeRow({ lastId: 'p0' })]);
      rssMock.getFeed.mockResolvedValue({
        feed,
        posts: [makePost('p3'), makePost('p2', { title: 't'.repeat(257) }), makePost('p1')],
      });

      await sut.onFeedUpdates();

      expect(sentEmbeds().map(([embed]) => embed.title)).toEqual(['Post p1', 't'.repeat(253) + '...', 'Post p3']);
      expect(databaseMock.updateRSSFeed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ lastId: 'p3' }));
    });
  });

  describe('processPosts', () => {
    it('should post new posts oldest first, the reverse of the feed order', async () => {
      databaseMock.getRSSFeeds.mockResolvedValue([makeRow({ lastId: 'p0' })]);
      rssMock.getFeed.mockResolvedValue({ feed, posts: [makePost('p3'), makePost('p2'), makePost('p1')] });

      await sut.onFeedUpdates();

      expect(sent().map(({ channelId }) => channelId)).toEqual([channelId, channelId, channelId]);
      expect(sentEmbeds().map(([embed]) => embed.title)).toEqual(['Post p1', 'Post p2', 'Post p3']);
    });

    it('should send one message per post, each with a single embed', async () => {
      databaseMock.getRSSFeeds.mockResolvedValue([makeRow({ lastId: 'p0' })]);
      rssMock.getFeed.mockResolvedValue({ feed, posts: [makePost('p2'), makePost('p1')] });

      await sut.onFeedUpdates();

      expect(discordMock.sendMessage).toHaveBeenCalledTimes(2);
      expect(sentEmbeds().map((embeds) => embeds.length)).toEqual([1, 1]);
    });

    it('should store the newest post, the first in feed order, as lastId once every post is sent', async () => {
      databaseMock.getRSSFeeds.mockResolvedValue([makeRow({ lastId: 'p0' })]);
      rssMock.getFeed.mockResolvedValue({ feed, posts: [makePost('p3'), makePost('p2'), makePost('p1')] });

      await sut.onFeedUpdates();

      expect(databaseMock.updateRSSFeed).toHaveBeenCalledExactlyOnceWith({
        url,
        channelId,
        service: 'discord',
        lastId: 'p3',
        profileImageUrl: 'https://immich.app/favicon.png',
        title: 'Immich Blog',
      });
      const [lastSend] = discordMock.sendMessage.mock.invocationCallOrder.slice(-1);
      expect(databaseMock.updateRSSFeed.mock.invocationCallOrder[0]).toBeGreaterThan(lastSend);
    });
  });

  describe('createRSSFeed and initFeed', () => {
    it('should store the feed, then fetch it from the start, post only the newest post and store its ID, image and title', async () => {
      rssMock.getFeed.mockResolvedValue({ feed, posts: [makePost('p3'), makePost('p2'), makePost('p1')] });

      await sut.createRSSFeed(url, channelId);

      expect(databaseMock.createRSSFeed).toHaveBeenCalledExactlyOnceWith({
        url,
        channelId,
        service: 'discord',
        topic: null,
      });
      expect(rssMock.getFeed).toHaveBeenCalledExactlyOnceWith(url, null);
      expect(sentEmbeds().map(([embed]) => embed.title)).toEqual(['Post p3']);
      expect(sent()[0].channelId).toBe(channelId);
      expect(databaseMock.updateRSSFeed).toHaveBeenCalledExactlyOnceWith({
        url,
        channelId,
        service: 'discord',
        lastId: 'p3',
        profileImageUrl: 'https://immich.app/favicon.png',
        title: 'Immich Blog',
      });

      const order = [
        databaseMock.createRSSFeed.mock.invocationCallOrder[0],
        rssMock.getFeed.mock.invocationCallOrder[0],
        discordMock.sendMessage.mock.invocationCallOrder[0],
        databaseMock.updateRSSFeed.mock.invocationCallOrder[0],
      ];
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('should post only the newest post when initFeed is called on its own', async () => {
      rssMock.getFeed.mockResolvedValue({ feed, posts: [makePost('p2'), makePost('p1')] });

      await sut.initFeed(url, channelId);

      expect(databaseMock.createRSSFeed).not.toHaveBeenCalled();
      expect(rssMock.getFeed).toHaveBeenCalledExactlyOnceWith(url, null);
      expect(sentEmbeds().map(([embed]) => embed.title)).toEqual(['Post p2']);
      expect(databaseMock.updateRSSFeed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ lastId: 'p2' }));
    });

    it('should throw when the feed has no posts, sending and updating nothing', async () => {
      rssMock.getFeed.mockResolvedValue({ feed, posts: [] });

      await expect(sut.initFeed(url, channelId)).rejects.toThrow(new Error(`Could not fetch posts from ${url}`));

      expect(discordMock.sendMessage).not.toHaveBeenCalled();
      expect(databaseMock.updateRSSFeed).not.toHaveBeenCalled();
    });

    it('should reject from createRSSFeed when the feed has no posts, removing the row it stored', async () => {
      rssMock.getFeed.mockResolvedValue({ feed, posts: [] });

      await expect(sut.createRSSFeed(url, channelId)).rejects.toThrow(new Error(`Could not fetch posts from ${url}`));

      expect(databaseMock.createRSSFeed).toHaveBeenCalledExactlyOnceWith({
        url,
        channelId,
        service: 'discord',
        topic: null,
      });
      expect(databaseMock.removeRSSFeed).toHaveBeenCalledExactlyOnceWith(url, channelId, 'discord');
    });

    it('should reject when the newest post cannot be sent, storing no lastId and removing the row it stored', async () => {
      vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      rssMock.getFeed.mockResolvedValue({ feed, posts: [makePost('p1')] });
      discordMock.sendMessage.mockRejectedValue(new Error('Missing Access'));

      await expect(sut.createRSSFeed(url, channelId)).rejects.toThrow(
        new Error(`Could not post the newest post of ${url}`),
      );

      expect(databaseMock.createRSSFeed).toHaveBeenCalledOnce();
      expect(databaseMock.updateRSSFeed).not.toHaveBeenCalled();
      expect(databaseMock.removeRSSFeed).toHaveBeenCalledExactlyOnceWith(url, channelId, 'discord');
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        `Could not notify channel ${channelId} on discord: Error: Missing Access`,
        expect.any(String),
      );
    });

    it('should reject when the feed cannot be fetched, removing the row it stored', async () => {
      const error = new Error('Status code 404');
      rssMock.getFeed.mockRejectedValue(error);

      await expect(sut.createRSSFeed(url, channelId)).rejects.toBe(error);

      expect(databaseMock.createRSSFeed).toHaveBeenCalledOnce();
      expect(discordMock.sendMessage).not.toHaveBeenCalled();
      expect(databaseMock.removeRSSFeed).toHaveBeenCalledExactlyOnceWith(url, channelId, 'discord');
    });

    it('should keep the original failure when the row it stored cannot be removed either', async () => {
      vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      const error = new Error('Status code 404');
      rssMock.getFeed.mockRejectedValue(error);
      databaseMock.removeRSSFeed.mockRejectedValue(new Error('connection terminated'));

      await expect(sut.createRSSFeed(url, channelId)).rejects.toBe(error);

      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        `Could not remove the RSS feed ${url} it failed to add: Error: connection terminated`,
      );
    });

    it('should not fetch or send anything when the row cannot be stored', async () => {
      const error = new Error('duplicate key value violates unique constraint');
      databaseMock.createRSSFeed.mockRejectedValue(error);

      await expect(sut.createRSSFeed(url, channelId)).rejects.toBe(error);

      expect(rssMock.getFeed).not.toHaveBeenCalled();
      expect(discordMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should not remove a row it did not store', async () => {
      databaseMock.createRSSFeed.mockRejectedValue(new Error('duplicate key value violates unique constraint'));

      await expect(sut.createRSSFeed(url, channelId)).rejects.toThrow();

      expect(databaseMock.removeRSSFeed).not.toHaveBeenCalled();
    });
  });

  describe('onFeedUpdates', () => {
    it('should read every feed of every channel', async () => {
      await sut.onFeedUpdates();

      expect(databaseMock.getRSSFeeds).toHaveBeenCalledExactlyOnceWith();
      expect(rssMock.getFeed).not.toHaveBeenCalled();
      expect(discordMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should poll each row in turn from its own lastId, post to its channel and store its new lastId', async () => {
      const other = 'https://github.com/immich-app/immich/releases.atom';
      databaseMock.getRSSFeeds.mockResolvedValue([
        makeRow({ url, channelId: 'channel-1', lastId: 'a1' }),
        makeRow({ url: other, channelId: 'channel-2', lastId: null }),
        makeRow({ url, channelId: 'channel-3', lastId: 'a0' }),
      ]);
      const releases: FeedItem = { title: 'Releases', profileImageUrl: 'https://github.com/immich-app.png' };
      rssMock.getFeed.mockImplementation((feedUrl, lastId) => {
        if (feedUrl === other) {
          return Promise.resolve({ feed: releases, posts: [makePost('r2'), makePost('r1')] });
        }
        return Promise.resolve({
          feed,
          posts: lastId === 'a1' ? [makePost('a2')] : [makePost('a2'), makePost('a1')],
        });
      });

      await sut.onFeedUpdates();

      expect(rssMock.getFeed.mock.calls).toEqual([
        [url, 'a1'],
        [other, null],
        [url, 'a0'],
      ]);
      expect(sent().map(({ channelId, message }) => [channelId, message.embeds[0].title])).toEqual([
        ['channel-1', 'Post a2'],
        ['channel-2', 'Post r1'],
        ['channel-2', 'Post r2'],
        ['channel-3', 'Post a1'],
        ['channel-3', 'Post a2'],
      ]);
      expect(sentEmbeds()[1][0].author).toStrictEqual({
        name: 'Releases',
        icon_url: 'https://github.com/immich-app.png',
        url: other,
      });
      expect(databaseMock.updateRSSFeed.mock.calls).toEqual([
        [{ url, channelId: 'channel-1', service: 'discord', lastId: 'a2', ...feed }],
        [{ url: other, channelId: 'channel-2', service: 'discord', lastId: 'r2', ...releases }],
        [{ url, channelId: 'channel-3', service: 'discord', lastId: 'a2', ...feed }],
      ]);
    });

    it('should finish one feed, storing it, before fetching the next', async () => {
      databaseMock.getRSSFeeds.mockResolvedValue([
        makeRow({ channelId: 'channel-1' }),
        makeRow({ channelId: 'channel-2' }),
      ]);
      rssMock.getFeed.mockResolvedValue({ feed, posts: [makePost('p1')] });

      await sut.onFeedUpdates();

      const [firstStore] = databaseMock.updateRSSFeed.mock.invocationCallOrder;
      const [, secondFetch] = rssMock.getFeed.mock.invocationCallOrder;
      expect(firstStore).toBeLessThan(secondFetch);
    });

    it("should use and store the fetched title and image, not the row's", async () => {
      databaseMock.getRSSFeeds.mockResolvedValue([
        makeRow({ title: 'Old title', profileImageUrl: 'https://example.com/old.png' }),
      ]);
      const fetchedFeed = { title: 'New title', profileImageUrl: 'https://example.com/new.png' };
      rssMock.getFeed.mockResolvedValue({ feed: fetchedFeed, posts: [makePost('p1')] });

      await sut.onFeedUpdates();

      expect(sentEmbeds()[0][0].author).toStrictEqual({
        name: 'New title',
        icon_url: 'https://example.com/new.png',
        url,
      });
      expect(databaseMock.updateRSSFeed).toHaveBeenCalledExactlyOnceWith({
        url,
        channelId,
        service: 'discord',
        lastId: 'p1',
        ...fetchedFeed,
      });
    });

    it('should send nothing when there are no new posts, and store lastId as undefined, not null', async () => {
      databaseMock.getRSSFeeds.mockResolvedValue([makeRow({ lastId: 'p1' })]);
      rssMock.getFeed.mockResolvedValue({ feed, posts: [] });

      await sut.onFeedUpdates();

      expect(discordMock.sendMessage).not.toHaveBeenCalled();
      expect(databaseMock.updateRSSFeed).toHaveBeenCalledExactlyOnceWith({
        url,
        channelId,
        service: 'discord',
        lastId: undefined,
        profileImageUrl: 'https://immich.app/favicon.png',
        title: 'Immich Blog',
      });
      const [[stored]] = databaseMock.updateRSSFeed.mock.calls;
      expect(stored).toHaveProperty('lastId', undefined);
    });

    it('should post every post the repository returns for a row that has no lastId yet', async () => {
      databaseMock.getRSSFeeds.mockResolvedValue([makeRow({ lastId: null })]);
      rssMock.getFeed.mockResolvedValue({ feed, posts: [makePost('p3'), makePost('p2'), makePost('p1')] });

      await sut.onFeedUpdates();

      expect(rssMock.getFeed).toHaveBeenCalledExactlyOnceWith(url, null);
      expect(sentEmbeds().map(([embed]) => embed.title)).toEqual(['Post p1', 'Post p2', 'Post p3']);
    });

    it('should log a feed that cannot be fetched with its URL and poll the feeds after it', async () => {
      vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      const error = new Error('Status code 503');
      databaseMock.getRSSFeeds.mockResolvedValue([
        makeRow({ channelId: 'channel-1' }),
        makeRow({ channelId: 'channel-2' }),
        makeRow({ channelId: 'channel-3' }),
      ]);
      rssMock.getFeed
        .mockResolvedValueOnce({ feed, posts: [makePost('p1')] })
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ feed, posts: [makePost('p1')] });

      await expect(sut.onFeedUpdates()).resolves.toBeUndefined();

      expect(rssMock.getFeed).toHaveBeenCalledTimes(3);
      expect(sent().map(({ channelId }) => channelId)).toEqual(['channel-1', 'channel-3']);
      expect(databaseMock.updateRSSFeed.mock.calls.map(([{ channelId }]) => channelId)).toEqual([
        'channel-1',
        'channel-3',
      ]);
      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        `Could not update the RSS feed ${url} in discord channel channel-2: Error: Status code 503`,
      );
    });

    it('should stop a feed at a post that cannot be sent, store the post before it, and poll the feeds after it', async () => {
      vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const error = new Error('Missing Access');
      databaseMock.getRSSFeeds.mockResolvedValue([
        makeRow({ channelId: 'channel-1', lastId: 'p0' }),
        makeRow({ channelId: 'channel-2', lastId: 'p0' }),
      ]);
      rssMock.getFeed.mockResolvedValue({ feed, posts: [makePost('p3'), makePost('p2'), makePost('p1')] });
      discordMock.sendMessage.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);

      await expect(sut.onFeedUpdates()).resolves.toBeUndefined();

      expect(sent().map(({ channelId, message }) => [channelId, message.embeds[0].title])).toEqual([
        ['channel-1', 'Post p1'],
        ['channel-1', 'Post p2'],
        ['channel-2', 'Post p1'],
        ['channel-2', 'Post p2'],
        ['channel-2', 'Post p3'],
      ]);
      expect(databaseMock.updateRSSFeed.mock.calls).toEqual([
        [{ url, channelId: 'channel-1', service: 'discord', lastId: 'p1', ...feed }],
        [{ url, channelId: 'channel-2', service: 'discord', lastId: 'p3', ...feed }],
      ]);
      expect(rssMock.getFeed).toHaveBeenCalledTimes(2);
      expect(Logger.prototype.warn).toHaveBeenCalledExactlyOnceWith(
        `Could not post p2 of the RSS feed ${url}; it is retried on the next poll`,
      );
    });
  });

  describe('removeRSSFeed', () => {
    it('should remove the row for that URL and channel, and do nothing else', async () => {
      await sut.removeRSSFeed(url, channelId);

      expect(databaseMock.removeRSSFeed).toHaveBeenCalledExactlyOnceWith(url, channelId, 'discord');
      expect(databaseMock.getRSSFeeds).not.toHaveBeenCalled();
      expect(databaseMock.updateRSSFeed).not.toHaveBeenCalled();
      expect(rssMock.getFeed).not.toHaveBeenCalled();
      expect(discordMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should pass a removal failure through', async () => {
      const error = new Error('connection terminated');
      databaseMock.removeRSSFeed.mockRejectedValue(error);

      await expect(sut.removeRSSFeed(url, channelId)).rejects.toBe(error);
    });
  });

  describe('searchRSSFeeds', () => {
    const long = 'https://example.com/a/very/long/path/to/some/feed/that/goes/on/rss.xml';

    it("should list the channel's feeds in database order, named by the URL shortened to 40 characters", async () => {
      databaseMock.getRSSFeeds.mockResolvedValue([
        makeRow({ url: long }),
        makeRow({ url: 'https://example.com/exactly-forty-chars.' }),
        makeRow({ url }),
      ]);

      const result = await sut.searchRSSFeeds('', channelId);

      expect(databaseMock.getRSSFeeds).toHaveBeenCalledExactlyOnceWith({ channelId, service: 'discord' });
      expect('https://example.com/exactly-forty-chars.').toHaveLength(40);
      expect(result).toStrictEqual([
        { name: 'https://example.com/a/very/long/path/...', value: long },
        { name: 'https://example.com/exactly-forty-chars.', value: 'https://example.com/exactly-forty-chars.' },
        { name: url, value: url },
      ]);
      expect(result[0].name).toHaveLength(40);
    });

    it('should match a case-insensitive substring of the full URL, past the shortened name', async () => {
      const youtube = 'https://www.YouTube.com/feeds/videos.xml?channel_id=UCabc';
      databaseMock.getRSSFeeds.mockResolvedValue([makeRow({ url: long }), makeRow({ url }), makeRow({ url: youtube })]);

      await expect(sut.searchRSSFeeds('IMMICH.app', channelId)).resolves.toStrictEqual([{ name: url, value: url }]);
      await expect(sut.searchRSSFeeds('youtube.COM', channelId)).resolves.toStrictEqual([
        { name: 'https://www.YouTube.com/feeds/videos....', value: youtube },
      ]);
      await expect(sut.searchRSSFeeds('GOES/ON', channelId)).resolves.toStrictEqual([
        { name: 'https://example.com/a/very/long/path/...', value: long },
      ]);
      await expect(sut.searchRSSFeeds('nothing matches', channelId)).resolves.toStrictEqual([]);
    });

    it('should return at most 25 feeds, the most Discord accepts in an autocomplete response', async () => {
      databaseMock.getRSSFeeds.mockResolvedValue(
        Array.from({ length: 30 }, (_, i) => makeRow({ url: `https://example.com/${i}.xml` })),
      );

      const all = await sut.searchRSSFeeds('', channelId);
      const filtered = await sut.searchRSSFeeds('example', channelId);

      expect(all).toHaveLength(25);
      expect(filtered).toHaveLength(25);
      expect(all.at(-1)).toStrictEqual({ name: 'https://example.com/24.xml', value: 'https://example.com/24.xml' });
    });

    it('should cap the feeds that match the query, not the feeds before filtering', async () => {
      databaseMock.getRSSFeeds.mockResolvedValue([
        ...Array.from({ length: 30 }, (_, i) => makeRow({ url: `https://example.com/${i}.xml` })),
        makeRow({ url }),
      ]);

      await expect(sut.searchRSSFeeds('immich', channelId)).resolves.toStrictEqual([{ name: url, value: url }]);
    });
  });

  describe('zulip feeds', () => {
    const zulipRow = (overrides: Partial<RSSFeed> = {}) =>
      makeRow({ channelId: '107', service: 'zulip', topic: 'blog', lastId: 'p0', ...overrides });

    const expected = [
      '**[Post p1](https://immich.app/blog/p1)** — [Immich Blog](https://immich.app/blog/rss.xml) · <time:2025-06-10T09:30:00.000Z>',
      '~~~ quote',
      'Summary of p1',
      '~~~',
    ].join('\n');

    it('should store the feed for the stream and topic, then post the newest post there and store its ID', async () => {
      rssMock.getFeed.mockResolvedValue({ feed, posts: [makePost('p1')] });

      await sut.createZulipRSSFeed(url, 107, 'blog');

      expect(databaseMock.createRSSFeed).toHaveBeenCalledExactlyOnceWith({
        url,
        channelId: '107',
        service: 'zulip',
        topic: 'blog',
      });
      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({ stream: 107, topic: 'blog', content: expected });
      expect(discordMock.sendMessage).not.toHaveBeenCalled();
      expect(databaseMock.updateRSSFeed).toHaveBeenCalledExactlyOnceWith({
        url,
        channelId: '107',
        service: 'zulip',
        lastId: 'p1',
        ...feed,
      });
    });

    it('should post a post whose link was dropped with its title unlinked, and an untitled post labelled with its link', async () => {
      databaseMock.getRSSFeeds.mockResolvedValue([zulipRow()]);
      rssMock.getFeed.mockResolvedValue({
        feed,
        posts: [makePost('p2', { title: '', summary: '' }), makePost('p1', { link: '/blog/p1', summary: '' })],
      });

      await sut.onFeedUpdates();

      expect(zulipMock.sendMessage.mock.calls.map(([{ content }]) => content)).toEqual([
        '**Post p1** — [Immich Blog](https://immich.app/blog/rss.xml) · <time:2025-06-10T09:30:00.000Z>',
        '**[https://immich.app/blog/p2](https://immich.app/blog/p2)** — [Immich Blog](https://immich.app/blog/rss.xml) · <time:2025-06-10T09:30:00.000Z>',
      ]);
    });

    it('should post a post with nothing but an ID and a date as the feed author and the date', async () => {
      databaseMock.getRSSFeeds.mockResolvedValue([zulipRow()]);
      rssMock.getFeed.mockResolvedValue({ feed, posts: [{ id: 'p1', pubDate: 'Tue, 10 Jun 2025 09:30:00 GMT' }] });

      await sut.onFeedUpdates();

      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        stream: 107,
        topic: 'blog',
        content: '— [Immich Blog](https://immich.app/blog/rss.xml) · <time:2025-06-10T09:30:00.000Z>',
      });
    });

    it('should remove the Zulip row it stored when the newest post cannot be posted', async () => {
      vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      rssMock.getFeed.mockResolvedValue({ feed, posts: [makePost('p1')] });
      zulipMock.sendMessage.mockRejectedValue(new Error('stream does not exist'));

      await expect(sut.createZulipRSSFeed(url, 107, 'blog')).rejects.toThrow(
        `Could not post the newest post of ${url}`,
      );

      expect(databaseMock.removeRSSFeed).toHaveBeenCalledExactlyOnceWith(url, '107', 'zulip');
      expect(databaseMock.updateRSSFeed).not.toHaveBeenCalled();
    });

    it('should poll a Zulip row into its stream and topic, and store its lastId on that row', async () => {
      databaseMock.getRSSFeeds.mockResolvedValue([zulipRow(), makeRow({ lastId: 'p0' })]);
      rssMock.getFeed.mockResolvedValue({ feed, posts: [makePost('p1')] });

      await sut.onFeedUpdates();

      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({ stream: 107, topic: 'blog', content: expected });
      expect(discordMock.sendMessage).toHaveBeenCalledOnce();
      expect(databaseMock.updateRSSFeed.mock.calls).toEqual([
        [{ url, channelId: '107', service: 'zulip', lastId: 'p1', ...feed }],
        [{ url, channelId, service: 'discord', lastId: 'p1', ...feed }],
      ]);
    });

    it('should keep the lastId of a Zulip row while Zulip is not configured, so its posts wait for it', async () => {
      vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      zulipMock.isInitialised.mockReturnValue(false);
      databaseMock.getRSSFeeds.mockResolvedValue([zulipRow()]);
      rssMock.getFeed.mockResolvedValue({ feed, posts: [makePost('p2'), makePost('p1')] });

      await sut.onFeedUpdates();

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      expect(databaseMock.updateRSSFeed).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ lastId: undefined }),
      );
    });

    it('should list and remove the Zulip feeds of a stream only', async () => {
      databaseMock.getRSSFeeds.mockResolvedValue([zulipRow()]);
      databaseMock.removeRSSFeed.mockResolvedValue(true);

      await expect(sut.getZulipRSSFeeds(107)).resolves.toEqual([zulipRow()]);
      await expect(sut.removeZulipRSSFeed(url, 107)).resolves.toBe(true);

      expect(databaseMock.getRSSFeeds).toHaveBeenCalledExactlyOnceWith({ channelId: '107', service: 'zulip' });
      expect(databaseMock.removeRSSFeed).toHaveBeenCalledExactlyOnceWith(url, '107', 'zulip');
    });
  });
});
