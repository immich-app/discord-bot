import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  CommandInteraction,
  GuildMember,
  hyperlink,
  Message,
  OmitPartialGroupDMChannel,
  SendableChannels,
} from 'discord.js';
import _ from 'lodash';
import { DateTime } from 'luxon';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from 'src/config';
import { Constants, GithubItemKind, GithubOrg, GithubRepo } from 'src/constants';
import {
  neutraliseZulipMentions,
  plural,
  scanZulipFences,
  shorten,
  splitOutsideCode,
  ZULIP_QUOTE_FENCES,
} from 'src/format';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';
import { IFourthwallRepository } from 'src/interfaces/fourthwall.interface';
import { IGithubInterface, IssueOrPullRequestMessage } from 'src/interfaces/github.interface';
import { GitlabItemKind, IGitlabInterface } from 'src/interfaces/gitlab.interface';
import { ILoopDedupeInterface } from 'src/interfaces/loop-dedupe.interface';
import { IOutlineInterface } from 'src/interfaces/outline.interface';
import { IZulipInterface, ZulipEmojiCodes, ZulipReceivedMessage } from 'src/interfaces/zulip.interface';
import { ZulipApiError } from 'src/repositories/zulip.client';
import { GithubItem } from 'src/schema';
import { ApprovalService } from 'src/services/approval.service';
import { NotificationService } from 'src/services/notification.service';
import {
  ExpanderScope,
  findRepository,
  gitlabPath,
  isGitlabRepository,
  LINKS_ONLY,
  sameRepository,
  toConversationKey,
  ZulipExpanderService,
} from 'src/services/zulip-expander.service';
import { ZulipService } from 'src/services/zulip.service';
import { formatCommand, logError, makeIssueOrPRMessage, makeLink } from 'src/util';

const PREVIEW_BLACKLIST = [Constants.Urls.GitHub, Constants.Urls.MyImmich, Constants.Urls.ImmichDocs];
const LINK_NOT_FOUND = { message: 'Link not found', isPrivate: true };
const DISCORD_READY_WAIT_MS = 60_000;

export const hasBlacklistedUrl = (urls: string[]) =>
  urls.some((url) => PREVIEW_BLACKLIST.some((blacklist) => url.startsWith(blacklist)));

const _star_history: Record<string, number | undefined> = {};
const _fork_history: Record<string, number | undefined> = {};

type GithubLink = {
  org: GithubOrg | string;
  repo: GithubRepo | string;
  id: number;
  type?: LinkType;
  discordThreadId?: string;
};
type LinkType = 'issues' | 'pull' | 'discussions';

/** `kind` is unknown for `#123`, which may be an issue or a merge request: GitLab numbers them apart. */
type GitlabLink = { path: string; id: number; kind?: GitlabItemKind };

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

const GITHUB_PAGE_REGEX =
  /https:\/\/github\.com\/(?<orgPage>[\w\-.,_]*)\/(?<repoPage>[\w\-.,_]+)\/(?<category>(pull|issues|discussions))\/(?<numPage>\d+)/g;
const GITHUB_QUICK_REF_REGEX = /(((?<org>[\w\-.,_]*)\/)?(?<repo>[\w\-.,_]+))?(?<!<)#(?<num>\d+)/g;
// Issue and pull request numbers are stored as Postgres integers.
const MAX_GITHUB_NUMBER = 2_147_483_647;
const GITHUB_THREAD_REGEX = new RegExp(`(${GITHUB_PAGE_REGEX.source})|(${GITHUB_QUICK_REF_REGEX.source})`, 'g');
/**
 * `#123` with nothing joined to it: on the left not part of a word or a path (though `#12/#13` is two), `&#91;`,
 * `<#123>` or `\#5`, and on the right not a word, `%`, a decimal, a time or a range. Its path is a name, `owner/name`
 * or a longer GitLab path.
 */
const ZULIP_SHORTHAND_REGEX =
  /(?<![\w.!#&<@=?$\\-])(?<!(?<!#\d+)\/)(?<path>\w[\w.-]*(?:\/[\w.-]+)*)?#(?<num>[1-9]\d*)(?![\w%]|[.,:/\-–—]\d)/;
/**
 * A GitHub page link or any other link, matched whole so that nothing in its path, query or fragment is shorthand, or
 * shorthand.
 */
const ZULIP_THREAD_REGEX = new RegExp(
  `(${GITHUB_PAGE_REGEX.source})[^\\s<>]*|https?:\\/\\/[^\\s<>]+|(${ZULIP_SHORTHAND_REGEX.source})`,
  'g',
);
/** Letters, digits and hyphens, so `example.com/docs#12` names no GitHub repository. */
const GITHUB_LOGIN_REGEX = /^[\da-z-]+$/i;
const GITLAB_HOST = Constants.Gitlab.Host.replaceAll('.', '\\.');
const GITLAB_PAGE_REGEX = new RegExp(
  `https://${GITLAB_HOST}/(?<path>[\\w.-]+(?:/[\\w.-]+)+)/-/(?<kind>issues|work_items|merge_requests)/(?<num>\\d+)`,
  'g',
);
const GITLAB_FILE_REGEX = new RegExp(
  `https://${GITLAB_HOST}/(?<path>[\\w.-]+(?:/[\\w.-]+)+)/-/blob/(?<refAndFile>[\\w\\-.,/%]+)(#L(?<lineFrom>\\d+)(-L?(?<lineTo>\\d+))?)?`,
  'g',
);
/** On Zulip, permalinks past this many in one message, of either host, get no snippet: it bounds the files one message has the bot read. */
const MAX_ZULIP_FILE_REFERENCES = 5;

/** How many permalinks of one message are read at a time. */
const FILE_READ_CONCURRENCY = 5;

/** `Promise.all(items.map(map))` with at most `limit` running at a time. */
const mapConcurrently = async <T, R>(items: T[], limit: number, map: (item: T) => Promise<R>) => {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const work = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, work));
  return results;
};

/** Zulip reads a block indented after a list item, by two spaces or more, as the item's text before it can be code. */
const ZULIP_LIST_ITEM = /^ *(?:[*+-]|\d+\.) /;

/**
 * What Zulip renders as text: no fenced code (an unclosed fence runs to the end of the message), no indented code
 * block (four spaces or a tab, after a blank line or another such line, unless it continues a list item), no code
 * span, and with `skipQuotes` no quote fence either.
 */
const zulipTextOutsideCode = (content: string, { skipQuotes = false } = {}) => {
  const lines = content.split(/\r\n?|\n/);
  const { lineFences } = scanZulipFences(lines);
  const kept: string[] = [];
  let indentedCode = false;
  let list = false;
  for (const [index, line] of lines.entries()) {
    // Zulip renders a fence as a block of its own, so a list does not run into one or out of one.
    if (index > 0 && lineFences[index] !== lineFences[index - 1]) {
      list = false;
    }
    let hidden = false;
    for (let fence = lineFences[index]; fence && !hidden; fence = fence.parent) {
      hidden = fence.code || (skipQuotes && ZULIP_QUOTE_FENCES.has(fence.lang));
    }
    const blankBefore = index === 0 || lines[index - 1].trim() === '';
    indentedCode = !hidden && /^( {4}|\t)/.test(line) && (indentedCode || (blankBefore && !list));
    if (hidden || indentedCode) {
      continue;
    }
    if (line.trim() !== '') {
      list = ZULIP_LIST_ITEM.test(line) || (list && (!blankBefore || /^( {2}|\t)/.test(line)));
    }
    kept.push(line);
  }
  return splitOutsideCode(kept.join('\n'))
    .filter(({ code }) => !code)
    .map(({ text }) => text)
    .join('\n');
};

/** A GitHub link names its repository and kind; shorthand has at most a path, which the place's repositories resolve. */
type ZulipThreadReference =
  { owner: string; name: string; category: LinkType; id: number } | { path?: string; id: number };

/** The GitHub links and the shorthand of Zulip text, in order. */
export const zulipThreadReferences = (text: string) =>
  [...text.matchAll(ZULIP_THREAD_REGEX)].flatMap(({ groups = {} }): ZulipThreadReference[] => {
    if (groups.numPage !== undefined) {
      return [
        {
          owner: groups.orgPage,
          name: groups.repoPage,
          category: groups.category as LinkType,
          id: Number(groups.numPage),
        },
      ];
    }

    return groups.num === undefined ? [] : [{ path: groups.path, id: Number(groups.num) }];
  });

/**
 * The repository shorthand's path names, a leading `github.com/` left out: one of the place's, by the end of its name;
 * else a name alone beside the default repository, or `owner/name` on GitHub when the owner can be a GitHub login. A
 * longer path, which only a GitLab project has, names one of the place's or nothing.
 */
const shorthandRepository = ({ repositories, defaultRepository }: ExpanderScope, path: string) => {
  const wanted = path.replace(/^github\.com\//i, '');
  const found = findRepository(repositories, wanted);
  if (found) {
    return found;
  }

  const segments = wanted.split('/');
  if (segments.length === 1) {
    return defaultRepository && `${defaultRepository.slice(0, defaultRepository.lastIndexOf('/'))}/${wanted}`;
  }

  return segments.length === 2 && GITHUB_LOGIN_REGEX.test(segments[0]) ? wanted : undefined;
};

/** The images `Constants.Zulip.EmojiImages` names for the emoji a message uses outside code, each once. */
const emojiImages = (content: string) => {
  const text = zulipTextOutsideCode(content);
  const images = [...text.matchAll(/:([\w+-]+):/g)].map(([, name]) => Constants.Zulip.EmojiImages[name.toLowerCase()]);
  return [...new Set(images.filter((image) => image !== undefined))];
};

/** How many leading path segments of a GitLab permalink are tried as its ref. */
const MAX_GITLAB_REF_SEGMENTS = 5;

/** `undefined` for text with a malformed escape, which `decodeURIComponent` throws on. */
const decode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return;
  }
};

const GITHUB_FILE_REGEX =
  /https:\/\/github.com\/(?<org>[\w\-.,]+)\/(?<repo>[\w\-.,]+)\/blob\/(?<ref>[\w\-.,]+)\/(?<path>[\w\-.,/%\d]+)(#L(?<lineFrom>\d+)(-L(?<lineTo>\d+))?)?/g;

/**
 * Zulip allows only letters, digits, `-` and `_` (read as a space), ignores case, and refuses a name that
 * ends in `_` or `-`, a rule its spec leaves out.
 */
export const toZulipEmojiName = (name: string) => {
  const legal = name
    .toLowerCase()
    .replaceAll(/[^0-9a-z_-]/g, '_')
    .replace(/[_-]+$/, '');
  return legal || 'emote';
};

/**
 * The suffix is decided from the run and Zulip's built-in names alone so it is stable across syncs: an emote
 * uploaded as `catjam2` or `fire2` is found again rather than re-uploaded as `catjam3` or `fire3`.
 */
const claimZulipEmojiName = (name: string, claimed: Set<string>) => {
  const base = toZulipEmojiName(name);
  let candidate = base;
  for (let suffix = 2; claimed.has(candidate); suffix++) {
    candidate = `${base}${suffix}`;
  }
  claimed.add(candidate);
  return candidate;
};

/**
 * The Zulip names the sync gives Discord's emotes, in Discord's order. A realm emoji already holding a built-in name
 * (an administrator's override) counts as that emote, already synced, so that name is not claimed beforehand.
 */
/** Its logo emoji `zulip` is not in the table, and Zulip lets even a member replace it. */
export const zulipBuiltInEmoji = ({ unicode }: ZulipEmojiCodes) => [...Object.keys(unicode), 'zulip'];

/**
 * An emote a sync recorded keeps the name it was uploaded under, whatever order Discord lists the emotes in now, and
 * no other emote claims that name; a recorded name Zulip has since made a built-in one is given up while no realm
 * emoji holds it.
 */
export const zulipEmojiNames = (
  emoteNames: string[],
  builtIn: string[],
  existing: Set<string>,
  recordedNames: Array<string | undefined> = [],
) => {
  const claimed = new Set(builtIn.filter((name) => !existing.has(name)));
  const kept = recordedNames.map((name) => (name === undefined || claimed.has(name) ? undefined : name));
  for (const name of kept) {
    if (name !== undefined) {
      claimed.add(name);
    }
  }
  return emoteNames.map((name, index) => kept[index] ?? claimZulipEmojiName(name, claimed));
};

type ZulipSkipReason = 'unlisted' | 'builtins' | 'refused';

const ZULIP_SKIP_REASONS: Record<ZulipSkipReason, string> = {
  unlisted: 'its emoji could not be listed',
  builtins: 'its built-in emoji names could not be read',
  refused: 'Zulip refused the credentials of the user account that uploads emoji',
};

export type EmoteSyncReport = {
  total: number;
  zulipUploaded: number;
  zulipSkipped?: ZulipSkipReason;
  failed: string[];
  renamed: string[];
  /** Non-square emotes Zulip had cropped, or a sync had stretched, uploaded again padded. */
  replaced: string[];
  alreadyOnZulip: string[];
};

export const formatEmoteSyncReport = (
  { total, zulipUploaded, zulipSkipped, failed, renamed, replaced, alreadyOnZulip }: EmoteSyncReport,
  subject?: string,
) => {
  const done = subject ? `Done syncing ${subject}` : 'Done syncing';
  if (total === 0) {
    return `${done}: the Discord server has no emotes, so nothing was uploaded`;
  }
  const outcome = [
    plural(total, 'emote'),
    `${zulipUploaded} uploaded to Zulip${zulipSkipped ? ` (skipped: ${ZULIP_SKIP_REASONS[zulipSkipped]})` : ''}`,
    failed.length > 0 && `${failed.length} failed: ${failed.join(', ')}`,
    renamed.length > 0 && `${renamed.length} renamed: ${renamed.join(', ')}`,
    replaced.length > 0 && `${replaced.length} padded and replaced: ${replaced.join(', ')}`,
    alreadyOnZulip.length > 0 && `${alreadyOnZulip.length} already on Zulip: ${alreadyOnZulip.join(', ')}`,
  ];
  return `${done}: ${outcome.filter(Boolean).join(', ')}`;
};

@Injectable()
export class ChatService {
  private logger = new Logger(ChatService.name);

  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
    @Inject(IFourthwallRepository) private fourthwall: IFourthwallRepository,
    @Inject(IGithubInterface) private github: IGithubInterface,
    @Inject(IGitlabInterface) private gitlab: IGitlabInterface,
    @Inject(ILoopDedupeInterface) private loopDedupe: ILoopDedupeInterface,
    @Inject(IOutlineInterface) private outline: IOutlineInterface,
    @Inject(IZulipInterface) private zulip: IZulipInterface,
    private zulipService: ZulipService,
    private notifications: NotificationService,
    private zulipExpanders: ZulipExpanderService,
    private approvals: ApprovalService,
  ) {}

  async init() {
    this.discord.onHandlerError((error) => this.onError(error));
    // The Zulip clients are initialised once, by ZulipService.
    this.zulipService.onMessage((message) => this.onZulipMessage(message));
  }

  async onZulipMessage({ type, streamId, topic, content, recipientIds = [] }: ZulipReceivedMessage) {
    let reply: (content: string) => Promise<{ id: number }>;
    let scope: ExpanderScope;
    if (type === 'private') {
      const others = recipientIds.filter((userId) => userId !== this.zulipService.ownUser?.userId);
      // Private repositories expand too, so a conversation with a guest gets nothing.
      const guests = await Promise.all(others.map((userId) => this.zulipService.isGuest(userId)));
      if (others.length === 0 || guests.includes(true)) {
        return;
      }
      reply = (content) => this.zulip.sendDirectMessage(others, content);
      scope = this.zulipExpanders.getScope(toConversationKey(recipientIds)) ?? LINKS_ONLY;
    } else if (streamId === undefined) {
      return;
    } else {
      reply = (content) => this.zulip.sendMessage({ stream: streamId, topic, content });
      scope = this.zulipExpanders.getScope(streamId) ?? LINKS_ONLY;
    }

    // One failing lookup must not cost the reply the rest; the failure still reaches the event loop's log.
    const [expansions] = await Promise.allSettled([this.zulipExpansions(scope, content)]);
    const parts = [...(expansions.status === 'fulfilled' ? expansions.value.parts : []), ...emojiImages(content)];

    if (parts.length !== 0) {
      const { id } = await reply(parts.join('\n'));
      await this.approvals.track(
        { service: 'zulip', messageId: String(id), channelId: null },
        expansions.status === 'fulfilled' ? expansions.value.pullRequests : [],
      );
    }
    if (expansions.status === 'rejected') {
      throw expansions.reason;
    }
  }

  private async zulipExpansions(scope: ExpanderScope, content: string) {
    // Snippets are not neutralised: Zulip renders no mention inside a code fence,
    // and a zero-width space would corrupt the code.
    const firstPermalinks = [
      ...[...content.matchAll(GITHUB_FILE_REGEX)].map(({ index }) => ({ index, host: 'github' })),
      ...[...content.matchAll(GITLAB_FILE_REGEX)].map(({ index }) => ({ index, host: 'gitlab' })),
    ]
      .sort((a, b) => a.index - b.index)
      .slice(0, MAX_ZULIP_FILE_REFERENCES);
    const [githubSnippets, gitlabSnippets, links, twitter] = await Promise.all([
      this.handleGithubFileReferences(content, true, firstPermalinks.filter(({ host }) => host === 'github').length),
      this.handleGitlabFileReferences(content, firstPermalinks.filter(({ host }) => host === 'gitlab').length),
      this.handleGithubThreadReferences({ content, scope }, true),
      this.handleTwitterReferences(content),
    ]);
    return {
      parts: [...githubSnippets, ...gitlabSnippets, ...[...links.parts, ...twitter].map(neutraliseZulipMentions)],
      pullRequests: links.pullRequests,
    };
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

  async loginToDiscord() {
    const { bot } = getConfig();
    const login = bot.token === 'dev' ? Promise.resolve() : this.discord.login(bot.token);
    void this.announceStartup(login);
    try {
      await login;
    } catch (error) {
      await logError('Discord login failed', error, { notifications: this.notifications, logger: this.logger });
      throw error;
    }
  }

  private async announceStartup(discordLogin: Promise<void>) {
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<'waited'>(
      (resolve) => (timer = setTimeout(() => resolve('waited'), DISCORD_READY_WAIT_MS)),
    );
    const outcome = await Promise.race([
      discordLogin.then(
        () => 'ready',
        () => 'failed',
      ),
      waited,
    ]);
    clearTimeout(timer);
    if (outcome === 'failed') {
      return;
    }

    const versionMessage = await this.getVersionMessage();
    this.logger.log(`Bot ${versionMessage} started`);

    if (versionMessage) {
      await this.notifications.notify('team.bot', { kind: 'log', title: `I'm alive, running ${versionMessage}!` });
    }
  }

  onReady() {
    this.logger.verbose('DiscordBot.onReady');
  }

  async onError(error: unknown) {
    // thrown when trying to send a message to a not-yet-fully-initialized thread
    if (error instanceof Error && error.name === 'DiscordAPIError[10008]') {
      return;
    }

    this.logger.verbose(`DiscordBot.onError - ${error}`);
    await logError('Discord bot error', error, { notifications: this.notifications, logger: this.logger });
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

    return links
      .map(({ name, link }) => ({
        name: shorten(`${name} — ${link}`),
        value: name,
      }))
      .slice(0, 25);
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

  async handleTwitterReferences(content: string) {
    const links: string[] = [];
    content = content.replaceAll(/```.*```/gs, '');

    const matches = content.matchAll(/https:\/\/x\.com\/(?<path>[^ ]+)/g);

    for (const match of matches) {
      if (!match || !match.groups) {
        continue;
      }

      const { path } = match.groups;
      links.push(`https://nitter.net/${path}`);
    }

    return links;
  }

  async handleGithubReferences(
    { content, channelParentId }: { content: string; channelParentId?: string | null },
    isPrivileged: boolean,
  ) {
    const codeSnippets = await this.handleGithubFileReferences(content, isPrivileged);
    const links = await this.handleGithubThreadReferences({ content, channelParentId }, isPrivileged);

    return { parts: [...codeSnippets, ...links.parts], pullRequests: links.pullRequests };
  }

  async handleGithubThreadReferences(
    {
      content,
      channelParentId,
      scope,
    }: {
      content: string;
      channelParentId?: string | null;
      scope?: ExpanderScope;
    },
    isPrivileged: boolean,
  ) {
    const links: GithubLink[] = [];
    const gitlabLinks: GitlabLink[] = [];

    if (scope) {
      content = zulipTextOutsideCode(content, { skipQuotes: true });

      for (const reference of zulipThreadReferences(content)) {
        if (reference.id > MAX_GITHUB_NUMBER) {
          continue;
        }

        const link =
          'category' in reference
            ? { org: reference.owner, repo: reference.name, id: reference.id, type: reference.category }
            : await this.resolveScopedReference(scope, reference);
        if (link && 'path' in link) {
          gitlabLinks.push(link);
        } else if (link) {
          links.push(link);
        }
      }

      for (const { groups } of content.matchAll(GITLAB_PAGE_REGEX)) {
        const id = Number(groups?.num);
        if (groups && id <= MAX_GITHUB_NUMBER) {
          gitlabLinks.push({
            path: groups.path,
            id,
            kind: groups.kind === 'merge_requests' ? 'merge_requests' : 'issues',
          });
        }
      }
    } else {
      for (const match of content.replaceAll(/```.*```/gs, '').matchAll(GITHUB_THREAD_REGEX)) {
        if (!match || !match.groups) {
          continue;
        }

        const { org, orgPage, repo, repoPage, category, num, numPage } = match.groups;
        const id = Number(num ?? numPage);
        if (Number.isNaN(id) || id > MAX_GITHUB_NUMBER) {
          continue;
        }

        const latestPr = await this.database.getLatestPullRequestByNumber(id, GithubOrg.ImmichApp);
        const isQuickRef = !org && !orgPage && !repo && !repoPage;

        if (
          isQuickRef &&
          (!latestPr || latestPr.updatedAt < DateTime.now().minus({ week: 2 }).toJSDate()) &&
          id < 1000
        ) {
          continue;
        }

        links.push({
          id,
          org: org || orgPage || latestPr?.organization || GithubOrg.ImmichApp,
          repo: repo || repoPage || latestPr?.repository || GithubRepo.Immich,
          type: latestPr ? 'pull' : (category as LinkType),
          discordThreadId:
            channelParentId === undefined
              ? undefined
              : channelParentId === Constants.Discord.Categories.Team
                ? (latestPr?.discordThreadId ?? undefined)
                : undefined,
        });
      }
    }

    const keys = new Set<string>();
    const requests: GithubLink[] = [];

    for (const { id, org, repo, type, discordThreadId } of links) {
      const key = id + org + repo;
      if (keys.has(key)) {
        continue;
      }

      requests.push({ id, org, repo, type, discordThreadId });
      keys.add(key);
    }

    const results = await Promise.all(
      requests.map(async ({ org, repo, id, type, discordThreadId }): Promise<IssueOrPullRequestMessage | undefined> => {
        const getDiscussion = async () => {
          const message = await this.github.getDiscussionMessage(org, repo, id, isPrivileged);
          return message === undefined ? undefined : { message };
        };

        switch (type) {
          case 'issues':
          case 'pull':
            return await this.github.getIssueOrPrMessage(org, repo, id, discordThreadId, isPrivileged);

          case 'discussions':
            return await getDiscussion();

          default:
            return (
              (await this.github.getIssueOrPrMessage(org, repo, id, discordThreadId, isPrivileged)) ??
              (await getDiscussion())
            );
        }
      }),
    );
    const pullRequests = _.uniqBy(
      results.map((result) => result?.pullRequest).filter((pullRequest) => pullRequest !== undefined),
      ({ organization, repository, number }) => `${organization}/${repository}#${number}`.toLowerCase(),
    );

    const gitlabKeys = new Set<string>();
    const gitlabRequests = gitlabLinks.filter(({ path, id, kind }) => {
      const key = `${path.toLowerCase()}#${id}:${kind}`;
      if (gitlabKeys.has(key)) {
        return false;
      }
      gitlabKeys.add(key);
      return true;
    });

    const gitlabUrls = new Set<string>();
    const gitlabResults = (await Promise.all(gitlabRequests.map((link) => this.getGitlabMessage(link)))).filter(
      (result) => {
        if (!result || gitlabUrls.has(result.url)) {
          return false;
        }
        gitlabUrls.add(result.url);
        return true;
      },
    );

    return {
      parts: [...results, ...gitlabResults].map((result) => result?.message).filter((part) => part !== undefined),
      pullRequests,
    };
  }

  /** `#123` is whichever of the issue and the merge request of that number was updated last. */
  private async getGitlabMessage({ path, id, kind }: GitlabLink) {
    const kinds: GitlabItemKind[] = kind ? [kind] : ['issues', 'merge_requests'];
    const items = await Promise.all(kinds.map((candidate) => this.gitlab.getItem(path, candidate, id)));
    const item = items
      .filter((candidate) => candidate !== undefined)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    if (!item) {
      return;
    }
    return {
      url: item.url,
      message: `[${item.kind === 'issues' ? 'Issue' : 'Merge Request'}] ${item.title} (${hyperlink(`${path}#${id}`, item.url)})`,
    };
  }

  /**
   * Shorthand with a path goes to the repository `shorthandRepository` names; a bare `#123` goes to the place's
   * repository whose item of that number was updated last, whatever its kind and age, the one listed first on a tie, or
   * else to the place's default repository, below whose threshold it is dropped.
   */
  private async resolveScopedReference(
    scope: ExpanderScope,
    { path, id }: { path?: string; id: number },
  ): Promise<GithubLink | GitlabLink | undefined> {
    const named = path === undefined ? undefined : shorthandRepository(scope, path);
    if (path !== undefined && !named) {
      return;
    }

    if (!named && scope.repositories.length === 0 && !scope.defaultRepository) {
      return;
    }

    const items = await this.database.getGithubItemsByNumber(id);
    const fullName = (item: GithubItem) => `${item.organization}/${item.repository}`;

    let repository: string;
    if (named) {
      repository = named;
    } else {
      const [newest] = items
        .map((item) => ({
          item,
          index: scope.repositories.findIndex((candidate) => sameRepository(candidate, fullName(item))),
        }))
        .filter(({ index }) => index !== -1)
        .sort((a, b) => b.item.updatedAt.getTime() - a.item.updatedAt.getTime() || a.index - b.index);
      if (newest) {
        repository = scope.repositories[newest.index];
      } else if (!scope.defaultRepository || id < scope.threshold(scope.defaultRepository)) {
        return;
      } else {
        repository = scope.defaultRepository;
      }
    }

    if (isGitlabRepository(repository)) {
      return { path: gitlabPath(repository), id };
    }

    const [org, repo] = repository.split('/');
    const isPullRequest = items.some(
      (item) => item.kind === GithubItemKind.PullRequest && sameRepository(fullName(item), repository),
    );
    return { org, repo, id, type: isPullRequest ? 'pull' : undefined };
  }

  /** `limit` is how many of the message's permalinks are read, every one when it is left out. */
  handleGithubFileReferences(content: string, isPrivileged: boolean, limit?: number) {
    return this.handleFileReferences(content, GITHUB_FILE_REGEX, limit, ({ org, repo, ref, path }) => {
      const file = decode(path);
      return file === undefined
        ? undefined
        : { path, read: () => this.github.getRepositoryFileContent(org, repo, ref, file, isPrivileged) };
    });
  }

  handleGitlabFileReferences(content: string, limit: number) {
    return this.handleFileReferences(content, GITLAB_FILE_REGEX, limit, ({ path, refAndFile }) => {
      const segments = refAndFile.split('/').map(decode);
      if (segments.length < 2 || segments.some((segment) => !segment)) {
        return;
      }
      return { path: segments.at(-1) as string, read: () => this.readGitlabFile(path, segments as string[]) };
    });
  }

  /**
   * A ref may hold slashes, so the URL does not say where the ref ends and the file begins: every split is tried at
   * once, and the longest ref that has the file wins, as GitLab itself resolves it.
   */
  private async readGitlabFile(path: string, segments: string[]) {
    const splits = Math.min(segments.length - 1, MAX_GITLAB_REF_SEGMENTS);
    const files = await Promise.all(
      Array.from({ length: splits }, (_, index) =>
        this.gitlab.getFileContent(path, segments.slice(0, index + 1).join('/'), segments.slice(index + 1).join('/')),
      ),
    );
    return files.findLast((file) => file !== undefined);
  }

  private async handleFileReferences(
    content: string,
    regex: RegExp,
    limit: number | undefined,
    toFile: (groups: Record<string, string>) => { path: string; read: () => Promise<string[] | undefined> } | undefined,
  ) {
    const found = await mapConcurrently(
      [...content.matchAll(regex)].slice(0, limit),
      FILE_READ_CONCURRENCY,
      async (match): Promise<GithubCodeSnippet | undefined> => {
        if (!match.groups) {
          return;
        }

        const { lineFrom, lineTo } = match.groups;
        const reference = toFile(match.groups);
        if (!reference) {
          return;
        }

        const extension = reference.path.split('/').pop()?.split('.').pop();
        if (!extension) {
          return;
        }

        const file = await reference.read();
        if (!file || file.length === 0) {
          return;
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
          return;
        }

        const lines = file.slice(from, to);

        if (lines.length === 0) {
          return;
        }

        return { lines, extension };
      },
    );
    const snippets = found.filter((snippet) => snippet !== undefined);

    return snippets.map(({ lines, extension }) => {
      const code = lines.join('\n');
      const formattedCode = code.replaceAll(/`/g, '\\`');
      return `\`\`\`${extension === 'svelte' ? 'tsx' : extension}
${formattedCode}
\`\`\``;
    });
  }

  hasBlacklistUrl(urls: string[]) {
    return hasBlacklistedUrl(urls);
  }

  async getPrOrIssue(id: number) {
    const found = await this.github.getIssueOrPrMessage(GithubOrg.ImmichApp, GithubRepo.Immich, id, undefined, false);
    return found?.message;
  }

  async getMessages(value?: string) {
    let messages = await this.database.getDiscordMessages();
    if (value) {
      const query = value.toLowerCase();
      messages = messages.filter(({ name }) => name.toLowerCase().includes(query));
    }

    return messages
      .map(({ name, content }) => ({
        name: shorten(`${name} — ${content}`, 40),
        value: name,
      }))
      .slice(0, 25);
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
    } catch (error) {
      this.logger.error(`Could not create emote ${name} - ${emote} on Zulip`, error);
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
          icon: 'hammer',
          iconColor: '#FF5C80',
        });
        return Urls.Outline + url;
      }
      case Discord.Channels.YuccaFocusTopic: {
        if (!threadTags.includes(Discord.Tags.YuccaOutline)) {
          return;
        }

        const { url } = await this.outline.createDocument({
          title,
          text,
          collectionId: Outline.Collections.Yucca,
          parentDocumentId: Outline.Documents.YuccaFocusTopic,
          icon: 'hammer',
          iconColor: '#FF825C',
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

  async syncEmotes(guildId: string): Promise<EmoteSyncReport> {
    const emotes = await this.discord.getEmotes(guildId);
    if (!emotes) {
      throw new Error(
        `Cannot read the emotes of Discord server ${guildId}: the bot is not logged in to Discord, or not a member of that server`,
      );
    }
    const emoji = await this.listZulipEmoji();
    const existing = emoji && new Set(emoji.map(({ name }) => name));
    const records = new Map(
      (existing ? await this.database.getZulipEmotes() : []).map((record) => [record.discordEmoteId, record]),
    );
    const builtIn = existing ? await this.listZulipBuiltInEmoji() : undefined;
    const zulipNames =
      existing && builtIn
        ? zulipEmojiNames(
            emotes.map((emote) => emote.name ?? emote.identifier),
            builtIn,
            existing,
            emotes.map((emote) => records.get(emote.id)?.zulipName),
          )
        : [];

    let zulipSkipped: ZulipSkipReason | undefined = existing ? (builtIn ? undefined : 'builtins') : 'unlisted';
    let zulipUploaded = 0;
    const failed: string[] = [];
    const renamed: string[] = [];
    const replaced: string[] = [];
    const alreadyOnZulip: string[] = [];
    for (const [index, emote] of emotes.entries()) {
      const name = emote.name ?? emote.identifier;
      const url = emote.animated ? emote.url.replace(/\.(?<extension>[a-zA-Z]+?)$/, '.gif') : emote.url;

      // One bad emote must not abort the rest of the sync.
      if (existing && !zulipSkipped) {
        const record = records.get(emote.id);
        const zulipName = zulipNames[index];
        const asZulip = zulipName === name.toLowerCase() ? name : `${name} → ${zulipName}`;
        // A record of a name given up says nothing of the emoji under the new one.
        if (existing.has(zulipName) && record?.zulipName === zulipName && record.padded) {
          alreadyOnZulip.push(asZulip);
        } else if (existing.has(zulipName)) {
          // The emoji of that name is the emote's, whoever uploaded it: cropped by Zulip, or stretched, if not square.
          const zulip = await this.onZulip(name, url, () => this.zulip.replaceCroppedEmote(zulipName, url));
          if (zulip === 'refused') {
            zulipSkipped = 'refused';
          } else if (zulip === 'failed') {
            failed.push(name);
          } else {
            (zulip === 'replaced' ? replaced : alreadyOnZulip).push(asZulip);
            await this.database.addZulipEmote(emote.id, zulipName);
          }
        } else {
          const zulip = await this.onZulip(name, url, () => this.zulip.createEmote(zulipName, url));
          if (zulip === 'refused') {
            zulipSkipped = 'refused';
          } else {
            if (asZulip !== name) {
              renamed.push(asZulip);
            }
            if (zulip === 'failed') {
              failed.push(name);
            } else {
              zulipUploaded++;
              await this.database.addZulipEmote(emote.id, zulipName);
            }
          }
        }
      }
    }

    return {
      total: emotes.length,
      zulipUploaded,
      zulipSkipped,
      failed,
      renamed,
      replaced,
      alreadyOnZulip,
    };
  }

  private async listZulipEmoji() {
    try {
      const emoji = await this.zulip.listEmoji();
      // A deactivated emoji frees its name: Zulip lets a new upload take it.
      return emoji.filter(({ deactivated }) => !deactivated);
    } catch (error) {
      this.logger.error('Could not list the Zulip emoji, skipping the Zulip side of the sync', error);
      return undefined;
    }
  }

  /**
   * Zulip refuses a built-in emoji's name from a member (`Only administrators can override default emoji.`) and
   * takes it from an administrator as a realm-wide replacement of the built-in, so those names are never uploaded.
   */
  private async listZulipBuiltInEmoji() {
    try {
      return zulipBuiltInEmoji(await this.zulip.getEmojiCodes());
    } catch (error) {
      this.logger.error('Could not fetch the Zulip built-in emoji names, skipping the Zulip side of the sync', error);
      return undefined;
    }
  }

  /** A refused key refuses every upload, so it is reported once, by Zulip's reason (never the key), rather than per emote. */
  /** A 401 refuses the rest of the sync's Zulip side; any other failure is the one emote's. */
  private async onZulip<T>(name: string, url: string, work: () => Promise<T>): Promise<T | 'refused' | 'failed'> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ZulipApiError && error.status === 401) {
        this.logger.error(
          `Zulip refused the credentials of the user account that uploads emoji (${error.msg}), so no more emotes are uploaded to Zulip in this sync; check ZULIP_USER_USERNAME and ZULIP_USER_API_KEY`,
        );
        return 'refused';
      }
      this.logger.error(`Could not sync emote ${name} - ${url} to Zulip`, error);
      return 'failed';
    }
  }

  async pruneMessagesInChannel(channel: SendableChannels, userId: string, deleteAfter: DateTime) {
    const messages = await channel.messages.fetch();

    for (const [, message] of messages.filter(({ author }) => author.id === userId)) {
      if (deleteAfter < DateTime.fromJSDate(message.createdAt)) {
        await message.delete();
      }
    }
  }

  async pruneMessages(interaction: CommandInteraction, member: GuildMember, minutes: number) {
    const deleteAfter = DateTime.now().minus({ minutes });
    const channels = interaction
      .guild!.channels.cache.filter((channel) => channel.isSendable())
      .filter((channel) => channel.permissionsFor(member).has('SendMessages'));

    const promises: Promise<void>[] = [];
    for (const [, channel] of channels) {
      promises.push(this.pruneMessagesInChannel(channel, member.id, deleteAfter));
    }

    await Promise.all(promises);
  }

  async handleTaggingOfPullRequestThreads(message: OmitPartialGroupDMChannel<Message<boolean>>) {
    const channel = message.channel;

    if (!channel.isThread() || channel.parentId !== Constants.Discord.Channels.TeamPullRequests) {
      return;
    }

    if (!channel.appliedTags.includes(Constants.Discord.Tags.TeamPulLRequestsDiscussion)) {
      await channel.setAppliedTags([...channel.appliedTags, Constants.Discord.Tags.TeamPulLRequestsDiscussion]);
    }
  }

  async handleFindSimilarIssuesOrDiscussions(messageContent: string, neutraliseTitle = (title: string) => title) {
    const similarIssues = await this.loopDedupe.getForText(messageContent);
    const links = similarIssues.map(({ title: rawTitle, item_type, number, similarity }) => {
      const title = neutraliseTitle(rawTitle);
      const url = `https://github.com/${GithubOrg.ImmichApp}/${GithubRepo.Immich}/${item_type === 'issue' ? 'issues' : 'discussions'}/${number}`;
      const link = makeLink(GithubOrg.ImmichApp, GithubRepo.Immich, number, url);

      if (item_type === 'discussion') {
        return `[Discussion] ${title} (${link}), Similarity: ${similarity.toFixed(3)}`;
      }

      return makeIssueOrPRMessage({ type: 'Issue', link, title }) + `, Similarity: ${similarity.toFixed(3)}`;
    });
    return links.filter((link) => link !== undefined).join('\n');
  }

  private async updateOrder({ id, user, password }: { id: string; user: string; password: string }) {
    // The repository hands back whatever JSON Fourthwall answered, an error body included.
    const order = await this.fourthwall.getOrder({ id, user, password });
    if (!order?.totalPrice || !order.profit || !order.currentAmounts) {
      throw new Error(
        `Fourthwall did not return order ${id}: the ID may be wrong, or Fourthwall refused the request or is down`,
      );
    }

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
