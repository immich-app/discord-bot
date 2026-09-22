import { Column, PrimaryColumn, Table, Timestamp, UpdateDateColumn } from '@immich/sql-tools';

@Table('pull_request')
export class PullRequestTable {
  @PrimaryColumn()
  nodeId!: string;

  @Column()
  organization!: string;

  @Column()
  repository!: string;

  @Column({ type: 'integer' })
  number!: number;

  @Column({ nullable: true })
  discordThreadId!: string | null;

  /** Zulip topics have no ID, so the topic is found again through its first message. */
  @Column({ type: 'integer', nullable: true })
  zulipMessageId!: number | null;

  @UpdateDateColumn()
  updatedAt!: Timestamp;

  @Column({ type: 'timestamp with time zone', nullable: true })
  closedAt!: Date | null;
}
