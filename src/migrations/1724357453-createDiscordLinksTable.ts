import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('discord_links')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('createdAt', 'varchar', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('author', 'varchar', (col) => col.notNull())
    .addColumn('link', 'varchar', (col) => col.notNull())
    .addColumn('name', 'varchar', (col) => col.notNull().unique())
    .addColumn('usageCount', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('discord_links').execute();
}
