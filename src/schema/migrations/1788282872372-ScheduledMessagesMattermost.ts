import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "scheduled_message" ADD "service" character varying NOT NULL DEFAULT 'discord';`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "scheduled_message" DROP COLUMN "service";`.execute(db);
}
