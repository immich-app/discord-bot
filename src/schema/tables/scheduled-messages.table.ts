import { Column, CreateDateColumn, Generated, PrimaryGeneratedColumn, Table } from '@immich/sql-tools';

@Table('scheduled_messages')
export class ScheduledMessageTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column()
  channelId!: string;

  @Column()
  message!: string;

  @Column()
  cronExpression!: string;

  @Column()
  createdBy!: string;

  @Column({ unique: true })
  name!: string;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
