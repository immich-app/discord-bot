import { Column, PrimaryColumn, Table } from '@immich/sql-tools';

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

  @Column()
  discordThreadId!: string;

  @Column({ type: 'timestamp with time zone', nullable: true })
  closedAt!: Date | null;
}
