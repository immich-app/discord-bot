import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('scheduled_messages')
    .addColumn('id', 'uuid', (oc) => oc.primaryKey().defaultTo(db.fn('gen_random_uuid')))
    .addColumn('channelId', 'varchar', (oc) => oc.notNull())
    .addColumn('message', 'text', (oc) => oc.notNull())
    .addColumn('cronExpression', 'varchar', (oc) => oc.notNull())
    .addColumn('createdBy', 'varchar', (oc) => oc.notNull())
    .addColumn('name', 'varchar', (oc) => oc.notNull().unique())
    .addColumn('createdAt', 'timestamptz', (oc) => oc.notNull().defaultTo(db.fn('now')))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('scheduled_messages').execute();
}
