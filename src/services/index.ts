import { DatabaseService } from 'src/services/database.service';
import { DiscordService } from 'src/services/discord.service';
import { ReportService } from 'src/services/report.service';
import { RSSService } from 'src/services/rss.service';
import { ScheduledMessageService } from 'src/services/scheduled-message.service';
import { WebhookService } from 'src/services/webhook.service';
import { ZulipService } from 'src/services/zulip.service';

export const services = [
  //
  DatabaseService,
  DiscordService,
  ReportService,
  RSSService,
  ScheduledMessageService,
  WebhookService,
  ZulipService,
];
