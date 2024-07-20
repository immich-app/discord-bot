import { DatabaseService } from 'src/services/database.service';
import { DiscordService } from './discord.service';
import { OAuthService } from './oauth.service';
import { WebhookService } from './webhook.service';

export const services = [DatabaseService, DiscordService, OAuthService, WebhookService];
