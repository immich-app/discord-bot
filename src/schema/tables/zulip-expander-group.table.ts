import { Column, CreateDateColumn, Generated, PrimaryColumn, Table } from '@immich/sql-tools';

/** A named set of GitHub repositories that GitHub expansion is turned on with, in a stream. */
@Table('zulip_expander_group')
export class ZulipExpanderGroupTable {
  @PrimaryColumn()
  name!: string;

  /** `owner/name` as GitHub spells it. */
  @Column({ array: true })
  repositories!: string[];

  @Column()
  createdBy!: string;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
