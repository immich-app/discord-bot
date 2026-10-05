import { Kysely, sql } from 'kysely';

/** The rows already there were recorded when emotes were stretched rather than padded, so the next sync redoes them. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "zulip_emote" ADD "padded" boolean NOT NULL DEFAULT false;`.execute(db);
  await sql`ALTER TABLE "zulip_emote" ALTER COLUMN "padded" SET DEFAULT true;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "zulip_emote" DROP COLUMN "padded";`.execute(db);
}
