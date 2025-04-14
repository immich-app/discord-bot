export const IRSSInterface = 'IRSSRepository';

export type FeedItem = { profileImageUrl?: string; title?: string };
export type PostItem = { id: string; title?: string; summary?: string; link?: string; pubDate?: string };

export interface IRSSInterface {
  getFeed(url: string, lastId: string | null): Promise<{ feed: FeedItem; posts: PostItem[] }>;
}
