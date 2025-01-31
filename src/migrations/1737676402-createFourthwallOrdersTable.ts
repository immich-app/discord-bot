import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('fourthwall_orders')
    .addColumn('id', 'varchar', (col) => col.primaryKey())
    .addColumn('discount', 'float4', (col) => col.notNull())
    .addColumn('tax', 'float4', (col) => col.notNull())
    .addColumn('shipping', 'float4', (col) => col.notNull())
    .addColumn('subtotal', 'float4', (col) => col.notNull())
    .addColumn('total', 'float4', (col) => col.notNull())
    .addColumn('revenue', 'float4', (col) => col.notNull())
    .addColumn('profit', 'float4', (col) => col.notNull())
    .addColumn('username', 'varchar')
    .addColumn('message', 'varchar')
    .addColumn('status', 'varchar', (col) => col.notNull())
    .addColumn('createdAt', 'datetime', (col) => col.notNull())
    .addColumn('testMode', 'boolean', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('fourthwall_orders').execute();
}
