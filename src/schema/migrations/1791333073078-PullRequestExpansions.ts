import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "pull_request_expansion" (
  "service" character varying NOT NULL,
  "messageId" character varying NOT NULL,
  "organization" character varying NOT NULL,
  "repository" character varying NOT NULL,
  "number" integer NOT NULL,
  "channelId" character varying,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pull_request_expansion_pkey" PRIMARY KEY ("service", "messageId", "organization", "repository", "number")
);`.execute(db);
  await sql`CREATE INDEX "pull_request_expansion_pullRequest_idx" ON "pull_request_expansion" ("organization", "repository", "number");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "pull_request_expansion";`.execute(db);
}
