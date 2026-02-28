import { InsertResult } from 'kysely';
import { DateTime } from 'luxon';
import {
  DiscordLink,
  DiscordLinkUpdate,
  DiscordMessage,
  NewDiscordLink,
  NewDiscordMessage,
  NewFourthwallOrder,
  NewPayment,
  NewPullRequest,
  NewRSSFeed,
  NewScheduledMessage,
  PullRequest,
  RSSFeed,
  ScheduledMessage,
  UpdateDiscordMessage,
  UpdateFourthwallOrder,
  UpdateRSSFeed,
} from 'src/schema';

export const IDatabaseRepository = 'IDatabaseRepository';

export type ReportOptions = {
  day?: DateTime;
  week?: DateTime;
  month?: DateTime;
};

export interface IDatabaseRepository {
  runMigrations(): Promise<void>;
  createPayment(entity: NewPayment): Promise<void>;
  getTotalLicenseCount(options?: ReportOptions): Promise<{ server: number; client: number }>;
  getDiscordLinks(): Promise<DiscordLink[]>;
  getDiscordLink(name: string): Promise<DiscordLink | undefined>;
  addDiscordLink(link: NewDiscordLink): Promise<void>;
  removeDiscordLink(id: string): Promise<void>;
  updateDiscordLink(link: DiscordLinkUpdate): Promise<void>;
  getDiscordMessages(): Promise<DiscordMessage[]>;
  getDiscordMessage(name: string): Promise<DiscordMessage | undefined>;
  addDiscordMessage(message: NewDiscordMessage): Promise<void>;
  updateDiscordMessage(message: UpdateDiscordMessage): Promise<void>;
  removeDiscordMessage(id: string): Promise<void>;
  createFourthwallOrder(entity: NewFourthwallOrder): Promise<void>;
  updateFourthwallOrder(entity: UpdateFourthwallOrder): Promise<void>;
  getTotalFourthwallOrders(options?: ReportOptions): Promise<{ revenue: number; profit: number }>;
  streamFourthwallOrders(): AsyncIterableIterator<{ id: string }>;
  createRSSFeed(entity: NewRSSFeed): Promise<void>;
  getRSSFeeds(channelId?: string): Promise<RSSFeed[]>;
  removeRSSFeed(url: string, channelId: string): Promise<void>;
  updateRSSFeed(entity: UpdateRSSFeed): Promise<void>;
  getScheduledMessages(): Promise<ScheduledMessage[]>;
  getScheduledMessage(name: string): Promise<ScheduledMessage | undefined>;
  createScheduledMessage(entity: NewScheduledMessage): Promise<ScheduledMessage>;
  removeScheduledMessage(id: string): Promise<void>;
  createPullRequest(entity: NewPullRequest): Promise<InsertResult>;
  getPullRequestById(id: number): Promise<PullRequest | undefined>;
}
