import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "zulip_expander_default";`.execute(db);
  await sql`DROP TABLE "zulip_dm_expander_default";`.execute(db);
  await sql`ALTER TABLE "zulip_expander_group" DROP COLUMN "threshold";`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "zulip_expander_group" ADD "threshold" integer NOT NULL DEFAULT 0;`.execute(db);
  await sql`UPDATE "zulip_expander_group" SET "threshold" = 1000 WHERE "name" = 'immich';`.execute(db);
  await sql`CREATE TABLE "zulip_dm_expander_default" (
  "conversation" character varying NOT NULL,
  "repository" character varying NOT NULL,
  "createdBy" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "zulip_dm_expander_default_pkey" PRIMARY KEY ("conversation")
);`.execute(db);
  await sql`CREATE TABLE "zulip_expander_default" (
  "streamId" integer NOT NULL,
  "repository" character varying NOT NULL,
  "createdBy" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "zulip_expander_default_pkey" PRIMARY KEY ("streamId")
);`.execute(db);
}
