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

export interface DiscordMessagesTable {
  id: Generated<string>;
  createdAt: Generated<Date>;
  lastEditedBy: string;
  name: string;
  content: string;
  usageCount: Generated<number>;
}

export type DiscordMessage = Selectable<DiscordMessagesTable>;
export type NewDiscordMessage = Insertable<DiscordMessagesTable>;
export type UpdateDiscordMessage = Updateable<DiscordMessagesTable> & { id: string };

export interface FourthwallOrdersTable {
  id: string;
  revenue: number;
  profit: number;
  username?: string;
  message?: string;
  status: string;
  createdAt: Date;
  testMode: boolean;
}

export type FourthwallOrder = Selectable<FourthwallOrdersTable>;
export type NewFourthwallOrder = Insertable<FourthwallOrdersTable>;
export type UpdateFourthwallOrder = Updateable<FourthwallOrdersTable> & { id: string };

export interface Database {
  payment: PaymentTable;
  sponsor: SponsorTable;
  discord_links: DiscordLinksTable;
  discord_messages: DiscordMessagesTable;
  fourthwall_orders: FourthwallOrdersTable;
}

export type ReportOptions = {
  day?: DateTime;
  week?: DateTime;
  month?: DateTime;
};

export interface IDatabaseRepository {
  runMigrations(): Promise<void>;
  createPayment(entity: NewPayment): Promise<void>;
  getTotalLicenseCount(options?: ReportOptions): Promise<{ server: number; client: number }>;
  getSponsorLicenses(githubUsername: string): Promise<License[]>;
  getDiscordLinks(): Promise<DiscordLink[]>;
  getDiscordLink(name: string): Promise<DiscordLink | undefined>;
  addDiscordLink(link: NewDiscordLink): Promise<void>;
  removeDiscordLink(id: string): Promise<void>;
  updateDiscordLink(link: DiscordLinkUpdate): Promise<void>;
  getDiscordMessages(): Promise<DiscordMessage[]>;
  getDiscordMessage(name: string): Promise<DiscordMessage | undefined>;
  addDiscordMessage(message: NewDiscordMessage): Promise<void>;
  updateDiscordMessage(message: UpdateDiscordMessage): Promise<void>;
  removeDiscordMessage(id: string): Promise<void>;
  createFourthwallOrder(entity: NewFourthwallOrder): Promise<void>;
  updateFourthwallOrder(entity: UpdateFourthwallOrder): Promise<void>;
  getTotalFourthwallOrders(options?: ReportOptions): Promise<{ revenue: number; profit: number }>;
}
