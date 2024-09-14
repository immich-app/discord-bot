import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DateTime } from 'luxon';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from 'src/config';
import { Constants, GithubOrg, GithubRepo, HELP_TEXTS } from 'src/constants';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { logError } from 'src/util';

const PREVIEW_BLACKLIST = [Constants.Urls.Immich, Constants.Urls.GitHub, Constants.Urls.MyImmich];
const LINK_NOT_FOUND = { message: 'Link not found', isPrivate: true };

const _star_history: Record<string, number | undefined> = {};
const _fork_history: Record<string, number | undefined> = {};

type GithubLink = {
  org: GithubOrg | string;
  repo: GithubRepo | string;
  id: number;
  type?: LinkType;
};
type LinkType = 'issue' | 'pull' | 'discussion';

@Injectable()
export class DiscordService {
  private logger = new Logger(DiscordService.name);

  constructor(
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
    @Inject(IGithubInterface) private github: IGithubInterface,
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
  ) {}

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

  private async getVersionMessage() {
    try {
      const { commitSha: sha } = getConfig();
      const commit = sha && `[${sha.substring(0, 8)}](https://github.com/immich-app/discord-bot/commit/${sha})`;
      const pkg = await readFile(join(__dirname, '..', '..', 'package.json'));
      const { version } = JSON.parse(pkg.toString());
      return commit && `${version}@${commit}`;
    } catch (error: Error | any) {
      this.logger.error(`Unable to send ready message:${error}`, error?.stack);
      return 'Unknown version';
    }
  }

  async onReady() {
    this.logger.verbose('DiscordBot.onReady');

    const versionMessage = await this.getVersionMessage();
    this.logger.log(`Bot ${versionMessage} started`);

    if (versionMessage) {
      await this.discord.sendMessage(DiscordChannel.BotSpam, `I'm alive, running ${versionMessage}!`);
    }
  }

  async onError(error: Error) {
    this.logger.verbose(`DiscordBot.onError - ${error}`);
    await logError('Discord bot error', error, { discord: this.discord, logger: this.logger });
  }

  getHelpMessage(name: keyof typeof HELP_TEXTS) {
    return HELP_TEXTS[name];
  }

  async getLink(name: string, message: string | null) {
    const item = await this.database.getDiscordLink(name);
    if (!item) {
      return LINK_NOT_FOUND;
    }

    await this.database.updateDiscordLink({ id: item.id, usageCount: item.usageCount + 1 });

    return {
      message: (message ? `${message} - ` : '') + item.link,
      isPrivate: false,
    };
  }

  async getLinks(value?: string) {
    let links = await this.database.getDiscordLinks();
    if (value) {
      const query = value.toLowerCase();
      links = links.filter(
        ({ name, link }) => name.toLowerCase().includes(query) || link.toLowerCase().includes(query),
      );
    }

    return links.map(({ name, link }) => ({
      name: this.shortenName(`${name} — ${link}`),
      value: name,
    }));
  }

  async addLink({ name, link, author }: { name: string; link: string; author: string }) {
    await this.database.addDiscordLink({ name, link, author });
    return `Added ${link}`;
  }

  async removeLink({ name }: { name: string }) {
    const link = await this.database.getDiscordLink(name);
    if (!link) {
      return LINK_NOT_FOUND;
    }

    await this.database.removeDiscordLink(link.id);

    return { message: `Removed ${link.name} - ${link.link}`, isPrivate: false };
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
      const starsCount = await this.github.getStarCount(GithubOrg.ImmichApp, GithubRepo.Immich);
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
      const forksCount = await this.github.getForkCount(GithubOrg.ImmichApp, GithubRepo.Immich);
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

      return result.items.map((item) => ({
        name: this.shortenName(`${item.pull_request ? '[PR]' : '[Issue]'} (${item.number}) ${item.title}`),
        value: String(item.number),
      }));
    } catch (error) {
      this.logger.log('Could not fetch search results from GitHub');
      return [];
    }
  }

  async handleGithubReferences(content: string) {
    const links: GithubLink[] = [];

    content = content.replaceAll(/```.*```/gs, '');

    const shortMatches = content.matchAll(/(((?<org>[\w\-.,_]*)\/)?(?<repo>[\w\-.,_]+))?#(?<num>\d+)/g);
    for (const match of shortMatches) {
      if (!match || !match.groups) {
        continue;
      }

      const { org, repo, num } = match.groups;
      const id = Number(num);
      if (Number.isNaN(id)) {
        continue;
      }

      if (!org && !repo && id < 1000) {
        continue;
      }

      links.push({ org: org || GithubOrg.ImmichApp, repo: repo || GithubRepo.Immich, id });
    }

    const longMatches = content.matchAll(
      /https:\/\/github\.com\/(?<org>[\w\-.,]+)\/(?<repo>[\w\-.,]+)\/(?<category>(pull|issue|discussion))\/(?<num>\d+)/g,
    );
    for (const match of longMatches) {
      if (!match || !match.groups) {
        continue;
      }

      const { org, repo, category, num } = match.groups;
      const id = Number(num);
      if (Number.isNaN(id)) {
        continue;
      }

      links.push({
        id,
        org: org || GithubOrg.ImmichApp,
        repo: repo || GithubRepo.Immich,
        type: category as LinkType,
      });
    }

    const results = await Promise.all(
      links.map(async ({ org, repo, id, type }) => {
        switch (type) {
          case 'issue':
          case 'pull':
            return this.github.getIssueOrPr(org, repo, id);

          case 'discussion':
            return this.github.getDiscussion(org, repo, id);

          default:
            return (await this.github.getIssueOrPr(org, repo, id)) || (await this.github.getDiscussion(org, repo, id));
        }
      }),
    );

    return results.filter((link): link is string => link !== undefined);
  }

  hasBlacklistUrl(urls: string[]) {
    for (const url of urls) {
      if (PREVIEW_BLACKLIST.some((blacklist) => url.startsWith(blacklist))) {
        return true;
      }
    }

    return false;
  }

  getPrOrIssue(id: number) {
    return this.github.getIssueOrPr(GithubOrg.ImmichApp, GithubRepo.Immich, id);
  }

  private shortenName(name: string, maxLength: number = 100) {
    return name.length > maxLength ? `${name.substring(0, maxLength - 3)}...` : name;
  }
}
