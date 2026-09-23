import { Column, CreateDateColumn, ForeignKeyColumn, Generated, PrimaryColumn, Table, Unique } from '@immich/sql-tools';
import { MirrorConversationTable } from 'src/schema/tables/mirror-conversation.table';

@Table('mirror_message')
@Unique({ name: 'mirror_message_zulipMessageId_part_uq', columns: ['zulipMessageId', 'part'] })
export class MirrorMessageTable {
  @PrimaryColumn()
  discordMessageId!: string;

  @ForeignKeyColumn(() => MirrorConversationTable, { nullable: true, onDelete: 'SET NULL', index: true })
  conversationId!: string | null;

  @Column()
  origin!: 'discord' | 'zulip';

  @Column()
  discordChannelId!: string;

  @Column({ nullable: true })
  discordThreadId!: string | null;

  @Column({ nullable: true })
  discordWebhookId!: string | null;

  @Column({ nullable: true })
  discordAuthorId!: string | null;

  @Column({ type: 'integer' })
  zulipMessageId!: number;

  @Column({ type: 'integer' })
  zulipStreamId!: number;

  @Column({ type: 'integer', nullable: true })
  zulipSenderId!: number | null;

  @Column({ type: 'integer', default: 0 })
  part!: Generated<number>;

  @Column()
  sourceHash!: string;

  @Column({ type: 'text', nullable: true })
  zulipHeader!: string | null;

  @Column({ type: 'text', nullable: true })
  zulipAttachments!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
