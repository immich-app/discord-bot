import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "scheduled_message" ADD "topic" character varying;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM "scheduled_message" WHERE "service" = 'zulip';`.execute(db);
  await sql`ALTER TABLE "scheduled_message" DROP COLUMN "topic";`.execute(db);
}
