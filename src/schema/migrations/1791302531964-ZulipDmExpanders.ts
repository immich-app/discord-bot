import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "zulip_dm_expander_default" (
  "conversation" character varying NOT NULL,
  "repository" character varying NOT NULL,
  "createdBy" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "zulip_dm_expander_default_pkey" PRIMARY KEY ("conversation")
);`.execute(db);
  await sql`CREATE TABLE "zulip_dm_expander" (
  "conversation" character varying NOT NULL,
  "groupName" character varying NOT NULL,
  "createdBy" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "zulip_dm_expander_groupName_fkey" FOREIGN KEY ("groupName") REFERENCES "zulip_expander_group" ("name") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "zulip_dm_expander_pkey" PRIMARY KEY ("conversation", "groupName")
);`.execute(db);
  await sql`CREATE INDEX "zulip_dm_expander_groupName_idx" ON "zulip_dm_expander" ("groupName");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "zulip_dm_expander_default";`.execute(db);
  await sql`DROP TABLE "zulip_dm_expander";`.execute(db);
}
