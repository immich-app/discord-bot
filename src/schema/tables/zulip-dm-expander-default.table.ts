import { Column, CreateDateColumn, Generated, PrimaryColumn, Table } from '@immich/sql-tools';

/** The repository a bare `#123` goes to in a direct message conversation, in place of its first group's first. */
@Table('zulip_dm_expander_default')
export class ZulipDmExpanderDefaultTable {
  /** As `zulip_dm_expander.conversation`. */
  @PrimaryColumn()
  conversation!: string;

  @Column()
  repository!: string;

  @Column()
  createdBy!: string;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
