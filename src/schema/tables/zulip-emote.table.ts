import { Column, CreateDateColumn, Generated, PrimaryColumn, Table } from '@immich/sql-tools';

/**
 * A Discord emote the emote sync uploaded to Zulip, or found there and checked, so that it is never looked at again;
 * an emote Zulip has but this table does not was uploaded before emotes were padded, and may be cropped or stretched.
 */
@Table('zulip_emote')
export class ZulipEmoteTable {
  @PrimaryColumn()
  discordEmoteId!: string;

  @Column()
  zulipName!: string;

  /** `false` for a row a sync recorded when it stretched emotes rather than padding them: it is looked at again. */
  @Column({ type: 'boolean', default: true })
  padded!: Generated<boolean>;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
