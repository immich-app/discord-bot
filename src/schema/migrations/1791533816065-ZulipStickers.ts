import { Kysely, sql } from 'kysely';

/** Seeded with the stickers `Constants.Zulip.EmojiImages` held, so that every one of them keeps answering. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "zulip_sticker" (
  "name" character varying NOT NULL,
  "image" character varying NOT NULL,
  "createdBy" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "zulip_sticker_pkey" PRIMARY KEY ("name")
);`.execute(db);
  await sql`INSERT INTO "zulip_sticker" ("name", "image", "createdBy") VALUES
  ('chugg', 'https://zuclaude.exe.xyz/stickers/chugg.gif', 'migration'),
  ('nice', 'https://media1.tenor.com/m/l3-VETEqSYkAAAAd/nice-noice.gif', 'migration'),
  ('oh-god-the-emails', 'https://zuclaude.exe.xyz/stickers/oh-god-the-emails.png', 'migration'),
  ('stamppers', 'https://zuclaude.exe.xyz/stickers/stamppers.gif', 'migration'),
  ('this-is-fine', 'https://media.giphy.com/media/QMHoU66sBXqqLqYvGO/giphy.gif', 'migration'),
  ('unsee-juice', '![unsee-juice](/user_uploads/2/ed/ngCVicRM4MCEnzYdxl3knd6b/unsee-juice.png)', 'migration'),
  ('we-are-checking', 'https://media1.tenor.com/m/wzhj-RbyNyIAAAAd/ferrari-f1.gif', 'migration'),
  ('we-are-crying', 'https://media1.tenor.com/m/vjWI_-HHKdgAAAAd/ferrari-cry-ferrari.gif', 'migration');`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "zulip_sticker";`.execute(db);
}
