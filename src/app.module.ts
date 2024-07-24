import { Module, OnModuleInit, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { controllers } from 'src/controllers';
import { BotCommands } from 'src/discord/commands';
import { BotEvents } from 'src/discord/events';
import { providers } from 'src/repositories';
import { services } from 'src/services';
import { DatabaseService } from 'src/services/database.service';

const middleware = [{ provide: APP_PIPE, useValue: new ValidationPipe({ transform: true, whitelist: true }) }];
const discord = [BotCommands, BotEvents];

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
