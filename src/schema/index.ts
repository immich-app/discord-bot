import { Database, Extensions } from '@immich/sql-tools';
import { Insertable, Selectable, Updateable } from 'kysely';
import { DiscordLinkTable } from 'src/schema/tables/discord-links.table';
import { DiscordMessageTable } from 'src/schema/tables/discord-messages.table';
import { FourthwallOrderTable } from 'src/schema/tables/fourthwall-orders.table';
import { PaymentTable } from 'src/schema/tables/payment.table';
import { RSSFeedTable } from 'src/schema/tables/rss-feeds.table';
import { ScheduledMessageTable } from 'src/schema/tables/scheduled-messages.table';
import { SponsorTable } from 'src/schema/tables/sponsor.table';

@Extensions(['uuid-ossp'])
@Database({ name: 'discord-bot' })
export class DiscordBotDatabase {
  tables = [
    PaymentTable,
    SponsorTable,
    DiscordLinkTable,
    DiscordMessageTable,
    FourthwallOrderTable,
    RSSFeedTable,
    ScheduledMessageTable,
  ];
}

export type Payment = Selectable<PaymentTable>;
export type NewPayment = Insertable<PaymentTable>;

export type Sponsor = Selectable<SponsorTable>;
export type UpdateSponsor = Updateable<SponsorTable>;

export type DiscordLink = Selectable<DiscordLinkTable>;
export type NewDiscordLink = Insertable<DiscordLinkTable>;
export type DiscordLinkUpdate = Updateable<DiscordLinkTable> & { id: string };

export type DiscordMessage = Selectable<DiscordMessageTable>;
export type NewDiscordMessage = Insertable<DiscordMessageTable>;
export type UpdateDiscordMessage = Updateable<DiscordMessageTable> & { id: string };

export type FourthwallOrder = Selectable<FourthwallOrderTable>;
export type NewFourthwallOrder = Insertable<FourthwallOrderTable>;
export type UpdateFourthwallOrder = Updateable<FourthwallOrderTable> & { id: string };

export type RSSFeed = Selectable<RSSFeedTable>;
export type NewRSSFeed = Insertable<RSSFeedTable>;
export type UpdateRSSFeed = Updateable<RSSFeedTable> & { url: string; channelId: string };

export type ScheduledMessage = Selectable<ScheduledMessageTable>;
export type NewScheduledMessage = Insertable<ScheduledMessageTable>;

export interface Database {
  payment: PaymentTable;
  sponsor: SponsorTable;
  discord_link: DiscordLinkTable;
  discord_message: DiscordMessageTable;
  fourthwall_order: FourthwallOrderTable;
  rss_feed: RSSFeedTable;
  scheduled_message: ScheduledMessageTable;
}
