import { Column, CreateDateColumn, Generated, PrimaryColumn, Table } from '@immich/sql-tools';

/** A stream the GitHub expander runs in. */
@Table('zulip_expander')
export class ZulipExpanderTable {
  @PrimaryColumn({ type: 'integer' })
  streamId!: number;

  @Column()
  createdBy!: string;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
