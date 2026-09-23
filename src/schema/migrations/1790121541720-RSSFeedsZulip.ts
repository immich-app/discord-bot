import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "rss_feed" ADD "service" character varying NOT NULL DEFAULT 'discord';`.execute(db);
  await sql`ALTER TABLE "rss_feed" ADD "topic" character varying;`.execute(db);
  await sql`ALTER TABLE "rss_feed" DROP CONSTRAINT "rss_feed_pkey";`.execute(db);
  await sql`ALTER TABLE "rss_feed" ADD CONSTRAINT "rss_feed_pkey" PRIMARY KEY ("url", "channelId", "service");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM "rss_feed" WHERE "service" <> 'discord';`.execute(db);
  await sql`ALTER TABLE "rss_feed" DROP CONSTRAINT "rss_feed_pkey";`.execute(db);
  await sql`ALTER TABLE "rss_feed" ADD CONSTRAINT "rss_feed_pkey" PRIMARY KEY ("url", "channelId");`.execute(db);
  await sql`ALTER TABLE "rss_feed" DROP COLUMN "topic";`.execute(db);
  await sql`ALTER TABLE "rss_feed" DROP COLUMN "service";`.execute(db);
}
