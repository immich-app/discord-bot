import { Column, CreateDateColumn, Generated, PrimaryColumn, Table } from '@immich/sql-tools';

/**
 * A Discord emote the emote sync uploaded to Zulip, or found there and checked, so that it is never looked at again;
 * an emote Zulip has but this table does not was uploaded before wide emotes were squashed, and may be cropped.
 */
@Table('zulip_emote')
export class ZulipEmoteTable {
  @PrimaryColumn()
  discordEmoteId!: string;

  @Column()
  zulipName!: string;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
