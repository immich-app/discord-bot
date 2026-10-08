import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "github_item" (
  "organization" character varying NOT NULL,
  "repository" character varying NOT NULL,
  "number" integer NOT NULL,
  "kind" character varying NOT NULL,
  "updatedAt" timestamp with time zone NOT NULL,
  "removed" boolean NOT NULL DEFAULT false,
  CONSTRAINT "github_item_pkey" PRIMARY KEY ("organization", "repository", "number")
);`.execute(db);
  await sql`CREATE INDEX "github_item_number_idx" ON "github_item" ("number");`.execute(db);
  await sql`INSERT INTO "github_item" ("organization", "repository", "number", "kind", "updatedAt")
SELECT lower("organization"), lower("repository"), "number", 'pull_request', max("updatedAt")
FROM "pull_request"
GROUP BY lower("organization"), lower("repository"), "number";`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "github_item";`.execute(db);
}
