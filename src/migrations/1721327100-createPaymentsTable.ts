import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('payment')
    .addColumn('event_id', 'varchar', (col) => col.primaryKey())
    .addColumn('id', 'varchar', (col) => col.notNull())
    .addColumn('amount', 'integer', (col) => col.notNull())
    .addColumn('currency', 'varchar', (col) => col.notNull())
    .addColumn('status', 'varchar', (col) => col.notNull())
    .addColumn('description', 'varchar', (col) => col.notNull())
    .addColumn('created', 'integer', (col) => col.notNull())
    .addColumn('livemode', 'boolean', (col) => col.notNull())
    .addColumn('data', 'jsonb', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('payment').execute();
}
