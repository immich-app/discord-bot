import { Logger } from '@nestjs/common';
import { FileMigrationProvider, Insertable, Kysely, Migrator, PostgresDialect } from 'kysely';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import Cursor from 'pg-cursor';
import { getConfig } from 'src/config';
import { IDatabaseRepository, ReportOptions } from 'src/interfaces/database.interface';
import {
  Database,
  DiscordLink,
  DiscordLinkUpdate,
  DiscordMessage,
  NewDiscordLink,
  NewDiscordMessage,
  NewFourthwallOrder,
  NewPayment,
  NewRSSFeed,
  NewScheduledMessage,
  RSSFeed,
  ScheduledMessage,
  UpdateDiscordMessage,
  UpdateFourthwallOrder,
  UpdateRSSFeed,
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
      .where('status', '=', 'succeeded');

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

  async getRSSFeeds(channelId?: string): Promise<RSSFeed[]> {
    return this.db
      .selectFrom('rss_feed')
      .selectAll()
      .$if(!!channelId, (qb) => qb.where('rss_feed.channelId', '=', channelId!))
      .execute();
  }

  async removeRSSFeed(url: string, channelId: string): Promise<void> {
    await this.db
      .deleteFrom('rss_feed')
      .where('rss_feed.url', '=', url)
      .where('rss_feed.channelId', '=', channelId)
      .execute();
  }

  async updateRSSFeed(entity: UpdateRSSFeed): Promise<void> {
    await this.db
      .updateTable('rss_feed')
      .set(entity)
      .where('rss_feed.url', '=', entity.url)
      .where('rss_feed.channelId', '=', entity.channelId)
      .execute();
  }

  getScheduledMessages(): Promise<ScheduledMessage[]> {
    return this.db.selectFrom('scheduled_message').selectAll().execute();
  }

  getScheduledMessage(name: string): Promise<ScheduledMessage | undefined> {
    return this.db.selectFrom('scheduled_message').where('name', '=', name).selectAll().executeTakeFirst();
  }

  createScheduledMessage(entity: NewScheduledMessage): Promise<ScheduledMessage> {
    return this.db.insertInto('scheduled_message').values(entity).returningAll().executeTakeFirstOrThrow();
  }

  async removeScheduledMessage(id: string): Promise<void> {
    await this.db.deleteFrom('scheduled_message').where('id', '=', id).execute();
  }

  createPullRequest(entity: Insertable<PullRequestTable>) {
    return this.db.insertInto('pull_request').values(entity).executeTakeFirst();
  }

  getPullRequestById(id: number) {
    return this.db.selectFrom('pull_request').selectAll().where('id', '=', id).executeTakeFirst();
  }
}
