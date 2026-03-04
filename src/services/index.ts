import { DatabaseService } from 'src/services/database.service';
import { DiscordService } from 'src/services/discord.service';
import { GithubService } from 'src/services/github.service';
import { RSSService } from 'src/services/rss.service';
import { ScheduleService } from 'src/services/schedule.service';
import { ScheduledMessageService } from 'src/services/scheduled-message.service';
import { WebhookService } from 'src/services/webhook.service';
import { ZulipService } from 'src/services/zulip.service';

export const services = [
  //
  DatabaseService,
  DiscordService,
  GithubService,
  ScheduleService,
  RSSService,
  ScheduledMessageService,
  WebhookService,
  ZulipService,
];
