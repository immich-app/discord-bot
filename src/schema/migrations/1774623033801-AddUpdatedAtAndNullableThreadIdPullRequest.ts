import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "pull_request" ALTER COLUMN "discordThreadId" DROP NOT NULL;`.execute(db);
  await sql`ALTER TABLE "pull_request" ADD "updatedAt" timestamp with time zone NOT NULL DEFAULT now();`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "pull_request" ALTER COLUMN "discordThreadId" SET NOT NULL;`.execute(db);
  await sql`ALTER TABLE "pull_request" DROP COLUMN "updatedAt";`.execute(db);
}
