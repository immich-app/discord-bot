import { Column, PrimaryColumn, Table } from '@immich/sql-tools';

@Table('fourthwall_order')
export class FourthwallOrderTable {
  @PrimaryColumn()
  id!: string;

  @Column({ type: 'real' })
  discount!: number;

  @Column({ type: 'real' })
  tax!: number;

  @Column({ type: 'real' })
  shipping!: number;

  @Column({ type: 'real' })
  subtotal!: number;

  @Column({ type: 'real' })
  total!: number;

  @Column({ type: 'real' })
  revenue!: number;

  @Column({ type: 'real' })
  profit!: number;

  @Column({ nullable: true })
  username?: string | null;

  @Column({ nullable: true })
  message?: string | null;

  @Column()
  status!: string;

  @Column({ type: 'timestamp with time zone' })
  createdAt!: Date;

  @Column({ type: 'boolean' })
  testMode!: boolean;
}
