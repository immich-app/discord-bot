import { Provider } from '@nestjs/common';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { DiscordRepository } from 'src/repositories/discord.repository';
import { GithubRepository } from 'src/repositories/github.repository';

export const providers: Provider[] = [
  //
  { provide: IDatabaseRepository, useClass: DatabaseRepository },
  { provide: IDiscordInterface, useClass: DiscordRepository },
  { provide: IGithubInterface, useClass: GithubRepository },
];
