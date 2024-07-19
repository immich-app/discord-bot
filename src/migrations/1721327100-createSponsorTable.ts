import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('sponsor')
    .addColumn('username', 'varchar', (col) => col.primaryKey())
    .addColumn('email', 'varchar', (col) => col.notNull())
    .addColumn('total', 'integer', (col) => col.notNull())
    .addColumn('claimed', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('licenseType', 'varchar', (col) => col.notNull())
    .addColumn('licenses', 'jsonb', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('payment').execute();
}
