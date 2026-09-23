import { InsertResult, Updateable } from 'kysely';
import { DateTime } from 'luxon';
import {
  DiscordLink,
  DiscordLinkUpdate,
  DiscordMessage,
  MirrorConversation,
  MirrorMessage,
  NewDiscordLink,
  NewDiscordMessage,
  NewFourthwallOrder,
  NewMirrorConversation,
  NewMirrorMessage,
  NewPayment,
  NewPullRequest,
  NewRSSFeed,
  NewScheduledMessage,
  PullRequest,
  RSSFeed,
  ScheduledMessage,
  UpdateDiscordMessage,
  UpdateFourthwallOrder,
  UpdateMirrorConversation,
  UpdateMirrorMessage,
  UpdateRSSFeed,
  UpdateScheduledMessage,
} from 'src/schema';
import { PullRequestTable } from 'src/schema/tables/pull-request.table';

export const IDatabaseRepository = 'IDatabaseRepository';

export type MirrorMessageQuery = { withDeleted?: boolean };

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
  getRSSFeeds(channel?: Pick<RSSFeed, 'channelId' | 'service'>): Promise<RSSFeed[]>;
  removeRSSFeed(url: string, channelId: string, service: RSSFeed['service']): Promise<boolean>;
  updateRSSFeed(entity: UpdateRSSFeed): Promise<void>;
  getScheduledMessages(service?: ScheduledMessage['service']): Promise<ScheduledMessage[]>;
  getScheduledMessage(name: string, service: ScheduledMessage['service']): Promise<ScheduledMessage | undefined>;
  createScheduledMessage(entity: NewScheduledMessage): Promise<ScheduledMessage>;
  updateScheduledMessage(entity: UpdateScheduledMessage & { name: string }): Promise<ScheduledMessage | undefined>;
  removeScheduledMessage(id: string): Promise<void>;
  createPullRequest(entity: NewPullRequest): Promise<InsertResult>;
  getPullRequestById(nodeId: string): Promise<PullRequest | undefined>;
  updatePullRequest(entity: Updateable<PullRequestTable> & { nodeId: string }): Promise<void>;
  upsertPullRequest({ nodeId, ...entity }: NewPullRequest): Promise<void>;
  getLatestPullRequestByNumber(number: number): Promise<PullRequest | undefined>;
  getMirrorConversation(id: string): Promise<MirrorConversation | undefined>;
  getMirrorConversationByDiscord(
    discordChannelId: string,
    discordThreadId: string | null,
  ): Promise<MirrorConversation | undefined>;
  getMirrorConversationByZulipTopic(
    zulipStreamId: number,
    zulipTopicKey: string,
  ): Promise<MirrorConversation | undefined>;
  getMirrorConversationsByAnchors(zulipMessageIds: number[]): Promise<MirrorConversation[]>;
  /** Thread and post conversations with a row created since `since`, newest activity first. */
  getActiveMirrorThreads(discordChannelId: string, since: Date, limit: number): Promise<MirrorConversation[]>;
  createMirrorConversation(entity: NewMirrorConversation): Promise<MirrorConversation>;
  updateMirrorConversation(id: string, changes: UpdateMirrorConversation): Promise<void>;
  removeMirrorConversation(id: string): Promise<void>;
  createMirrorMessages(rows: NewMirrorMessage[]): Promise<void>;
  getMirrorMessagesByDiscordIds(ids: string[], options?: MirrorMessageQuery): Promise<MirrorMessage[]>;
  /** Ordered by zulipMessageId, then part. */
  getMirrorMessagesByZulipIds(ids: number[], options?: MirrorMessageQuery): Promise<MirrorMessage[]>;
  getNewestMirrorZulipMessageId(conversationId: string): Promise<number | undefined>;
  updateMirrorMessages(discordMessageIds: string[], changes: UpdateMirrorMessage): Promise<void>;
  markMirrorMessagesDeleted(discordMessageIds: string[]): Promise<void>;
  removeMirrorMessages(discordMessageIds: string[]): Promise<void>;
  /** max("zulipMessageId") of origin 'zulip' rows in the stream, deleted ones included. */
  getMirrorZulipHighWater(zulipStreamId: number): Promise<number | undefined>;
  /**
   * Newest origin 'discord' row in the channel or thread, deleted ones included, ordered by
   * (length("discordMessageId"), "discordMessageId").
   */
  getMirrorDiscordHighWater(discordChannelId: string, discordThreadId: string | null): Promise<string | undefined>;
}
