import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DateTime } from 'luxon';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from 'src/config';
import { Constants, GithubOrg, GithubRepo } from 'src/constants';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';
import { IFourthwallRepository } from 'src/interfaces/fourthwall.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { IOutlineInterface } from 'src/interfaces/outline.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';
import { formatCommand, logError, shorten } from 'src/util';

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

type GithubCodeSnippet = {
  lines: string[];
  extension: string;
};

type SevenTVResponse = {
  id: string;
  name: string;
  host: {
    url: string;
    files: [
      {
        name: string;
        static_name: string;
        width: number;
        height: number;
        frame_count: number;
        size: number;
        format: string;
      },
    ];
  };
};

type BetterTTVResponse = {
  id: string;
  code: string;
  imageType: string;
  animated: string;
};

const GITHUB_THREAD_REGEX =
  /(https:\/\/github\.com\/)?(((?<org>[\w\-.,_]*)\/)?(?<repo>[\w\-.,_]+))?(\/(?<category>(pull|issue|discussion))\/)?#?(?<num>\d+)/g;
const GITHUB_FILE_REGEX =
  /https:\/\/github.com\/(?<org>[\w\-.,]+)\/(?<repo>[\w\-.,]+)\/blob\/(?<ref>[\w\-.,]+)\/(?<path>[\w\-.,/%\d]+)(#L(?<lineFrom>\d+)(-L(?<lineTo>\d+))?)?/g;

@Injectable()
export class DiscordService {
  private logger = new Logger(DiscordService.name);

  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
    @Inject(IFourthwallRepository) private fourthwall: IFourthwallRepository,
    @Inject(IGithubInterface) private github: IGithubInterface,
    @Inject(IOutlineInterface) private outline: IOutlineInterface,
    @Inject(IZulipInterface) private zulip: IZulipInterface,
  ) {}

  async init() {
    const { bot, github, zulip } = getConfig();
    if (bot.token !== 'dev') {
      await this.discord.login(bot.token);
    }

    if (github.appId !== 'dev') {
      await this.github.init(github.appId, github.privateKey, github.installationId);
    }

    if (zulip.bot.apiKey !== 'dev' && zulip.user.apiKey !== 'dev') {
      await this.zulip.init(zulip);
    }
  }

  @Cron(Constants.Cron.ImmichBirthday)
  async onBirthday() {
    await this.discord.sendMessage({
      channelId: DiscordChannel.General,
      message: `"Happy birthday my other child" - Alex`,
    });
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
      await this.discord.sendMessage({
        channelId: DiscordChannel.BotSpam,
        message: `I'm alive, running ${versionMessage}!`,
      });
    }
  }

  async onError(error: Error) {
    this.logger.verbose(`DiscordBot.onError - ${error}`);
    await logError('Discord bot error', error, { discord: this.discord, logger: this.logger });
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
      name: shorten(`${name} — ${link}`),
      value: name,
    }));
  }

  async addLink({ name, link, author }: { name: string; link: string; author: string }) {
    await this.database.addDiscordLink({ name, link, author });
    return `Successfully added ${link}: ${formatCommand('link', name, '[message]')}`;
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
    } catch {
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
    } catch {
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
        name: shorten(`${item.pull_request ? '[PR]' : '[Issue]'} (${item.number}) ${item.title}`),
        value: String(item.number),
      }));
    } catch {
      this.logger.log('Could not fetch search results from GitHub');
      return [];
    }
  }

  async handleGithubReferences(content: string) {
    const codeSnippets = await this.handleGithubFileReferences(content);
    const links = await this.handleGithubThreadReferences(content);

    return [...codeSnippets, ...links].filter((e) => e !== undefined);
  }

  async handleGithubThreadReferences(content: string) {
    const links: GithubLink[] = [];

    content = content.replaceAll(/```.*```/gs, '');

    const matches = content.matchAll(GITHUB_THREAD_REGEX);

    for (const match of matches) {
      if (!match || !match.groups) {
        continue;
      }

      const { org, repo, category, num } = match.groups;
      const id = Number(num);
      if (Number.isNaN(id)) {
        continue;
      }

      if (!org && !repo && id < 1000) {
        continue;
      }

      links.push({
        id,
        org: org || GithubOrg.ImmichApp,
        repo: repo || GithubRepo.Immich,
        type: category as LinkType,
      });
    }

    const keys = new Set<string>();
    const requests: GithubLink[] = [];

    for (const { id, org, repo, type } of links) {
      const key = id + org + repo;
      if (keys.has(key)) {
        continue;
      }

      requests.push({ id, org, repo, type });
      keys.add(key);
    }

    const results = await Promise.all(
      requests.map(async ({ org, repo, id, type }) => {
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

    return results;
  }

  async handleGithubFileReferences(content: string) {
    const snippets: GithubCodeSnippet[] = [];

    const matches = content.matchAll(GITHUB_FILE_REGEX);

    for (const match of matches) {
      if (!match || !match.groups) {
        continue;
      }

      const { org, repo, ref, path, lineFrom, lineTo } = match.groups;

      const extension = path.split('/').pop()?.split('.').pop();
      if (!extension) {
        continue;
      }

      const file = await this.github.getRepositoryFileContent(org, repo, ref, decodeURIComponent(path));
      if (!file || file.length === 0) {
        continue;
      }

      const from = lineFrom ? Number(lineFrom) - 1 : 0;
      let to;
      if (lineTo) {
        to = Number(lineTo);
      } else if (lineFrom) {
        to = from + 1;
      } else {
        to = file.length;
      }

      if (to - from > 20) {
        continue;
      }

      const lines = file.slice(from, to);

      if (lines.length === 0) {
        continue;
      }

      snippets.push({ lines, extension });
    }

    return snippets.map(({ lines, extension }) => {
      const code = lines.join('\n');
      const formattedCode = code.replaceAll(/`/g, '\\`');
      return `\`\`\`${extension === 'svelte' ? 'tsx' : extension}
${formattedCode}
\`\`\``;
    });
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

  async getMessages(value?: string) {
    let messages = await this.database.getDiscordMessages();
    if (value) {
      const query = value.toLowerCase();
      messages = messages.filter(({ name }) => name.toLowerCase().includes(query));
    }

    return messages.map(({ name, content }) => ({
      name: shorten(`${name} — ${content}`, 40),
      value: name,
    }));
  }

  async getMessage(name: string, increaseUsageCount: boolean = true) {
    const item = await this.database.getDiscordMessage(name);
    if (!item) {
      return;
    }

    if (increaseUsageCount) {
      await this.database.updateDiscordLink({ id: item.id, usageCount: item.usageCount + 1 });
    }

    return item;
  }

  async removeMessage(name: string) {
    const message = await this.database.getDiscordMessage(name);
    if (!message) {
      return LINK_NOT_FOUND;
    }

    await this.database.removeDiscordMessage(message.id);

    return { message: shorten(`Successfully deleted ${message.name} - ${message.content}`), isPrivate: false };
  }

  async addOrUpdateMessage({ name, content, author }: { name: string; content: string; author: string }) {
    const message = await this.database.getDiscordMessage(name);
    if (message) {
      await this.database.updateDiscordMessage({ id: message.id, name, content, lastEditedBy: author });
      return `Successfully updated ${name}: ${formatCommand('messages', name)}`;
    }
    await this.database.addDiscordMessage({ name, content, lastEditedBy: author });
    return `Successfully added ${name}: ${formatCommand('messages', name)}`;
  }

  async createEmote(name: string, emote: string, guildId: string | null) {
    if (!guildId) {
      return;
    }

    try {
      await this.zulip.createEmote(name, emote);
    } catch {
      this.logger.error(`Could not create emote ${name} - ${emote} on Zulip`);
    }
    return this.discord.createEmote(name, emote, guildId);
  }

  async create7TvEmote(id: string, guildId: string | null, name: string | null) {
    if (!guildId) {
      return;
    }

    const rawResponse = await fetch(`https://7tv.io/v3/emotes/${id}`);
    if (rawResponse.status !== 200) {
      return;
    }

    const response = (await rawResponse.json()) as SevenTVResponse;
    const gif = response.host.files.findLast((file) => file.format === 'GIF' && file.size < 256_000);
    const file = gif || response.host.files.findLast((file) => file.format === 'WEBP' && file.size < 256_000)!;

    return this.createEmote(name || response.name, `https:${response.host.url}/${file.name}`, guildId);
  }

  async createBttvEmote(id: string, guildId: string | null, name: string | null) {
    if (!guildId) {
      return;
    }

    const rawResponse = await fetch(`https://api.betterttv.net/3/emotes/${id}`);
    if (rawResponse.status !== 200) {
      return;
    }

    const response = (await rawResponse.json()) as BetterTTVResponse;

    return this.createEmote(name || response.code, `https://cdn.betterttv.net/emote/${id}/3x`, guildId);
  }

  async createEmoteFromExistingOne(emote: string, guildId: string | null, name: string | null) {
    if (!guildId) {
      return;
    }

    const groups = emote.match(/<:(?<name>\w+):(?<id>\d+)>/)?.groups;

    if (!groups?.id || !groups?.name) {
      return;
    }

    return this.createEmote(name || groups.name, `https://cdn.discordapp.com/emojis/${groups.id}.png`, guildId);
  }

  async createOutlineDoc({
    threadParentId,
    threadTags,
    title,
    text,
  }: {
    threadParentId?: string;
    threadTags: string[];
    title: string;
    text?: string;
  }) {
    const { Urls, Discord, Outline } = Constants;
    const {
      outline: { apiKey },
    } = getConfig();

    switch (threadParentId) {
      case Discord.Channels.DevFocusTopic: {
        if (!threadTags.includes(Discord.Tags.DevOutline)) {
          return;
        }

        const { url } = await this.outline.createDocument({
          title,
          text,
          collectionId: Outline.Collections.Dev,
          parentDocumentId: Outline.Documents.DevFocusTopic,
          apiKey,
          icon: 'hammer',
          iconColor: '#0366D6',
        });
        return Urls.Outline + url;
      }
      case Discord.Channels.TeamFocusTopic: {
        if (!threadTags.includes(Discord.Tags.TeamOutline)) {
          return;
        }

        const { url } = await this.outline.createDocument({
          title,
          text,
          collectionId: Outline.Collections.Team,
          parentDocumentId: Outline.Documents.TeamFocusTopic,
          apiKey,
          icon: 'hammer',
          iconColor: '#FF5C80',
        });
        return Urls.Outline + url;
      }
    }
  }

  async updateFourthwallOrders(id?: string | null) {
    const {
      fourthwall: { user, password },
    } = getConfig();

    if (id) {
      await this.updateOrder({ id, user, password });
      return;
    }

    for await (const { id } of this.database.streamFourthwallOrders()) {
      await this.updateOrder({ id, user, password });
    }
  }

  async syncEmotes(guildId: string | null) {
    if (!guildId) {
      return;
    }

    for (const emote of await this.discord.getEmotes(guildId)) {
      await this.zulip.createEmote(emote.name ?? emote.identifier, emote.url);
    }
  }

  private async updateOrder({ id, user, password }: { id: string; user: string; password: string }) {
    const order = await this.fourthwall.getOrder({ id, user, password });

    await this.database.updateFourthwallOrder({
      id,
      discount: order.discount ?? undefined,
      status: order.status,
      total: order.totalPrice.value,
      profit: order.profit.value,
      shipping: order.currentAmounts.shipping.value,
      tax: order.currentAmounts.tax.value,
    });
  }
}
