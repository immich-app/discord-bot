import { ChatService } from 'src/services/chat.service';
import { DatabaseService } from 'src/services/database.service';
import { GithubService } from 'src/services/github.service';
import { MattermostService } from 'src/services/mattermost.service';
import { RSSService } from 'src/services/rss.service';
import { ScheduleService } from 'src/services/schedule.service';
import { ScheduledMessageService } from 'src/services/scheduled-message.service';
import { WebhookService } from 'src/services/webhook.service';
import { ZulipService } from 'src/services/zulip.service';

export const services = [
  //
  DatabaseService,
  ChatService,
  GithubService,
  ScheduleService,
  RSSService,
  ScheduledMessageService,
  WebhookService,
  MattermostService,
  ZulipService,
];
