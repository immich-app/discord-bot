import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "zulip_emote" (
  "discordEmoteId" character varying NOT NULL,
  "zulipName" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "zulip_emote_pkey" PRIMARY KEY ("discordEmoteId")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "zulip_emote";`.execute(db);
}
