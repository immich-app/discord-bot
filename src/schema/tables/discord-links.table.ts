import { Column, CreateDateColumn, Generated, PrimaryGeneratedColumn, Table } from '@immich/sql-tools';

@Table('discord_link')
export class DiscordLinkTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Date>;

  @Column()
  author!: string;

  @Column()
  link!: string;

  @Column({ unique: true })
  name!: string;

  @Column({ type: 'integer', default: 0 })
  usageCount!: Generated<number>;
}
