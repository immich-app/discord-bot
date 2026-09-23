import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "pull_request" ADD "zulipMessageId" integer;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "pull_request" DROP COLUMN "zulipMessageId";`.execute(db);
}
