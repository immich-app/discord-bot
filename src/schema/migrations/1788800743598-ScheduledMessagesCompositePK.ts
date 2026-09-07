import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "scheduled_message" DROP CONSTRAINT "scheduled_message_pkey";`.execute(db);
  await sql`ALTER TABLE "scheduled_message" ADD CONSTRAINT "scheduled_message_pkey" PRIMARY KEY ("id", "service");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "scheduled_message" DROP CONSTRAINT "scheduled_message_pkey";`.execute(db);
  await sql`ALTER TABLE "scheduled_message" ADD CONSTRAINT "scheduled_message_pkey" PRIMARY KEY ("id");`.execute(db);
}
