import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM "scheduled_message" WHERE "service" = 'mattermost';`.execute(db);
}

export async function down(): Promise<void> {}
