import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "pull_request" DROP COLUMN "id";`.execute(db);
  await sql`ALTER TABLE "pull_request" ADD "id" bigint NOT NULL;`.execute(db);
  await sql`ALTER TABLE "pull_request" ADD CONSTRAINT "pull_request_pkey" PRIMARY KEY ("id");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "pull_request" DROP COLUMN "id";`.execute(db);
  await sql`ALTER TABLE "pull_request" ADD "id" integer NOT NULL;`.execute(db);
  await sql`ALTER TABLE "pull_request" ADD CONSTRAINT "pull_request_pkey" PRIMARY KEY ("id");`.execute(db);
}
