import { Column, CreateDateColumn, Generated, PrimaryGeneratedColumn, Table } from '@immich/sql-tools';

@Table('discord_message')
export class DiscordMessageTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Date>;

  @Column()
  lastEditedBy!: string;

  @Column()
  name!: string;

  @Column({ unique: true })
  content!: string;

  @Column({ type: 'integer', default: 0 })
  usageCount!: Generated<number>;
}
