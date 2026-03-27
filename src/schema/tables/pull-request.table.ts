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

  @UpdateDateColumn()
  updatedAt!: Timestamp;

  @Column({ type: 'timestamp with time zone', nullable: true })
  closedAt!: Date | null;
}
