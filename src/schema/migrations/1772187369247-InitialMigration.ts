import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`.execute(db);
  await sql`CREATE TABLE "migration_overrides" (
  "name" character varying NOT NULL,
  "value" jsonb NOT NULL,
  CONSTRAINT "migration_overrides_pkey" PRIMARY KEY ("name")
);`.execute(db);
  await sql`ALTER TABLE "discord_links" ALTER COLUMN "id" SET DEFAULT uuid_generate_v4();`.execute(db);
  await sql`ALTER TABLE "discord_messages" ALTER COLUMN "id" SET DEFAULT uuid_generate_v4();`.execute(db);
  await sql`ALTER TABLE "scheduled_messages" ALTER COLUMN "id" SET DEFAULT uuid_generate_v4();`.execute(db);
  await sql`ALTER TABLE "discord_links" ALTER COLUMN "createdAt" TYPE timestamp with time zone USING "createdAt"::timestamptz;`.execute(db);
  await sql`ALTER TABLE "discord_messages" ALTER COLUMN "createdAt" TYPE timestamp with time zone USING "createdAt"::timestamptz;`.execute(db);
  await sql`ALTER TABLE "fourthwall_orders" ALTER COLUMN "createdAt" TYPE timestamp with time zone USING "createdAt"::timestamptz;`.execute(db);
  await sql`ALTER TABLE "scheduled_messages" ALTER COLUMN "message" TYPE character varying;`.execute(db);
  await sql`ALTER TABLE "discord_links" RENAME CONSTRAINT "discord_links_name_key" TO "discord_links_name_uq";`.execute(db);
  await sql`ALTER TABLE "discord_messages" RENAME CONSTRAINT "discord_messages_content_key" TO "discord_messages_content_uq";`.execute(db);
  await sql`ALTER TABLE "rss_feeds" RENAME CONSTRAINT "url_channelId" TO "rss_feeds_pkey";`.execute(db);
  await sql`ALTER TABLE "scheduled_messages" RENAME CONSTRAINT "scheduled_messages_name_key" TO "scheduled_messages_name_uq";`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "discord_links" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();`.execute(db);
  await sql`ALTER TABLE "discord_messages" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();`.execute(db);
  await sql`ALTER TABLE "scheduled_messages" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();`.execute(db);
  await sql`ALTER TABLE "discord_links" RENAME CONSTRAINT "discord_links_name_uq" TO "discord_links_name_key";`.execute(db);
  await sql`ALTER TABLE "discord_messages" RENAME CONSTRAINT "discord_messages_content_uq" TO "discord_messages_content_key";`.execute(db);
  await sql`ALTER TABLE "rss_feeds" RENAME CONSTRAINT "rss_feeds_pkey" TO "url_channelId";`.execute(db);
  await sql`ALTER TABLE "scheduled_messages" RENAME CONSTRAINT "scheduled_messages_name_uq" TO "scheduled_messages_name_key";`.execute(db);
  await sql`DROP TABLE "migration_overrides";`.execute(db);
  // only partially supported
}
