import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "zulip_expander" (
  "streamId" integer NOT NULL,
  "expander" character varying NOT NULL,
  "createdBy" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "zulip_expander_pkey" PRIMARY KEY ("streamId", "expander")
);`.execute(db);
  await sql`INSERT INTO "zulip_expander" ("streamId", "expander", "createdBy")
SELECT "streamId", "expander", 'migration'
FROM unnest(ARRAY[54, 107, 108, 109, 110, 111, 112, 113]) AS "streamId"
CROSS JOIN unnest(ARRAY['github', 'twitter']) AS "expander";`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "zulip_expander";`.execute(db);
}
