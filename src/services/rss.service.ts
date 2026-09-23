import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { shorten } from 'src/format';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { Notification } from 'src/interfaces/notification.interface';
import { FeedItem, IRSSInterface, PostItem } from 'src/interfaces/rss.interface';
import { RSSFeed } from 'src/schema';
import { NotificationService, toNotificationTarget } from 'src/services/notification.service';

const MAX_TITLE_LENGTH = 256;
const MAX_AUTHOR_LENGTH = 256;
const MAX_SUMMARY_LENGTH = 4096;

type Feed = Pick<RSSFeed, 'url' | 'channelId' | 'service' | 'topic'>;

const isUrl = (value: string | undefined, protocols: string[]): value is string => {
  if (!value) {
    return false;
  }
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const toTimestamp = (pubDate: string | undefined) => {
  const date = pubDate ? new Date(pubDate) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
};

/**
 * A post as a notification, with anything Discord would refuse cut to its limit or dropped, so that one bad post
 * is delivered without it instead of failing on every poll and holding up the posts after it.
 */
export const toRSSNotification = (feed: FeedItem, post: PostItem, url: string): Notification => ({
  kind: 'rss',
  author: feed.title
    ? {
        name: shorten(feed.title, MAX_AUTHOR_LENGTH),
        url,
        iconUrl: isUrl(feed.profileImageUrl, ['http:', 'https:', 'attachment:']) ? feed.profileImageUrl : undefined,
      }
    : undefined,
  title: post.title ? shorten(post.title, MAX_TITLE_LENGTH) : '',
  body: post.summary ? shorten(post.summary, MAX_SUMMARY_LENGTH) : undefined,
  timestamp: toTimestamp(post.pubDate),
  url: isUrl(post.link, ['http:', 'https:']) ? post.link : undefined,
});

const discordFeed = (url: string, channelId: string): Feed => ({ url, channelId, service: 'discord', topic: null });

@Injectable()
export class RSSService {
  private logger = new Logger(RSSService.name);

  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    private notifications: NotificationService,
    @Inject(IRSSInterface) private rss: IRSSInterface,
  ) {}

  async createRSSFeed(url: string, channelId: string) {
    await this.subscribe(discordFeed(url, channelId));
  }

  async removeRSSFeed(url: string, channelId: string) {
    await this.database.removeRSSFeed(url, channelId, 'discord');
  }

  async searchRSSFeeds(url: string, channelId: string) {
    let feeds = await this.database.getRSSFeeds({ channelId, service: 'discord' });
    if (url) {
      const query = url.toLowerCase();
      feeds = feeds.filter(({ url }) => url.toLowerCase().includes(query));
    }

    return feeds
      .map(({ url }) => ({
        name: shorten(url, 40),
        value: url,
      }))
      .slice(0, 25);
  }

  async initFeed(url: string, channelId: string) {
    await this.initialise(discordFeed(url, channelId));
  }

  async createZulipRSSFeed(url: string, stream: number, topic: string) {
    await this.subscribe({ url, channelId: String(stream), service: 'zulip', topic });
  }

  removeZulipRSSFeed(url: string, stream: number) {
    return this.database.removeRSSFeed(url, String(stream), 'zulip');
  }

  getZulipRSSFeeds(stream: number) {
    return this.database.getRSSFeeds({ channelId: String(stream), service: 'zulip' });
  }

  @Cron('*/15 * * * *')
  async onFeedUpdates() {
    const feeds = await this.database.getRSSFeeds();

    for (const feed of feeds) {
      try {
        await this.updateFeed(feed);
      } catch (error) {
        this.logger.error(
          `Could not update the RSS feed ${feed.url} in ${feed.service} channel ${feed.channelId}: ${error}`,
        );
      }
    }
  }

  private async subscribe(feed: Feed) {
    await this.database.createRSSFeed(feed);
    try {
      await this.initialise(feed);
    } catch (error) {
      try {
        await this.database.removeRSSFeed(feed.url, feed.channelId, feed.service);
      } catch (cleanup) {
        this.logger.error(`Could not remove the RSS feed ${feed.url} it failed to add: ${cleanup}`);
      }
      throw error;
    }
  }

  private async initialise(feed: Feed) {
    const { feed: fetchedFeed, posts } = await this.rss.getFeed(feed.url, null);
    const post = posts.at(0);

    if (!post) {
      throw new Error(`Could not fetch posts from ${feed.url}`);
    }

    if (!(await this.deliver(feed, fetchedFeed, post))) {
      throw new Error(`Could not post the newest post of ${feed.url}`);
    }

    await this.store(feed, post.id, fetchedFeed);
  }

  private async updateFeed(feed: RSSFeed) {
    const { feed: fetchedFeed, posts } = await this.rss.getFeed(feed.url, feed.lastId);
    let lastId: string | undefined;

    for (const post of posts.toReversed()) {
      if (!(await this.deliver(feed, fetchedFeed, post))) {
        this.logger.warn(`Could not post ${post.id} of the RSS feed ${feed.url}; it is retried on the next poll`);
        break;
      }
      lastId = post.id;
    }

    await this.store(feed, lastId, fetchedFeed);
  }

  private store({ url, channelId, service }: Feed, lastId: string | undefined, { profileImageUrl, title }: FeedItem) {
    return this.database.updateRSSFeed({ url, channelId, service, lastId, profileImageUrl, title });
  }

  private async deliver(feed: Feed, fetchedFeed: FeedItem, post: PostItem) {
    const notification = toRSSNotification(fetchedFeed, post, feed.url);
    const { title, url, body, author, timestamp } = notification;
    if (!title && !url && !body && !author && !timestamp) {
      this.logger.warn(`Skipping ${post.id} of the RSS feed ${feed.url}: it has nothing to post`);
      return true;
    }
    return this.notifications.notifyTarget(toNotificationTarget(feed), notification);
  }
}
