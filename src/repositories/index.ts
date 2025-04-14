import { Provider } from '@nestjs/common';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IFourthwallRepository } from 'src/interfaces/fourthwall.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { IOutlineInterface } from 'src/interfaces/outline.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { DiscordRepository } from 'src/repositories/discord.repository';
import { FourthwallRepository } from 'src/repositories/fourthwall.repository';
import { GithubRepository } from 'src/repositories/github.repository';
import { OutlineRepository } from 'src/repositories/outline.repository';
import { ZulipRepository } from 'src/repositories/zulip.repository';

export const providers: Provider[] = [
  //
  { provide: IDatabaseRepository, useClass: DatabaseRepository },
  { provide: IDiscordInterface, useClass: DiscordRepository },
  { provide: IFourthwallRepository, useClass: FourthwallRepository },
  { provide: IGithubInterface, useClass: GithubRepository },
  { provide: IOutlineInterface, useClass: OutlineRepository },
  { provide: IZulipInterface, useClass: ZulipRepository },
];
