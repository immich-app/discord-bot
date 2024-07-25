import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DateTime } from 'luxon';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from 'src/config';
import { Constants, HELP_TEXTS, linkCommands } from 'src/constants';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { logError } from 'src/util';

const _star_history: Record<string, number | undefined> = {};
const _fork_history: Record<string, number | undefined> = {};

@Injectable()
export class DiscordService {
  private logger = new Logger(DiscordService.name);

  constructor(
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
    @Inject(IGithubInterface) private github: IGithubInterface,
  ) {
    this.discord
      //
      .once('ready', () => this.onReady())
      .on('error', (error) => this.onError(error));
  }

  async init() {
    const { bot } = getConfig();
    if (bot.token !== 'dev') {
      await this.discord.login(bot.token);
    }
  }

  @Cron(Constants.Cron.ImmichBirthday)
  async onBirthday() {
    await this.discord.sendMessage(DiscordChannel.General, `"Happy birthday my other child" - Alex`);
  }

  getHelpMessage(name: keyof typeof HELP_TEXTS) {
    return HELP_TEXTS[name];
  }

  getLink(name: string, message: string | null) {
    return message ? `${message}: ${linkCommands[name]}` : linkCommands[name];
  }

  getAge() {
    const age = DateTime.now()
      .diff(DateTime.fromObject({ year: 2022, month: 2, day: 3, hour: 15, minute: 56 }, { zone: 'UTC' }), [
        'years',
        'months',
        'days',
        'hours',
        'minutes',
        'seconds',
      ])
      .toHuman({ listStyle: 'long', maximumFractionDigits: 0 });

    return `Immich is ${age} old. ${Constants.Icons.Immich}`;
  }

  getReleaseNotes() {
    return `Please make sure you have read and followed the release notes: ${Constants.Urls.Release}`;
  }

  async getStarsMessage(channelId: string) {
    const lastStarsCount = _star_history[channelId];

    try {
      const starsCount = await this.github.getStarCount();
      const delta = lastStarsCount && starsCount - lastStarsCount;
      const formattedDelta = delta && Intl.NumberFormat(undefined, { signDisplay: 'always' }).format(delta);

      _star_history[channelId] = starsCount;
      return `Stars ⭐: ${starsCount}${
        formattedDelta ? ` (${formattedDelta} stars since the last call in this channel)` : ''
      }`;
    } catch (error) {
      return 'Could not fetch stars count from the GitHub API';
    }
  }

  async getForksMessage(channelId: string) {
    const lastForksCount = _fork_history[channelId];

    try {
      const forksCount = await this.github.getForkCount();
      const delta = lastForksCount && forksCount - lastForksCount;
      const formattedDelta = delta && Intl.NumberFormat(undefined, { signDisplay: 'always' }).format(delta);

      _fork_history[channelId] = forksCount;

      return `Forks: ${forksCount}${formattedDelta ? ` (${formattedDelta} forks since the last call in this channel)` : ''}`;
    } catch (error) {
      return 'Could not fetch forks count from the GitHub API';
    }
  }

  async handleSearchAutocompletion(value: string) {
    if (!value) {
      return [];
    }

    try {
      const result = await this.github.search({
        query: `repo:immich-app/immich in:title ${value}`,
        per_page: 5,
        page: 1,
        sort: 'updated',
        order: 'desc',
      });

      return result.items.map((item) => {
        const name = `${item.pull_request ? '[PR]' : '[Issue]'} (${item.number}) ${item.title}`;
        return {
          name: name.length > 100 ? name.substring(0, 97) + '...' : name,
          value: String(item.number),
        };
      });
    } catch (error) {
      console.log('Could not fetch search results from GitHub');
      return [];
    }
  }

  async handleGithubReferences(content: string) {
    content = content.replaceAll(/```.*```/gs, '');
    const matches = content.matchAll(/(^|\W)#(?<id>[0-9]+)/g);
    const ids = new Set<string>();
    for (const match of matches) {
      const id = match?.groups?.id;
      if (!id) {
        continue;
      }

      ids.add(id);
    }

    const filteredIds = ids.size > 1 ? [...ids].filter((id) => Number(id) > 500 && Number(id) < 15000) : [...ids];
    const links = await Promise.all(
      filteredIds.map(async (id) => (await this.github.getIssueOrPr(id)) || (await this.github.getDiscussion(id))),
    );

    return links.filter((link): link is string => link !== undefined);
  }

  getPrOrIssue(id: string) {
    return this.github.getIssueOrPr(id);
  }

  private async onReady() {
    this.logger.log('Bot.onReady');

    // Synchronize applications commands with Discord
    await this.discord.initApplicationCommands();

    const { commitSha: sha } = getConfig();

    try {
      const commit = sha && `[${sha.substring(0, 8)}](https://github.com/immich-app/discord-bot/commit/${sha})`;
      const pkg = await readFile(join(__dirname, '..', '..', 'package.json'));
      const { version } = JSON.parse(pkg.toString());
      const fullVersion = commit && `${version}@${commit}`;
      this.logger.log(`Bot ${fullVersion} started`);

      if (fullVersion) {
        await this.discord.sendMessage(DiscordChannel.BotSpam, `I'm alive, running ${fullVersion}!`);
      }
    } catch (error: Error | any) {
      this.logger.error(`Unable to send ready message:${error}`, error?.stack);
    }
  }

  private async onError(error: Error) {
    await logError('Discord bot error', error, { discord: this.discord, logger: this.logger });
  }
}
