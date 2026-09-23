import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "mirror_conversation" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "pair" character varying NOT NULL,
  "discordChannelId" character varying NOT NULL,
  "discordThreadId" character varying,
  "zulipStreamId" integer NOT NULL,
  "zulipTopic" character varying NOT NULL,
  "zulipTopicKey" character varying NOT NULL,
  "zulipAnchorMessageId" integer,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "mirror_conversation_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE UNIQUE INDEX "mirror_conversation_zulipTopic_uq" ON "mirror_conversation" ("zulipStreamId", "zulipTopicKey");`.execute(db);
  await sql`CREATE UNIQUE INDEX "mirror_conversation_main_uq" ON "mirror_conversation" ("discordChannelId") WHERE ("discordThreadId" IS NULL);`.execute(db);
  await sql`CREATE UNIQUE INDEX "mirror_conversation_discordThreadId_uq" ON "mirror_conversation" ("discordThreadId") WHERE ("discordThreadId" IS NOT NULL);`.execute(db);
  await sql`CREATE INDEX "mirror_conversation_zulipAnchorMessageId_idx" ON "mirror_conversation" ("zulipAnchorMessageId");`.execute(db);
  await sql`CREATE TABLE "mirror_message" (
  "discordMessageId" character varying NOT NULL,
  "conversationId" uuid,
  "origin" character varying NOT NULL,
  "discordChannelId" character varying NOT NULL,
  "discordThreadId" character varying,
  "discordWebhookId" character varying,
  "discordAuthorId" character varying,
  "zulipMessageId" integer NOT NULL,
  "zulipStreamId" integer NOT NULL,
  "zulipSenderId" integer,
  "part" integer NOT NULL DEFAULT 0,
  "sourceHash" character varying NOT NULL,
  "zulipHeader" text,
  "zulipAttachments" text,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "deletedAt" timestamp with time zone,
  CONSTRAINT "mirror_message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "mirror_conversation" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  CONSTRAINT "mirror_message_zulipMessageId_part_uq" UNIQUE ("zulipMessageId", "part"),
  CONSTRAINT "mirror_message_pkey" PRIMARY KEY ("discordMessageId")
);`.execute(db);
  await sql`CREATE INDEX "mirror_message_conversationId_idx" ON "mirror_message" ("conversationId");`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_mirror_conversation_main_uq', '{"type":"index","name":"mirror_conversation_main_uq","sql":"CREATE UNIQUE INDEX \\"mirror_conversation_main_uq\\" ON \\"mirror_conversation\\" (\\"discordChannelId\\") WHERE (\\"discordThreadId\\" IS NULL);"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_mirror_conversation_discordThreadId_uq', '{"type":"index","name":"mirror_conversation_discordThreadId_uq","sql":"CREATE UNIQUE INDEX \\"mirror_conversation_discordThreadId_uq\\" ON \\"mirror_conversation\\" (\\"discordThreadId\\") WHERE (\\"discordThreadId\\" IS NOT NULL);"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "mirror_message";`.execute(db);
  await sql`DROP TABLE "mirror_conversation";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_mirror_conversation_main_uq';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_mirror_conversation_discordThreadId_uq';`.execute(db);
}
