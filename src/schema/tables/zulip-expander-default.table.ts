import { Column, CreateDateColumn, Generated, PrimaryColumn, Table } from '@immich/sql-tools';

/** The repository a bare `#123` goes to in a stream, in place of its first group's first repository. */
@Table('zulip_expander_default')
export class ZulipExpanderDefaultTable {
  @PrimaryColumn({ type: 'integer' })
  streamId!: number;

  @Column()
  repository!: string;

  @Column()
  createdBy!: string;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
