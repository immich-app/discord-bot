import { Logger } from '@nestjs/common';
import { Insertable, Kysely, PostgresDialect, sql, Updateable } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import Cursor from 'pg-cursor';
import { getConfig } from 'src/config';
import {
  IDatabaseRepository,
  MirrorIdentityOwner,
  MirrorMessageQuery,
  ReportOptions,
} from 'src/interfaces/database.interface';
import {
  Database,
  DiscordLink,
  DiscordLinkUpdate,
  DiscordMessage,
  MirrorConversation,
  MirrorIdentity,
  MirrorLink,
  MirrorMessage,
  NewDiscordLink,
  NewDiscordMessage,
  NewFourthwallOrder,
  NewMirrorConversation,
  NewMirrorLink,
  NewMirrorMessage,
  NewPayment,
  NewRSSFeed,
  NewScheduledMessage,
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

export class DatabaseRepository implements IDatabaseRepository {
  private logger = new Logger(DatabaseRepository.name);
  private db: Kysely<Database>;

  constructor() {
    const { database } = getConfig();
    this.db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          connectionString: database.uri,
        }),
        cursor: Cursor,
      }),
    });
  }

  async runMigrations() {
    const migrator = new Migrator({
      db: this.db,
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: path.join(__dirname, '..', 'schema', 'migrations'),
      }),
    });

    const { error, results } = await migrator.migrateToLatest();
    results?.forEach((it) => {
      if (it.status === 'Success') {
        this.logger.log(`migration "${it.migrationName}" was executed successfully`);
      } else if (it.status === 'Error') {
        this.logger.error(`failed to execute migration "${it.migrationName}"`);
      }
    });

    if (error) {
      this.logger.error(error, (error as Error)?.stack);
      throw new Error('Failed to run database migrations');
    }
  }

  async createPayment(entity: NewPayment) {
    await this.db.insertInto('payment').values(entity).execute();
  }

  async getTotalLicenseCount(options?: ReportOptions) {
    const { day, week, month } = options || {};
    let builder = this.db
      .selectFrom('payment')
      .select([(b) => b.fn.count<number>('description').as('product_count'), 'description'])
      .groupBy('description')
      .where('livemode', '=', true)
      .where((eb) => eb.or([eb('status', '=', 'succeeded'), eb('status', '=', 'paid')]));

    if (day) {
      builder = builder.where((eq) =>
        eq.between('created', day.minus({ days: 1 }).toUnixInteger(), day.toUnixInteger()),
      );
    }

    if (week) {
      builder = builder.where((eq) =>
        eq.between('created', week.minus({ week: 1 }).toUnixInteger(), week.toUnixInteger()),
      );
    }

    if (month) {
      builder = builder.where((eq) =>
        eq.between('created', month.minus({ month: 1 }).toUnixInteger(), month.toUnixInteger()),
      );
    }

    this.logger.log(`Query: ${builder.compile().sql}`);

    const result = await builder.execute();

    return {
      server: result.find((r) => r.description === 'immich-server')?.product_count || 0,
      client: result.find((r) => r.description === 'immich-client')?.product_count || 0,
    };
  }

  getDiscordLinks(): Promise<DiscordLink[]> {
    return this.db.selectFrom('discord_link').selectAll().execute();
  }

  getDiscordLink(name: string): Promise<DiscordLink | undefined> {
    return this.db.selectFrom('discord_link').where('name', '=', name).selectAll().executeTakeFirst();
  }

  async addDiscordLink(link: NewDiscordLink) {
    await this.db.insertInto('discord_link').values(link).execute();
  }

  async removeDiscordLink(id: string) {
    await this.db.deleteFrom('discord_link').where('id', '=', id).execute();
  }

  async updateDiscordLink({ id, ...link }: DiscordLinkUpdate) {
    await this.db.updateTable('discord_link').set(link).where('id', '=', id).execute();
  }

  getDiscordMessages(): Promise<DiscordMessage[]> {
    return this.db.selectFrom('discord_message').selectAll().execute();
  }

  getDiscordMessage(name: string): Promise<DiscordMessage | undefined> {
    return this.db.selectFrom('discord_message').where('name', '=', name).selectAll().executeTakeFirst();
  }

  async addDiscordMessage(message: NewDiscordMessage): Promise<void> {
    await this.db.insertInto('discord_message').values(message).execute();
  }

  async removeDiscordMessage(id: string): Promise<void> {
    await this.db.deleteFrom('discord_message').where('id', '=', id).execute();
  }

  async updateDiscordMessage({ id, ...message }: UpdateDiscordMessage): Promise<void> {
    await this.db.updateTable('discord_message').set(message).where('id', '=', id).execute();
  }

  async createFourthwallOrder(entity: NewFourthwallOrder): Promise<void> {
    await this.db
      .insertInto('fourthwall_order')
      .onConflict((oc) => oc.doNothing())
      .values(entity)
      .execute();
  }

  async updateFourthwallOrder({ id, ...entity }: UpdateFourthwallOrder): Promise<void> {
    await this.db.updateTable('fourthwall_order').set(entity).where('id', '=', id).execute();
  }

  async getTotalFourthwallOrders(options?: ReportOptions): Promise<{ revenue: number; profit: number }> {
    const { day, week, month } = options || {};
    const { revenue, profit } = await this.db
      .selectFrom('fourthwall_order')
      .select([(eb) => eb.fn.sum('revenue').as('revenue'), (eb) => eb.fn.sum('profit').as('profit')])
      .where('testMode', '=', false)
      .$if(!!day, (qb) =>
        qb.where((eb) => eb.between('createdAt', day!.minus({ days: 1 }).toJSDate(), day!.toJSDate())),
      )
      .$if(!!week, (qb) =>
        qb.where((eb) => eb.between('createdAt', week!.minus({ weeks: 1 }).toJSDate(), week!.toJSDate())),
      )
      .$if(!!month, (qb) =>
        qb.where((eb) => eb.between('createdAt', month!.minus({ months: 1 }).toJSDate(), month!.toJSDate())),
      )
      .executeTakeFirstOrThrow();

    return { revenue: Number(revenue) || 0, profit: Number(profit) || 0 };
  }

  streamFourthwallOrders() {
    return this.db.selectFrom('fourthwall_order').select('id').stream();
  }

  async createRSSFeed(entity: NewRSSFeed): Promise<void> {
    await this.db.insertInto('rss_feed').values(entity).execute();
  }

  async getRSSFeeds(channel?: Pick<RSSFeed, 'channelId' | 'service'>): Promise<RSSFeed[]> {
    return this.db
      .selectFrom('rss_feed')
      .selectAll()
      .$if(!!channel, (qb) =>
        qb.where('rss_feed.channelId', '=', channel!.channelId).where('rss_feed.service', '=', channel!.service),
      )
      .execute();
  }

  async removeRSSFeed(url: string, channelId: string, service: RSSFeed['service']): Promise<boolean> {
    const { numDeletedRows } = await this.db
      .deleteFrom('rss_feed')
      .where('rss_feed.url', '=', url)
      .where('rss_feed.channelId', '=', channelId)
      .where('rss_feed.service', '=', service)
      .executeTakeFirst();
    return numDeletedRows > 0n;
  }

  async updateRSSFeed(entity: UpdateRSSFeed): Promise<void> {
    await this.db
      .updateTable('rss_feed')
      .set(entity)
      .where('rss_feed.url', '=', entity.url)
      .where('rss_feed.channelId', '=', entity.channelId)
      .where('rss_feed.service', '=', entity.service)
      .execute();
  }

  getScheduledMessages(service?: ScheduledMessage['service']): Promise<ScheduledMessage[]> {
    return this.db
      .selectFrom('scheduled_message')
      .selectAll()
      .$if(service !== undefined, (qb) => qb.where('service', '=', service!))
      .execute();
  }

  getScheduledMessage(name: string, service: ScheduledMessage['service']): Promise<ScheduledMessage | undefined> {
    return this.db
      .selectFrom('scheduled_message')
      .where('name', '=', name)
      .where('service', '=', service)
      .selectAll()
      .executeTakeFirst();
  }

  createScheduledMessage(entity: NewScheduledMessage): Promise<ScheduledMessage> {
    return this.db.insertInto('scheduled_message').values(entity).returningAll().executeTakeFirstOrThrow();
  }

  updateScheduledMessage(entity: UpdateScheduledMessage & { name: string }) {
    return this.db
      .updateTable('scheduled_message')
      .set(entity)
      .where('name', '=', entity.name)
      .returningAll()
      .executeTakeFirst();
  }

  async removeScheduledMessage(id: string): Promise<void> {
    await this.db.deleteFrom('scheduled_message').where('id', '=', id).execute();
  }

  createPullRequest(entity: Insertable<PullRequestTable>) {
    return this.db.insertInto('pull_request').values(entity).executeTakeFirst();
  }

  getPullRequestById(nodeId: string) {
    return this.db.selectFrom('pull_request').selectAll().where('nodeId', '=', nodeId).executeTakeFirst();
  }

  async updatePullRequest({ nodeId, ...entity }: Updateable<PullRequestTable> & { nodeId: string }) {
    await this.db.updateTable('pull_request').set(entity).where('nodeId', '=', nodeId).execute();
  }

  async upsertPullRequest({ nodeId, ...entity }: Insertable<PullRequestTable>) {
    await this.db
      .insertInto('pull_request')
      .values({ nodeId, ...entity })
      .onConflict((oc) => oc.column('nodeId').doUpdateSet(entity))
      .execute();
  }

  async getLatestPullRequestByNumber(number: number) {
    return this.db
      .selectFrom('pull_request')
      .selectAll()
      .where('number', '=', number)
      .orderBy('updatedAt', 'desc')
      .executeTakeFirst();
  }

  getMirrorConversation(id: string): Promise<MirrorConversation | undefined> {
    return this.db.selectFrom('mirror_conversation').selectAll().where('id', '=', id).executeTakeFirst();
  }

  getMirrorConversationByDiscord(
    discordChannelId: string,
    discordThreadId: string | null,
  ): Promise<MirrorConversation | undefined> {
    return this.db
      .selectFrom('mirror_conversation')
      .selectAll()
      .where('discordChannelId', '=', discordChannelId)
      .where('discordThreadId', discordThreadId === null ? 'is' : '=', discordThreadId)
      .executeTakeFirst();
  }

  getMirrorConversationByZulipTopic(
    zulipStreamId: number,
    zulipTopicKey: string,
  ): Promise<MirrorConversation | undefined> {
    return this.db
      .selectFrom('mirror_conversation')
      .selectAll()
      .where('zulipStreamId', '=', zulipStreamId)
      .where('zulipTopicKey', '=', zulipTopicKey)
      .executeTakeFirst();
  }

  async getMirrorConversationsByAnchors(zulipMessageIds: number[]): Promise<MirrorConversation[]> {
    if (zulipMessageIds.length === 0) {
      return [];
    }

    return this.db
      .selectFrom('mirror_conversation')
      .selectAll()
      .where('zulipAnchorMessageId', 'in', zulipMessageIds)
      .execute();
  }

  getActiveMirrorThreads(discordChannelId: string, since: Date, limit: number): Promise<MirrorConversation[]> {
    return this.db
      .selectFrom('mirror_conversation')
      .innerJoin('mirror_message', 'mirror_message.conversationId', 'mirror_conversation.id')
      .selectAll('mirror_conversation')
      .where('mirror_conversation.discordChannelId', '=', discordChannelId)
      .where('mirror_conversation.discordThreadId', 'is not', null)
      .where('mirror_message.createdAt', '>=', since)
      .groupBy('mirror_conversation.id')
      .orderBy((eb) => eb.fn.max('mirror_message.createdAt'), 'desc')
      .limit(limit)
      .execute();
  }

  createMirrorConversation(entity: NewMirrorConversation): Promise<MirrorConversation> {
    return this.db.insertInto('mirror_conversation').values(entity).returningAll().executeTakeFirstOrThrow();
  }

  async updateMirrorConversation(id: string, changes: UpdateMirrorConversation): Promise<void> {
    await this.db
      .updateTable('mirror_conversation')
      .set({ updatedAt: sql<Date>`now()`, ...changes })
      .where('id', '=', id)
      .execute();
  }

  async removeMirrorConversation(id: string): Promise<void> {
    await this.db.deleteFrom('mirror_conversation').where('id', '=', id).execute();
  }

  async createMirrorMessages(rows: NewMirrorMessage[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    await this.db.insertInto('mirror_message').values(rows).execute();
  }

  async getMirrorMessagesByDiscordIds(
    ids: string[],
    { withDeleted = false }: MirrorMessageQuery = {},
  ): Promise<MirrorMessage[]> {
    if (ids.length === 0) {
      return [];
    }

    return this.db
      .selectFrom('mirror_message')
      .selectAll()
      .where('discordMessageId', 'in', ids)
      .$if(!withDeleted, (qb) => qb.where('deletedAt', 'is', null))
      .execute();
  }

  async getMirrorMessagesByZulipIds(
    ids: number[],
    { withDeleted = false }: MirrorMessageQuery = {},
  ): Promise<MirrorMessage[]> {
    if (ids.length === 0) {
      return [];
    }

    return this.db
      .selectFrom('mirror_message')
      .selectAll()
      .where('zulipMessageId', 'in', ids)
      .$if(!withDeleted, (qb) => qb.where('deletedAt', 'is', null))
      .orderBy('zulipMessageId')
      .orderBy('part')
      .execute();
  }

  getMirrorMessagesByConversation(conversationId: string): Promise<MirrorMessage[]> {
    return this.db
      .selectFrom('mirror_message')
      .selectAll()
      .where('conversationId', '=', conversationId)
      .where('deletedAt', 'is', null)
      .execute();
  }

  async getNewestMirrorZulipMessageId(conversationId: string): Promise<number | undefined> {
    const { newest } = await this.db
      .selectFrom('mirror_message')
      .select((eb) => eb.fn.max('zulipMessageId').as('newest'))
      .where('conversationId', '=', conversationId)
      .where('deletedAt', 'is', null)
      .executeTakeFirstOrThrow();
    return newest ?? undefined;
  }

  async updateMirrorMessages(discordMessageIds: string[], changes: UpdateMirrorMessage): Promise<void> {
    if (discordMessageIds.length === 0) {
      return;
    }

    await this.db
      .updateTable('mirror_message')
      .set(changes)
      .where('discordMessageId', 'in', discordMessageIds)
      .execute();
  }

  async markMirrorMessagesDeleted(discordMessageIds: string[]): Promise<void> {
    if (discordMessageIds.length === 0) {
      return;
    }

    await this.db
      .updateTable('mirror_message')
      .set({ deletedAt: sql<Date>`now()` })
      .where('discordMessageId', 'in', discordMessageIds)
      .where('deletedAt', 'is', null)
      .execute();
  }

  async removeMirrorMessages(discordMessageIds: string[]): Promise<void> {
    if (discordMessageIds.length === 0) {
      return;
    }

    await this.db.deleteFrom('mirror_message').where('discordMessageId', 'in', discordMessageIds).execute();
  }

  async getMirrorZulipHighWater(zulipStreamId: number): Promise<number | undefined> {
    const { highWater } = await this.db
      .selectFrom('mirror_message')
      .select((eb) => eb.fn.max('zulipMessageId').as('highWater'))
      .where('origin', '=', 'zulip')
      .where('zulipStreamId', '=', zulipStreamId)
      .executeTakeFirstOrThrow();
    return highWater ?? undefined;
  }

  async getMirrorDiscordHighWater(
    discordChannelId: string,
    discordThreadId: string | null,
  ): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('mirror_message')
      .select('discordMessageId')
      .where('origin', '=', 'discord')
      .where('discordChannelId', '=', discordChannelId)
      .where('discordThreadId', discordThreadId === null ? 'is' : '=', discordThreadId)
      .orderBy((eb) => eb.fn('length', ['discordMessageId']), 'desc')
      .orderBy('discordMessageId', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.discordMessageId;
  }

  getMirrorLinks(): Promise<MirrorLink[]> {
    return this.db.selectFrom('mirror_link').selectAll().orderBy('createdAt').execute();
  }

  createMirrorLink(entity: NewMirrorLink): Promise<MirrorLink> {
    return this.db.insertInto('mirror_link').values(entity).returningAll().executeTakeFirstOrThrow();
  }

  async setMirrorLinkAnnouncement(discordChannelId: string, discordAnnouncementId: string | null): Promise<void> {
    await this.db
      .updateTable('mirror_link')
      .set({ discordAnnouncementId })
      .where('discordChannelId', '=', discordChannelId)
      .execute();
  }

  removeMirrorLink(discordChannelId: string): Promise<MirrorLink | undefined> {
    return this.db
      .deleteFrom('mirror_link')
      .where('discordChannelId', '=', discordChannelId)
      .returningAll()
      .executeTakeFirst();
  }

  getMirrorIdentities(): Promise<MirrorIdentity[]> {
    return this.db.selectFrom('mirror_identity').selectAll().orderBy('createdAt').execute();
  }

  setMirrorIdentity(zulipUserId: number, discordUserId: string): Promise<MirrorIdentity[]> {
    return this.db.transaction().execute(async (trx) => {
      const replaced = await trx
        .deleteFrom('mirror_identity')
        .where((eb) => eb.or([eb('zulipUserId', '=', zulipUserId), eb('discordUserId', '=', discordUserId)]))
        .returningAll()
        .execute();
      await trx.insertInto('mirror_identity').values({ zulipUserId, discordUserId }).execute();
      return replaced;
    });
  }

  removeMirrorIdentity(owner: MirrorIdentityOwner): Promise<MirrorIdentity | undefined> {
    const query = this.db.deleteFrom('mirror_identity');
    const matching =
      'zulipUserId' in owner
        ? query.where('zulipUserId', '=', owner.zulipUserId)
        : query.where('discordUserId', '=', owner.discordUserId);
    return matching.returningAll().executeTakeFirst();
  }
}
