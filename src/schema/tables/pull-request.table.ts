import { Column, PrimaryColumn, Table } from '@immich/sql-tools';

@Table('pull_request')
export class PullRequestTable {
  @PrimaryColumn({ type: 'integer' })
  id!: number;

  @Column()
  discordThreadId!: string;
}
