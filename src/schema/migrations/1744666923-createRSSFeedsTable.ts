import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('rss_feeds')
    .addColumn('url', 'varchar', (oc) => oc.notNull())
    .addColumn('channelId', 'varchar', (oc) => oc.notNull())
    .addColumn('lastId', 'varchar')
    .addColumn('title', 'varchar')
    .addColumn('profileImageUrl', 'varchar')
    .addPrimaryKeyConstraint('url_channelId', ['url', 'channelId'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('rss_feeds').execute();
}
