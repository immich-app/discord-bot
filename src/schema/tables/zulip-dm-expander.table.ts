import { Column, CreateDateColumn, ForeignKeyColumn, Generated, PrimaryColumn, Table } from '@immich/sql-tools';
import { ZulipExpanderGroupTable } from 'src/schema/tables/zulip-expander-group.table';

/** A group turned on in a direct message conversation. */
@Table('zulip_dm_expander')
export class ZulipDmExpanderTable {
  /** The conversation's user IDs, the bot's included, ascending and comma-separated. */
  @PrimaryColumn()
  conversation!: string;

  @ForeignKeyColumn(() => ZulipExpanderGroupTable, {
    primary: true,
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    index: true,
  })
  groupName!: string;

  @Column()
  createdBy!: string;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
