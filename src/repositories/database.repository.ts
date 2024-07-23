import { Logger } from '@nestjs/common';
import { FileMigrationProvider, Kysely, Migrator, PostgresDialect } from 'kysely';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { config } from 'src/config';
import { Database, IDatabaseRepository, LicenseType, NewPayment } from 'src/interfaces/database.interface';

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({
      connectionString: config.database.uri,
    }),
  }),
});

export class DatabaseRepository implements IDatabaseRepository {
  private logger = new Logger(DatabaseRepository.name);

  async runMigrations() {
    const migrator = new Migrator({
      db,
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
    await db.insertInto('payment').values(entity).execute();
  }

  async getTotalLicenseCount() {
    const result = await db
      .selectFrom('payment')
      .select([(b) => b.fn.count<number>('description').as('product_count'), 'description'])
      .where('livemode', '=', true)
      .where('status', '=', 'succeeded')
      .groupBy('description')
      .execute();

    return {
      server: result.find((r) => r.description === 'immich-server')?.product_count || 0,
      client: result.find((r) => r.description === 'immich-client')?.product_count || 0,
    };
  }

  async getSponsorLicenses(githubUsername: string) {
    const sponsor = await db
      .selectFrom('sponsor')
      .selectAll()
      .where('username', '=', githubUsername)
      .executeTakeFirst();

    if (!sponsor) {
      return [];
    }

    await db.updateTable('sponsor').set('claimed', true).where('username', '=', githubUsername).execute();

    return sponsor.licenses.map(({ activation, license }) => ({
      type: sponsor.license_type === 'client' ? LicenseType.Client : LicenseType.Server,
      licenseKey: license,
      activationKey: activation,
    }));
  }
}
