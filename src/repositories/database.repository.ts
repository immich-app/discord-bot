import { Logger } from '@nestjs/common';
import { FileMigrationProvider, Kysely, Migrator, PostgresDialect } from 'kysely';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { getConfig } from 'src/config';
import {
  Database,
  DiscordLink,
  DiscordLinkUpdate,
  IDatabaseRepository,
  LicenseCountOptions,
  LicenseType,
  NewDiscordLink,
  NewPayment,
} from 'src/interfaces/database.interface';

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
      }),
    });
  }

  async runMigrations() {
    const migrator = new Migrator({
      db: this.db,
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: path.join(__dirname, '..', 'migrations'),
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

  async getTotalLicenseCount(options: LicenseCountOptions) {
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

  async getSponsorLicenses(githubUsername: string) {
    const sponsor = await this.db
      .selectFrom('sponsor')
      .selectAll()
      .where('username', '=', githubUsername)
      .executeTakeFirst();

    if (!sponsor) {
      return [];
    }

    await this.db.updateTable('sponsor').set('claimed', true).where('username', '=', githubUsername).execute();

    return sponsor.licenses.map(({ activation, license }) => ({
      type: sponsor.license_type === 'client' ? LicenseType.Client : LicenseType.Server,
      licenseKey: license,
      activationKey: activation,
    }));
  }

  getDiscordLinks(): Promise<DiscordLink[]> {
    return this.db.selectFrom('discord_links').selectAll().execute();
  }

  getDiscordLink(name: string): Promise<DiscordLink | undefined> {
    return this.db.selectFrom('discord_links').where('name', '=', name).selectAll().executeTakeFirst();
  }

  async addDiscordLink(link: NewDiscordLink) {
    await this.db.insertInto('discord_links').values(link).execute();
  }

  async removeDiscordLink(id: string) {
    await this.db.deleteFrom('discord_links').where('id', '=', id).execute();
  }

  async updateDiscordLink({ id, ...link }: DiscordLinkUpdate) {
    await this.db.updateTable('discord_links').set(link).where('id', '=', id).execute();
  }
}
