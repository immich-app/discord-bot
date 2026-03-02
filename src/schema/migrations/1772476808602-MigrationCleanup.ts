import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "scheduled_message" RENAME CONSTRAINT "scheduled_messages_pkey" TO "scheduled_message_pkey";`.execute(db);
  await sql`ALTER TABLE "scheduled_message" RENAME CONSTRAINT "scheduled_messages_name_uq" TO "scheduled_message_name_uq";`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "scheduled_message" RENAME CONSTRAINT "scheduled_message_name_uq" TO "scheduled_messages_name_uq";`.execute(db);
  await sql`ALTER TABLE "scheduled_message" RENAME CONSTRAINT "scheduled_message_pkey" TO "scheduled_messages_pkey";`.execute(db);
}
