import { Insertable, JSONColumnType, Selectable, Updateable } from 'kysely';

export const IDatabaseRepository = 'IDatabaseRepository';

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

export enum LicenseType {
  Server = 'immich-server',
  Client = 'immich-client',
}

export interface SponsorTable {
  username: string;
  email: string;
  total: number;
  claimed: boolean;
  license_type: 'client' | 'server';
  licenses: { license: string; activation: string }[];
}

export interface License {
  type: LicenseType;
  licenseKey: string;
  activationKey: string;
}

export type Sponsor = Selectable<SponsorTable>;
export type UpdateSponsor = Updateable<SponsorTable>;

export interface Database {
  payment: PaymentTable;
  sponsor: SponsorTable;
}

export interface IDatabaseRepository {
  runMigrations(): Promise<void>;
  createPayment(entitY: NewPayment): Promise<void>;
  getTotalLicenseCount(): Promise<{ server: number; client: number }>;
  getSponsorLicenses(githubUsername: string): Promise<License[]>;
}
