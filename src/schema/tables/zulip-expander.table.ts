import { Column, CreateDateColumn, ForeignKeyColumn, Generated, PrimaryColumn, Table } from '@immich/sql-tools';
import { ZulipExpanderGroupTable } from 'src/schema/tables/zulip-expander-group.table';

/** A group GitHub expansion is turned on with, in a stream. */
@Table('zulip_expander')
export class ZulipExpanderTable {
  @PrimaryColumn({ type: 'integer' })
  streamId!: number;

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
