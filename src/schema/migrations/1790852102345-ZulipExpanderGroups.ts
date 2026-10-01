import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "zulip_expander_group" (
  "name" character varying NOT NULL,
  "repositories" character varying[] NOT NULL,
  "threshold" integer NOT NULL DEFAULT 0,
  "createdBy" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "zulip_expander_group_pkey" PRIMARY KEY ("name")
);`.execute(db);
  await sql`INSERT INTO "zulip_expander_group" ("name", "repositories", "threshold", "createdBy")
VALUES ('immich', ARRAY['immich-app/immich'], 1000, 'migration');`.execute(db);
  await sql`ALTER TABLE "zulip_expander" ADD "groupName" character varying NOT NULL DEFAULT 'immich';`.execute(db);
  await sql`ALTER TABLE "zulip_expander" ALTER COLUMN "groupName" DROP DEFAULT;`.execute(db);
  await sql`CREATE INDEX "zulip_expander_groupName_idx" ON "zulip_expander" ("groupName");`.execute(db);
  await sql`ALTER TABLE "zulip_expander" DROP CONSTRAINT "zulip_expander_pkey";`.execute(db);
  await sql`ALTER TABLE "zulip_expander" ADD CONSTRAINT "zulip_expander_pkey" PRIMARY KEY ("streamId", "groupName");`.execute(db);
  await sql`ALTER TABLE "zulip_expander" ADD CONSTRAINT "zulip_expander_groupName_fkey" FOREIGN KEY ("groupName") REFERENCES "zulip_expander_group" ("name") ON UPDATE CASCADE ON DELETE CASCADE;`.execute(db);
  await sql`CREATE TABLE "zulip_expander_default" (
  "streamId" integer NOT NULL,
  "repository" character varying NOT NULL,
  "createdBy" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "zulip_expander_default_pkey" PRIMARY KEY ("streamId")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "zulip_expander_default";`.execute(db);
  await sql`ALTER TABLE "zulip_expander" DROP CONSTRAINT "zulip_expander_groupName_fkey";`.execute(db);
  await sql`ALTER TABLE "zulip_expander" DROP CONSTRAINT "zulip_expander_pkey";`.execute(db);
  await sql`DELETE FROM "zulip_expander" "a" USING "zulip_expander" "b"
WHERE "a"."streamId" = "b"."streamId" AND ("a"."createdAt", "a"."groupName") > ("b"."createdAt", "b"."groupName");`.execute(db);
  await sql`DROP INDEX "zulip_expander_groupName_idx";`.execute(db);
  await sql`ALTER TABLE "zulip_expander" DROP COLUMN "groupName";`.execute(db);
  await sql`ALTER TABLE "zulip_expander" ADD CONSTRAINT "zulip_expander_pkey" PRIMARY KEY ("streamId");`.execute(db);
  await sql`DROP TABLE "zulip_expander_group";`.execute(db);
}
