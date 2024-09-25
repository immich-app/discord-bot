import { DatabaseService } from 'src/services/database.service';
import { DiscordService } from 'src/services/discord.service';
import { MetricsService } from 'src/services/metrics.service';
import { OAuthService } from 'src/services/oauth.service';
import { ReportService } from 'src/services/report.service';
import { WebhookService } from 'src/services/webhook.service';
import { ZulipService } from 'src/services/zulip.service';

export const services = [
  DatabaseService,
  DiscordService,
  MetricsService,
  OAuthService,
  ReportService,
  WebhookService,
  ZulipService,
];
