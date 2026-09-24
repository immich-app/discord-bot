import { Column, CreateDateColumn, Generated, PrimaryColumn, Table } from '@immich/sql-tools';

export type ZulipExpanderKind = 'github' | 'twitter';

@Table('zulip_expander')
export class ZulipExpanderTable {
  @PrimaryColumn({ type: 'integer' })
  streamId!: number;

  @PrimaryColumn()
  expander!: ZulipExpanderKind;

  @Column()
  createdBy!: string;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
