import { Column, PrimaryColumn, Table } from '@immich/sql-tools';

@Table('rss_feed')
export class RSSFeedTable {
  @PrimaryColumn()
  url!: string;

  @PrimaryColumn()
  channelId!: string;

  @Column({ nullable: true })
  lastId!: string | null;

  @Column({ nullable: true })
  title!: string | null;

  @Column({ nullable: true })
  profileImageUrl!: string | null;
}
