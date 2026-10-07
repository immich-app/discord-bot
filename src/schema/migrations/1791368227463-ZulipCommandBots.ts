import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "zulip_command_bot" (
  "userId" integer NOT NULL,
  "createdBy" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "zulip_command_bot_pkey" PRIMARY KEY ("userId")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "zulip_command_bot";`.execute(db);
}
