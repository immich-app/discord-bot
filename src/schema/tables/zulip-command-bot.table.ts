import { Column, CreateDateColumn, Generated, PrimaryColumn, Table } from '@immich/sql-tools';

/** The bots whose Zulip commands are taken; every other bot's are ignored. */
@Table('zulip_command_bot')
export class ZulipCommandBotTable {
  @PrimaryColumn({ type: 'integer' })
  userId!: number;

  @Column()
  createdBy!: string;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
