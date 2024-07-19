import { Insertable, JSONColumnType, Kysely, PostgresDialect, Selectable, Updateable } from 'kysely';
import pg from 'pg';

export interface Database {
  payment: PaymentTable;
  sponsor: SponsorTable;
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

export interface SponsorTable {
  username: string;
  email: string;
  total: number;
  claimed: boolean;
  licenseType: 'client' | 'server';
  licenses: { license: string; activation: string }[];
}

export type Sponsor = Selectable<SponsorTable>;
export type UpdateSponsor = Updateable<SponsorTable>;

const dialect = new PostgresDialect({
  pool: new pg.Pool({
    connectionString: 'postgres://postgres:password@192.168.101.60:5432/discord_bot',
  }),
});

export const db = new Kysely<Database>({
  dialect,
});
