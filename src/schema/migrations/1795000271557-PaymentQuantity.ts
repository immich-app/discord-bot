import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "payment" ADD "quantity" integer NOT NULL DEFAULT 1;`.execute(db);
  await sql`ALTER TABLE "payment" ALTER COLUMN "quantity" DROP DEFAULT;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "payment" DROP COLUMN "quantity";`.execute(db);
}
