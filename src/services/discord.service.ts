import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { config } from 'src/config';
import { Constants } from 'src/constants';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';
import { logError } from 'src/util';

@Injectable()
export class DiscordService {
  private logger = new Logger(DiscordService.name);

  constructor(@Inject(IDiscordInterface) private discord: IDiscordInterface) {
    this.discord
      //
      .once('ready', () => this.onReady())
      .on('error', (error) => this.onError(error));
  }

  @Cron(Constants.Cron.ImmichBirthday)
  async onBirthday() {
    await this.discord.sendMessage(DiscordChannel.General, `"Happy birthday my other child" - Alex`);
  }

  private async onReady() {
    const sha = config.commitSha;
    const commit = sha && `[${sha.substring(0, 8)}](https://github.com/immich-app/discord-bot/commit/${sha})`;
    const fullVersion = commit && `${process.env.npm_package_version}@${commit}`;

    // Synchronize applications commands with Discord
    await this.discord.initApplicationCommands();

    this.logger.log(`Bot ${fullVersion} started`);

    if (fullVersion) {
      await this.discord.sendMessage(DiscordChannel.BotSpam, `I'm alive, running ${fullVersion}!`);
    }
  }

  private async onError(error: Error) {
    await logError('Discord bot error', error, { discord: this.discord, logger: this.logger });
  }
}
