import { Kysely, sql } from 'kysely';

/** Syncs marked another account's emoji as checked without padding it, so every recorded emote is looked at again. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`UPDATE "zulip_emote" SET "padded" = false;`.execute(db);
}

/** Which rows were padded before is not kept, so a rollback leaves every emote to be looked at again rather than skipped. */
export async function down(db: Kysely<any>): Promise<void> {
  await sql`UPDATE "zulip_emote" SET "padded" = false;`.execute(db);
}
