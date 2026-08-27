import { Module, OnModuleInit, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { controllers } from 'src/controllers';
import { DiscordCommands } from 'src/discord/commands';
import { DiscordContextMenus } from 'src/discord/context-menus';
import { DiscordEvents } from 'src/discord/events';
import { DiscordHelpDesk } from 'src/discord/help-desk';
import { providers } from 'src/repositories';
import { services } from 'src/services';
import { ChatService } from 'src/services/chat.service';
import { DatabaseService } from 'src/services/database.service';
import { GithubService } from 'src/services/github.service';
import { ScheduledMessageService } from 'src/services/scheduled-message.service';
import { ZulipService } from 'src/services/zulip.service';

const middleware = [{ provide: APP_PIPE, useValue: new ValidationPipe({ transform: true, whitelist: true }) }];
const discord = [DiscordCommands, DiscordEvents, DiscordHelpDesk, DiscordContextMenus];

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [...controllers],
  providers: [...services, ...providers, ...middleware, ...discord],
})
export class AppModule implements OnModuleInit {
  constructor(
    private databaseService: DatabaseService,
    private chatService: ChatService,
    private githubService: GithubService,
    private scheduledMessageService: ScheduledMessageService,
    private zulipService: ZulipService,
  ) {}

  async onModuleInit() {
    await this.githubService.init();
    await this.databaseService.runMigrations();
    await this.chatService.init();
    await this.scheduledMessageService.init();
    await this.zulipService.init();
  }
}
