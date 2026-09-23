import { Column, CreateDateColumn, Generated, PrimaryColumn, Table } from '@immich/sql-tools';

@Table('mirror_link')
export class MirrorLinkTable {
  @PrimaryColumn()
  discordChannelId!: string;

  @Column({ type: 'integer', unique: true })
  zulipStreamId!: number;

  @Column()
  kind!: 'text' | 'forum';

  /** Text channels only: where the channel's own messages go; each public thread gets a topic of its own. */
  @Column({ nullable: true })
  mainTopic!: string | null;

  @Column()
  createdBy!: string;

  /** The pinned link announcement, unpinned when the link is removed. */
  @Column({ nullable: true })
  discordAnnouncementId!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
