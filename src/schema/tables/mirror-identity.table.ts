import { Column, CreateDateColumn, Generated, PrimaryColumn, Table } from '@immich/sql-tools';

@Table('mirror_identity')
export class MirrorIdentityTable {
  @PrimaryColumn({ type: 'integer' })
  zulipUserId!: number;

  @Column({ unique: true })
  discordUserId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
