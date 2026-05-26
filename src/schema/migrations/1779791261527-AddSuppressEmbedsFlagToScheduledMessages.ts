import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "scheduled_message" ADD "suppressEmbeds" boolean NOT NULL DEFAULT true;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "scheduled_message" DROP COLUMN "suppressEmbeds";`.execute(db);
}
