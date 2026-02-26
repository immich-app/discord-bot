import { Column, PrimaryColumn, Table } from '@immich/sql-tools';
import { JSONColumnType } from 'kysely';

@Table('payment')
export class PaymentTable {
  @PrimaryColumn()
  event_id!: string;

  @Column()
  id!: string;

  @Column({ type: 'integer' })
  amount!: number;

  @Column()
  currency!: string;

  @Column()
  status!: string;

  @Column()
  description!: string;

  @Column({ type: 'integer' })
  created!: number;

  @Column({ type: 'boolean' })
  livemode!: boolean;

  @Column({ type: 'jsonb' })
  data!: JSONColumnType<object>;
}
