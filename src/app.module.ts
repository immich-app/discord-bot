import { Module, OnModuleInit, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { controllers } from 'src/controllers';
import { DiscordCommands } from 'src/discord/commands';
import { DiscordContextMenus } from 'src/discord/context-menus';
import { DiscordEvents } from 'src/discord/events';
import { DiscordHelpDesk } from 'src/discord/help-desk';
import { DiscordMirrorEvents } from 'src/discord/mirror';
import { providers } from 'src/repositories';
import { services } from 'src/services';
import { ChatService } from 'src/services/chat.service';
import { DatabaseService } from 'src/services/database.service';
import { GithubService } from 'src/services/github.service';
import { MirrorService } from 'src/services/mirror.service';
import { ScheduledMessageService } from 'src/services/scheduled-message.service';
import { ZulipCommandService } from 'src/services/zulip-command.service';
import { ZulipService } from 'src/services/zulip.service';

const middleware = [{ provide: APP_PIPE, useValue: new ValidationPipe({ transform: true, whitelist: true }) }];
const discord = [DiscordCommands, DiscordEvents, DiscordHelpDesk, DiscordContextMenus, DiscordMirrorEvents];

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
    private mirrorService: MirrorService,
    private scheduledMessageService: ScheduledMessageService,
    private zulipCommandService: ZulipCommandService,
    private zulipService: ZulipService,
  ) {}

  async onModuleInit() {
    await this.githubService.init();
    await this.databaseService.runMigrations();
    // Every Zulip handler registers in its service's init, which must run before ZulipService.init starts the loop, or it silently misses messages.
    this.mirrorService.init();
    await this.chatService.init();
    await this.scheduledMessageService.init();
    await this.zulipCommandService.init();
    await this.zulipService.init();
    await this.chatService.loginToDiscord();
  }
}
