import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "pull_request" (
  "id" integer NOT NULL,
  "discordThreadId" character varying NOT NULL,
  CONSTRAINT "pull_request_pkey" PRIMARY KEY ("id")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "pull_request";`.execute(db);
}
