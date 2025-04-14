import { DatabaseService } from 'src/services/database.service';
import { DiscordService } from 'src/services/discord.service';
import { OAuthService } from 'src/services/oauth.service';
import { ReportService } from 'src/services/report.service';
import { RSSService } from 'src/services/rss.service';
import { WebhookService } from 'src/services/webhook.service';
import { ZulipService } from 'src/services/zulip.service';

export const services = [
  DatabaseService,
  DiscordService,
  OAuthService,
  ReportService,
  RSSService,
  WebhookService,
  ZulipService,
];
