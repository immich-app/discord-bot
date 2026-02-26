import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "discord_links" RENAME TO "discord_link";`.execute(db);
  await sql`ALTER TABLE "discord_messages" RENAME TO "discord_message";`.execute(db);
  await sql`ALTER TABLE "fourthwall_orders" RENAME TO "fourthwall_order";`.execute(db);
  await sql`ALTER TABLE "rss_feeds" RENAME TO "rss_feed";`.execute(db);
  await sql`ALTER TABLE "scheduled_messages" RENAME TO "scheduled_message";`.execute(db);
  await sql`ALTER TABLE "discord_link" RENAME CONSTRAINT "discord_links_pkey" TO "discord_link_pkey";`.execute(db);
  await sql`ALTER TABLE "discord_link" RENAME CONSTRAINT "discord_links_name_uq" TO "discord_link_name_uq";`.execute(db);
  await sql`ALTER TABLE "discord_message" RENAME CONSTRAINT "discord_messages_pkey" TO "discord_message_pkey";`.execute(db);
  await sql`ALTER TABLE "discord_message" RENAME CONSTRAINT "discord_messages_content_uq" TO "discord_message_content_uq";`.execute(db);
  await sql`ALTER TABLE "fourthwall_order" RENAME CONSTRAINT "fourthwall_orders_pkey" TO "fourthwall_order_pkey";`.execute(db);
  await sql`ALTER TABLE "rss_feed" RENAME CONSTRAINT "rss_feeds_pkey" TO "rss_feed_pkey";`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "discord_link" RENAME CONSTRAINT "discord_link_name_uq" TO "discord_links_name_uq";`.execute(db);
  await sql`ALTER TABLE "discord_link" RENAME CONSTRAINT "discord_link_pkey" TO "discord_links_pkey";`.execute(db);
  await sql`ALTER TABLE "discord_message" RENAME CONSTRAINT "discord_message_content_uq" TO "discord_messages_content_uq";`.execute(db);
  await sql`ALTER TABLE "discord_message" RENAME CONSTRAINT "discord_message_pkey" TO "discord_messages_pkey";`.execute(db);
  await sql`ALTER TABLE "fourthwall_order" RENAME CONSTRAINT "fourthwall_order_pkey" TO "fourthwall_orders_pkey";`.execute(db);
  await sql`ALTER TABLE "rss_feed" RENAME CONSTRAINT "rss_feed_pkey" TO "rss_feeds_pkey";`.execute(db);
  await sql`ALTER TABLE "discord_link" RENAME TO "discord_links";`.execute(db);
  await sql`ALTER TABLE "discord_message" RENAME TO "discord_messages";`.execute(db);
  await sql`ALTER TABLE "fourthwall_order" RENAME TO "fourthwall_orders";`.execute(db);
  await sql`ALTER TABLE "scheduled_message" RENAME TO "scheduled_messages";`.execute(db);
}
