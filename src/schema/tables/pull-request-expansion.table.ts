import { Column, CreateDateColumn, Generated, Index, PrimaryColumn, Table } from '@immich/sql-tools';

/** A pull request that a bot expansion reply names, so that an approval of it can mark the reply. */
@Table('pull_request_expansion')
@Index({ name: 'pull_request_expansion_pullRequest_idx', columns: ['organization', 'repository', 'number'] })
export class PullRequestExpansionTable {
  @PrimaryColumn()
  service!: 'discord' | 'zulip';

  /** A Zulip message ID in decimal, or a Discord snowflake. */
  @PrimaryColumn()
  messageId!: string;

  /** GitHub's own spelling, lowercased, as `repository`. */
  @PrimaryColumn()
  organization!: string;

  @PrimaryColumn()
  repository!: string;

  @PrimaryColumn({ type: 'integer' })
  number!: number;

  /** The Discord channel or thread of the reply; `null` on Zulip. */
  @Column({ nullable: true })
  channelId!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
