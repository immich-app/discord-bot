import { Column, CreateDateColumn, Generated, GeneratedColumn, Table } from '@immich/sql-tools';

@Table('scheduled_message')
export class ScheduledMessageTable {
  @GeneratedColumn({ primary: true })
  id!: Generated<string>;

  @Column()
  channelId!: string;

  @Column()
  message!: string;

  @Column({ type: 'boolean', default: true })
  suppressEmbeds!: Generated<boolean>;

  @Column()
  cronExpression!: string;

  @Column()
  createdBy!: string;

  @Column({ unique: true })
  name!: string;

  @Column({ default: 'discord', primary: true })
  service!: 'discord' | 'mattermost';

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
