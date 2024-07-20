import { Provider } from '@nestjs/common';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { DiscordRepository } from 'src/repositories/discord.repository';

export const providers: Provider[] = [
  //
  { provide: IDatabaseRepository, useClass: DatabaseRepository },
  { provide: IDiscordInterface, useClass: DiscordRepository },
];
