import { Column, CreateDateColumn, Generated, PrimaryColumn, Table } from '@immich/sql-tools';

/** A Zulip message using the emoji `:name:` is answered with `image`: a URL, or the inline image markdown of an upload. */
@Table('zulip_sticker')
export class ZulipStickerTable {
  @PrimaryColumn()
  name!: string;

  @Column()
  image!: string;

  @Column()
  createdBy!: string;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
