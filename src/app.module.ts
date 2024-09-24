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
import { DatabaseService } from 'src/services/database.service';

const middleware = [{ provide: APP_PIPE, useValue: new ValidationPipe({ transform: true, whitelist: true }) }];
const discord = [DiscordCommands, DiscordEvents, DiscordHelpDesk, DiscordContextMenus];

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [...controllers],
  providers: [...services, ...providers, ...middleware, ...discord],
})
export class AppModule implements OnModuleInit {
  constructor(private databaseService: DatabaseService) {}

  async onModuleInit() {
    await this.databaseService.runMigrations();
  }
}
