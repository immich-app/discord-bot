import { Generated, Insertable, JSONColumnType, Selectable, Updateable } from 'kysely';
import { DateTime } from 'luxon';

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

export interface DiscordLinksTable {
  id: Generated<string>;
  createdAt: Generated<Date>;
  author: string;
  link: string;
  name: string;
  usageCount: Generated<number>;
}

export type DiscordLink = Selectable<DiscordLinksTable>;
export type NewDiscordLink = Insertable<DiscordLinksTable>;
export type DiscordLinkUpdate = Updateable<DiscordLinksTable> & { id: string };

export interface Database {
  payment: PaymentTable;
  sponsor: SponsorTable;
  discord_links: DiscordLinksTable;
}

export type LicenseCountOptions = {
  day?: DateTime;
  week?: DateTime;
  month?: DateTime;
};

export interface IDatabaseRepository {
  runMigrations(): Promise<void>;
  createPayment(entitY: NewPayment): Promise<void>;
  getTotalLicenseCount(options?: LicenseCountOptions): Promise<{ server: number; client: number }>;
  getSponsorLicenses(githubUsername: string): Promise<License[]>;
  getDiscordLinks(): Promise<DiscordLink[]>;
  getDiscordLink(name: string): Promise<DiscordLink | undefined>;
  addDiscordLink(link: NewDiscordLink): Promise<void>;
  removeDiscordLink(id: string): Promise<void>;
  updateDiscordLink(link: DiscordLinkUpdate): Promise<void>;
}
