import Parser from 'rss-parser';
import { IRSSInterface, PostItem } from 'src/interfaces/rss.interface';

const parser = new Parser();

export class RSSRepository implements IRSSInterface {
  async getFeed(url: string, lastId: string | null) {
    const feed = await parser.parseURL(url);
    const result: PostItem[] = [];

    for (const { guid, title, summary, link, pubDate, content, contentSnippet } of feed.items) {
      if (!guid) {
        continue;
      }

      if (lastId && guid === lastId) {
        return { feed: { profileImageUrl: feed.image?.url, title: feed.title }, posts: result };
      }

      result.push({ id: guid, title, summary: contentSnippet || summary || content, link, pubDate });
    }

    return { feed: { profileImageUrl: feed.image?.url, title: feed.title }, posts: result };
  }
}
