import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "mirror_conversation" DROP COLUMN "pair";`.execute(db);
  await sql`CREATE TABLE "mirror_identity" (
  "zulipUserId" integer NOT NULL,
  "discordUserId" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "mirror_identity_discordUserId_uq" UNIQUE ("discordUserId"),
  CONSTRAINT "mirror_identity_pkey" PRIMARY KEY ("zulipUserId")
);`.execute(db);
  await sql`CREATE TABLE "mirror_link" (
  "discordChannelId" character varying NOT NULL,
  "zulipStreamId" integer NOT NULL,
  "kind" character varying NOT NULL,
  "mainTopic" character varying,
  "createdBy" character varying NOT NULL,
  "discordAnnouncementId" character varying,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "mirror_link_zulipStreamId_uq" UNIQUE ("zulipStreamId"),
  CONSTRAINT "mirror_link_pkey" PRIMARY KEY ("discordChannelId")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "mirror_conversation" ADD "pair" character varying;`.execute(db);
  await sql`UPDATE "mirror_conversation" SET "pair" = "discordChannelId";`.execute(db);
  await sql`ALTER TABLE "mirror_conversation" ALTER COLUMN "pair" SET NOT NULL;`.execute(db);
  await sql`DROP TABLE "mirror_identity";`.execute(db);
  await sql`DROP TABLE "mirror_link";`.execute(db);
}
