import { Column, CreateDateColumn, Generated, PrimaryColumn, Table } from '@immich/sql-tools';

/** A named set of GitHub repositories that GitHub expansion is turned on with, in a stream. */
@Table('zulip_expander_group')
export class ZulipExpanderGroupTable {
  @PrimaryColumn()
  name!: string;

  /** `owner/name` as GitHub spells it; the first is the default repository for `#123`. */
  @Column({ array: true })
  repositories!: string[];

  /** A bare `#123` below this expands only when a stream repository has that item in `github_item`. */
  @Column({ type: 'integer', default: 0 })
  threshold!: Generated<number>;

  @Column()
  createdBy!: string;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
