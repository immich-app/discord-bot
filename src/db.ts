import { Insertable, JSONColumnType, Kysely, PostgresDialect, Selectable } from 'kysely';
import pg from 'pg';

export interface Database {
  payment: PaymentTable;
}

export interface PaymentTable {
  event_id: string;
  id: string;
  amount: number;
  currency: string;
  status: string;
  description: string;
  created: number;
  livemode: boolean;
  data: JSONColumnType<object>;
}

export type Payment = Selectable<PaymentTable>;
export type NewPayment = Insertable<PaymentTable>;

const dialect = new PostgresDialect({
  pool: new pg.Pool({
    connectionString: process.env.uri,
  }),
});

export const db = new Kysely<Database>({
  dialect,
});
