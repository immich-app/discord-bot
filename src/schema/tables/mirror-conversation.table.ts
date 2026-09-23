import {
  Column,
  CreateDateColumn,
  Generated,
  GeneratedColumn,
  Index,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';

@Table('mirror_conversation')
@Index({
  name: 'mirror_conversation_discordThreadId_uq',
  columns: ['discordThreadId'],
  unique: true,
  where: '"discordThreadId" IS NOT NULL',
})
@Index({
  name: 'mirror_conversation_main_uq',
  columns: ['discordChannelId'],
  unique: true,
  where: '"discordThreadId" IS NULL',
})
@Index({ name: 'mirror_conversation_zulipTopic_uq', columns: ['zulipStreamId', 'zulipTopicKey'], unique: true })
export class MirrorConversationTable {
  @GeneratedColumn({ primary: true })
  id!: Generated<string>;

  @Column()
  discordChannelId!: string;

  @Column({ nullable: true })
  discordThreadId!: string | null;

  @Column({ type: 'integer' })
  zulipStreamId!: number;

  @Column()
  zulipTopic!: string;

  @Column()
  zulipTopicKey!: string;

  /** Zulip topics have no ID, so the conversation is found again through a message in it. */
  @Column({ type: 'integer', nullable: true, index: true })
  zulipAnchorMessageId!: number | null;

  @CreateDateColumn()
  createdAt!: Generated<Date>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
