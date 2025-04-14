import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EmbedBuilder } from 'discord.js';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { FeedItem, IRSSInterface, PostItem } from 'src/interfaces/rss.interface';
import { shorten } from 'src/util';

@Injectable()
export class RSSService {
  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
    @Inject(IRSSInterface) private rss: IRSSInterface,
  ) {}

  async createRSSFeed(url: string, channelId: string) {
    await this.database.createRSSFeed({ url, channelId });
    await this.initFeed(url, channelId);
  }

  async removeRSSFeed(url: string, channelId: string) {
    await this.database.removeRSSFeed(url, channelId);
  }

  async searchRSSFeeds(url: string, channelId: string) {
    let feeds = await this.database.getRSSFeeds(channelId);
    if (url) {
      const query = url.toLowerCase();
      feeds = feeds.filter(({ url }) => url.toLowerCase().includes(query));
    }

    return feeds.map(({ url }) => ({
      name: shorten(url, 40),
      value: url,
    }));
  }

  async initFeed(url: string, channelId: string) {
    const { feed: fetchedFeed, posts } = await this.rss.getFeed(url, null);
    const post = posts.at(0);

    if (!post) {
      throw new Error(`Could not fetch posts from ${url}`);
    }

    await this.processPosts(fetchedFeed, [post], url, channelId);
    await this.database.updateRSSFeed({
      url: url,
      channelId: channelId,
      lastId: post.id,
      profileImageUrl: fetchedFeed.profileImageUrl,
      title: fetchedFeed.title,
    });
  }

  @Cron('*/15 * * * *')
  async onFeedUpdates() {
    const feeds = await this.database.getRSSFeeds();

    for (const feed of feeds) {
      await this.updateFeed(feed);
    }
  }

  private async updateFeed(feed: { url: string; lastId: string | null; channelId: string }) {
    const { feed: fetchedFeed, posts } = await this.rss.getFeed(feed.url, feed.lastId);
    const newLastId = posts.at(0)?.id;

    await this.processPosts(fetchedFeed, posts, feed.url, feed.channelId);

    await this.database.updateRSSFeed({
      url: feed.url,
      channelId: feed.channelId,
      lastId: newLastId,
      profileImageUrl: fetchedFeed.profileImageUrl,
      title: fetchedFeed.title,
    });
  }

  private async processPosts(feed: FeedItem, posts: PostItem[], url: string, channelId: string) {
    for (const post of posts.toReversed()) {
      await this.discord.sendMessage({
        channelId: channelId,
        message: {
          embeds: [
            new EmbedBuilder()
              .setAuthor(feed.title ? { name: feed.title, iconURL: feed.profileImageUrl, url: url } : null)
              .setTitle(post.title ?? null)
              .setDescription(post.summary ?? null)
              .setTimestamp(post.pubDate ? new Date(post.pubDate) : null)
              .setURL(post.link ?? null),
          ],
        },
      });
    }
  }
}
