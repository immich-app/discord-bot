import { Column, PrimaryColumn, Table } from '@immich/sql-tools';

@Table('pull_request')
export class PullRequestTable {
  @PrimaryColumn({ type: 'bigint' })
  id!: number;

  @Column()
  discordThreadId!: string;

  @Column({ type: 'timestamp with time zone', nullable: true })
  closedAt!: Date | null;
}
