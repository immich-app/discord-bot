import { Column, PrimaryColumn, Table } from '@immich/sql-tools';

@Table('sponsor')
export class SponsorTable {
  @PrimaryColumn()
  username!: string;

  @Column()
  email!: string;

  @Column({ type: 'integer' })
  total!: number;

  @Column({ type: 'boolean', default: false })
  claimed?: boolean;

  @Column()
  license_type!: 'client' | 'server';

  @Column({ type: 'jsonb' })
  licenses!: { license: string; activation: string }[];
}
