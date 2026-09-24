import { ChatService } from 'src/services/chat.service';
import { DatabaseService } from 'src/services/database.service';
import { GithubService } from 'src/services/github.service';
import { MattermostService } from 'src/services/mattermost.service';
import { MirrorLinkService } from 'src/services/mirror-link.service';
import { MirrorService } from 'src/services/mirror.service';
import { NotificationService } from 'src/services/notification.service';
import { RSSService } from 'src/services/rss.service';
import { ScheduleService } from 'src/services/schedule.service';
import { ScheduledMessageService } from 'src/services/scheduled-message.service';
import { WebhookService } from 'src/services/webhook.service';
import { ZulipCommandService } from 'src/services/zulip-command.service';
import { ZulipExpanderService } from 'src/services/zulip-expander.service';
import { ZulipService } from 'src/services/zulip.service';

export const services = [
  //
  DatabaseService,
  ChatService,
  GithubService,
  NotificationService,
  ScheduleService,
  RSSService,
  ScheduledMessageService,
  WebhookService,
  MattermostService,
  MirrorService,
  MirrorLinkService,
  ZulipCommandService,
  ZulipExpanderService,
  ZulipService,
];
