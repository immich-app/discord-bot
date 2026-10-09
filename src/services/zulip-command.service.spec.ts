import { Logger } from '@nestjs/common';
import { Constants } from 'src/constants';
import { neutraliseZulipLabel } from 'src/format';
import { IDatabaseRepository, MirrorIdentityOwner } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IGithubInterface, PullRequestBaseEvent } from 'src/interfaces/github.interface';
import { IGitlabInterface } from 'src/interfaces/gitlab.interface';
import { IRSSInterface } from 'src/interfaces/rss.interface';
import { IZulipInterface, ZulipAccount, ZulipReceivedMessage, ZulipUser } from 'src/interfaces/zulip.interface';
import {
  NewRSSFeed,
  NewScheduledMessage,
  NewZulipExpanderGroup,
  RSSFeed,
  ScheduledMessage,
  UpdateRSSFeed,
  UpdateZulipExpanderGroup,
  ZulipCommandBot,
  ZulipDmExpander,
  ZulipExpander,
  ZulipExpanderGroup,
} from 'src/schema';
import { ChatService, EmoteSyncReport } from 'src/services/chat.service';
import { GithubService } from 'src/services/github.service';
import {
  MirrorBackfillReply,
  MirrorBackfillRequest,
  MirrorLinkReply,
  MirrorLinkRequest,
  MirrorLinkService,
  MirrorPlatform,
  MirrorUnlinkRequest,
} from 'src/services/mirror-link.service';
import { NotificationService } from 'src/services/notification.service';
import { RSSService } from 'src/services/rss.service';
import { ScheduledMessageService } from 'src/services/scheduled-message.service';
import { BackfillPlatforms, BackfillReport, WebhookService } from 'src/services/webhook.service';
import { ZulipCommandService } from 'src/services/zulip-command.service';
import { ZulipExpanderService } from 'src/services/zulip-expander.service';
import { ZulipMessageHandler, ZulipService } from 'src/services/zulip.service';
import { parseCommand, splitArguments, tokenize } from 'src/zulip-command-parser';
import { Mocked, afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

const BOT: ZulipUser = { userId: 7, fullName: 'Immich' };

const ADMIN = { userId: 12, fullName: 'Alice', role: 200 };

const MEMBER = { ...ADMIN, role: 400 };

const newZulipMock = (): Mocked<IZulipInterface> => ({
  init: vitest.fn(),
  isInitialised: vitest.fn(),
  sendMessage: vitest.fn().mockResolvedValue({ id: 1000 }),
  sendDirectMessage: vitest.fn(),
  getMessage: vitest.fn(),
  updateMessage: vitest.fn(),
  createEmote: vitest.fn(),
  replaceCroppedEmote: vitest.fn(),
  listEmoji: vitest.fn(),
  getSubscriptions: vitest.fn(),
  getOwnUser: vitest.fn(),
  getUser: vitest.fn(),
  getUsers: vitest.fn(),
  getStream: vitest.fn(),
  getMessages: vitest.fn().mockResolvedValue([]),
  registerQueue: vitest.fn(),
  getEvents: vitest.fn(),
  deleteQueue: vitest.fn(),
  deleteMessage: vitest.fn(),
  uploadFile: vitest.fn(),
  downloadUpload: vitest.fn(),
  getStreamMessagesBefore: vitest.fn(),
  getMessagesByIds: vitest.fn(),
  getEmojiCodes: vitest.fn(),
  addReaction: vitest.fn(),
  removeReaction: vitest.fn(),
});

const newZulipServiceMock = () => ({
  onMessage: vitest.fn<(handler: ZulipMessageHandler, options?: { withBots?: boolean }) => void>(),
  ownUser: BOT as ZulipUser | undefined,
});

const newChatServiceMock = () => {
  const stickers = new Map<string, string>();
  return {
    stickers,
    syncEmotes: vitest.fn<(guildId: string) => Promise<EmoteSyncReport>>(),
    updateFourthwallOrders: vitest.fn<(id?: string | null) => Promise<void>>().mockResolvedValue(),
    handleFindSimilarIssuesOrDiscussions: vitest.fn<(text: string) => Promise<string>>().mockResolvedValue(''),
    getStickers: () => [...stickers].map(([name, image]) => ({ name, image })),
    setSticker: vitest.fn<(name: string, image: string, createdBy: string) => Promise<boolean>>((name, image) => {
      const replaced = stickers.has(name);
      stickers.set(name, image);
      return Promise.resolve(replaced);
    }),
    removeSticker: (name: string) => Promise.resolve(stickers.delete(name)),
  };
};

const newGithubServiceMock = () => ({
  getOpenPullRequests: vitest.fn<() => Promise<PullRequestBaseEvent[]>>().mockResolvedValue([]),
  getOpenPullRequest: vitest
    .fn<(number: number) => Promise<PullRequestBaseEvent | undefined>>()
    .mockResolvedValue(undefined),
  getRepositoryName: vitest.fn<(fullName: string) => Promise<string | undefined>>().mockResolvedValue(undefined),
});

const newGitlabMock = () => ({
  getProjectPath: vitest.fn<(path: string) => Promise<string | undefined>>().mockResolvedValue(undefined),
  getItem: vitest.fn(),
  getFileContent: vitest.fn(),
  getGroupProjects: vitest.fn(),
});

const newWebhookServiceMock = () => ({
  backfillPullRequests: vitest
    .fn<(pullRequests: PullRequestBaseEvent[], platforms: BackfillPlatforms) => Promise<BackfillReport>>()
    .mockImplementation((pullRequests) => {
      const numbers = pullRequests.map(({ pull_request }) => pull_request.number);
      return Promise.resolve({
        total: pullRequests.length,
        threads: numbers,
        topics: numbers,
        skipped: [],
        failed: [],
      });
    }),
});

const BOTH_PLATFORMS: BackfillPlatforms = { discord: true, zulip: true };

const newMirrorLinkServiceMock = () => ({
  requestLink: vitest.fn<(request: MirrorLinkRequest) => Promise<string>>(),
  unlink: vitest.fn<(request: MirrorUnlinkRequest) => Promise<MirrorLinkReply>>(),
  list: vitest.fn<(platform: MirrorPlatform) => Promise<string>>().mockResolvedValue('No channel is mirrored.'),
  redeemIdentityCode: vitest
    .fn<(sender: { id: number; fullName: string }, code: string) => Promise<string>>()
    .mockResolvedValue('Linked.'),
  unlinkIdentity: vitest
    .fn<(owner: MirrorIdentityOwner, platform: MirrorPlatform) => Promise<string>>()
    .mockResolvedValue('Unlinked.'),
  backfill:
    vitest.fn<
      (request: MirrorBackfillRequest, acknowledge: (ack: string) => Promise<void>) => Promise<MirrorBackfillReply>
    >(),
});

const definedOnly = <T extends object>(values: T) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;

const newFakeDatabase = () => {
  const scheduled: ScheduledMessage[] = [];
  const feeds: RSSFeed[] = [];
  const groups: ZulipExpanderGroup[] = [];
  const expanders: ZulipExpander[] = [];
  const conversations: ZulipDmExpander[] = [];
  const commandBots: ZulipCommandBot[] = [];
  const findFeed = (url: string, channelId: string, service: RSSFeed['service']) =>
    feeds.findIndex((feed) => feed.url === url && feed.channelId === channelId && feed.service === service);
  return {
    scheduled,
    feeds,
    groups,
    expanders,
    conversations,
    commandBots,
    getZulipCommandBots: () => Promise.resolve(commandBots.map((row) => ({ ...row }))),
    addZulipCommandBot: (userId: number, createdBy: string) => {
      if (commandBots.some((row) => row.userId === userId)) {
        return Promise.resolve(undefined);
      }
      const row = { userId, createdBy, createdAt: new Date() };
      commandBots.push(row);
      return Promise.resolve({ ...row });
    },
    removeZulipCommandBot: (userId: number) => {
      const index = commandBots.findIndex((row) => row.userId === userId);
      if (index !== -1) {
        commandBots.splice(index, 1);
      }
      return Promise.resolve(index !== -1);
    },
    getZulipExpanderGroups: () =>
      Promise.resolve(
        groups
          .map((group) => ({ ...group, repositories: [...group.repositories] }))
          .sort((x, y) => x.name.localeCompare(y.name)),
      ),
    getZulipExpanders: () => Promise.resolve(expanders.map((row) => ({ ...row }))),
    createZulipExpanderGroup: ({ name, repositories, createdBy }: NewZulipExpanderGroup) => {
      if (groups.some((group) => group.name === name)) {
        return Promise.resolve(false);
      }
      groups.push({ name, repositories: [...repositories], createdBy, createdAt: new Date() });
      return Promise.resolve(true);
    },
    updateZulipExpanderGroup: (name: string, update: UpdateZulipExpanderGroup) => {
      const group = groups.find((candidate) => candidate.name === name);
      if (group) {
        Object.assign(group, definedOnly(update));
      }
      return Promise.resolve(group !== undefined);
    },
    removeZulipExpanderGroup: (name: string) => {
      const index = groups.findIndex((group) => group.name === name);
      if (index !== -1) {
        groups.splice(index, 1);
        const kept = expanders.filter((row) => row.groupName !== name);
        expanders.splice(0, expanders.length, ...kept);
        const keptDm = conversations.filter((row) => row.groupName !== name);
        conversations.splice(0, conversations.length, ...keptDm);
      }
      return Promise.resolve(index !== -1);
    },
    addZulipExpander: (streamId: number, groupName: string, createdBy: string) => {
      if (expanders.some((row) => row.streamId === streamId && row.groupName === groupName)) {
        return Promise.resolve(false);
      }
      expanders.push({ streamId, groupName, createdBy, createdAt: new Date() });
      return Promise.resolve(true);
    },
    removeZulipExpander: (streamId: number, groupName?: string) => {
      const matches = (row: ZulipExpander) =>
        row.streamId === streamId && (groupName === undefined || row.groupName === groupName);
      const removed = expanders.filter((row) => matches(row)).map((row) => row.groupName);
      const kept = expanders.filter((row) => !matches(row));
      expanders.splice(0, expanders.length, ...kept);
      return Promise.resolve(removed);
    },
    getZulipDmExpanders: () => Promise.resolve(conversations.map((row) => ({ ...row }))),
    addZulipDmExpander: (conversation: string, groupName: string, createdBy: string) => {
      if (conversations.some((row) => row.conversation === conversation && row.groupName === groupName)) {
        return Promise.resolve(false);
      }
      conversations.push({ conversation, groupName, createdBy, createdAt: new Date() });
      return Promise.resolve(true);
    },
    removeZulipDmExpander: (conversation: string, groupName?: string) => {
      const matches = (row: ZulipDmExpander) =>
        row.conversation === conversation && (groupName === undefined || row.groupName === groupName);
      const removed = conversations.filter((row) => matches(row)).map((row) => row.groupName);
      const kept = conversations.filter((row) => !matches(row));
      conversations.splice(0, conversations.length, ...kept);
      return Promise.resolve(removed);
    },
    getScheduledMessages: (service?: ScheduledMessage['service']) =>
      Promise.resolve(scheduled.filter((row) => service === undefined || row.service === service)),
    getScheduledMessage: (name: string, service: ScheduledMessage['service']) =>
      Promise.resolve(scheduled.find((row) => row.name === name && row.service === service)),
    createScheduledMessage: (entity: NewScheduledMessage) => {
      if (scheduled.some(({ name }) => name === entity.name)) {
        return Promise.reject(new Error('duplicate key value violates unique constraint "scheduled_message_name_uq"'));
      }
      const row: ScheduledMessage = {
        id: `id-${scheduled.length + 1}`,
        suppressEmbeds: true,
        createdAt: new Date(),
        topic: null,
        ...entity,
      } as ScheduledMessage;
      scheduled.push(row);
      return Promise.resolve({ ...row });
    },
    updateScheduledMessage: ({ name, ...changes }: Partial<ScheduledMessage> & { name: string }) => {
      const row = scheduled.find((candidate) => candidate.name === name);
      return Promise.resolve(row && { ...Object.assign(row, definedOnly(changes)) });
    },
    removeScheduledMessage: (id: string) => {
      scheduled.splice(
        scheduled.findIndex((row) => row.id === id),
        1,
      );
      return Promise.resolve();
    },
    createRSSFeed: (entity: NewRSSFeed) => {
      if (findFeed(entity.url, entity.channelId, entity.service ?? 'discord') !== -1) {
        return Promise.reject(new Error('duplicate key value violates unique constraint "rss_feed_pkey"'));
      }
      feeds.push({ service: 'discord', topic: null, lastId: null, title: null, profileImageUrl: null, ...entity });
      return Promise.resolve();
    },
    getRSSFeeds: (channel?: Pick<RSSFeed, 'channelId' | 'service'>) =>
      Promise.resolve(
        channel
          ? feeds.filter((feed) => feed.channelId === channel.channelId && feed.service === channel.service)
          : feeds,
      ),
    removeRSSFeed: (url: string, channelId: string, service: RSSFeed['service']) => {
      const index = findFeed(url, channelId, service);
      if (index !== -1) {
        feeds.splice(index, 1);
      }
      return Promise.resolve(index !== -1);
    },
    updateRSSFeed: ({ url, channelId, service, ...changes }: UpdateRSSFeed) => {
      const feed = feeds[findFeed(url, channelId, service)];
      if (feed) {
        Object.assign(feed, definedOnly(changes));
      }
      return Promise.resolve();
    },
  };
};

const message = (overrides: Partial<ZulipReceivedMessage> = {}): ZulipReceivedMessage => ({
  id: 500,
  senderId: 12,
  senderEmail: 'alice@example.com',
  senderFullName: 'Alice',
  type: 'stream',
  streamId: Constants.Zulip.TeamStreams.ImmichGeneral,
  topic: 'deploy',
  content: '@**Immich** help',
  timestamp: 1_700_000_000,
  ...overrides,
});

const pullRequest = (number: number): PullRequestBaseEvent => ({
  repository: { full_name: 'immich-app/immich' },
  sender: { type: 'User' },
  pull_request: {
    number,
    id: number,
    node_id: `PR_node_${number}`,
    title: `PR ${number}`,
    body: '',
    html_url: `https://github.com/immich-app/immich/pull/${number}`,
  },
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const SERVER = 'the Immich Discord server (979116623879368755)';

const HELP_FINE_PRINT = [
  '```spoiler How it works',
  '- Mention me at the very start of a message; a mention anywhere else is not a command.',
  '- Arguments are positional or `key=value`; quote a value with spaces: `text="two words"`.',
  '- Every reply is posted here, in this topic, for everyone in the stream to see.',
  '- Scheduled messages, RSS feeds and `expanders` act on this stream alone; expander groups are shared by every stream.',
  '- The team tools are taken in the Immich team streams only, the `mirror-*` and `command-bots` commands from organization administrators and owners only.',
  '```',
].join('\n');

const HELP = [
  '**Immich**: mention me, then a command. `help <command>` explains one.',
  '',
  '**Issues and links**',
  '- `expanders`: choose the groups of repositories a bare `#1234` looks in, in this stream',
  '- `expander-group`: create and change the groups of repositories `expanders` turns on',
  '- `similar`: find immich-app/immich issues and discussions like a message',
  '',
  '**Scheduled messages**',
  '- `schedule-add`, `schedule-list`, `schedule-edit`, `schedule-remove`: post messages in this stream on a cron schedule',
  '',
  '**RSS**',
  '- `rss-subscribe`, `rss-unsubscribe`, `rss-list`: post RSS feeds in this stream',
  '',
  '**Discord mirror**',
  '- `mirror-link`, `mirror-unlink`: mirror this stream with a Discord channel, both ways, or stop',
  '- `mirror-backfill`: copy the Discord history of the channel or thread this topic mirrors',
  '- `mirror-list`: list the mirrored channels and the linked accounts',
  '- `discord-unlink`: unlink your Zulip and Discord accounts; `/zulip-link` on Discord links them',
  '',
  '**Team tools**',
  '- `emote-sync`: upload the emotes of the Immich Discord server to Zulip',
  '- `backfill-pull-requests`: create the Discord thread and the Zulip topic a pull request lacks',
  '- `fourthwall`: fetch a Fourthwall order again, or every order',
  '- `sticker-add`, `sticker-remove`, `sticker-list`: answer an emoji with an image, in every stream',
  '',
  '**Other bots**',
  '- `command-bots`: choose the other bots whose commands I take',
  '',
  HELP_FINE_PRINT,
].join('\n');

const HELP_FOR_EVERYONE = [
  '**Immich**: mention me, then a command. `help <command>` explains one.',
  '',
  '**Issues and links**',
  '- `expanders`: choose the groups of repositories a bare `#1234` looks in, in this stream',
  '- `expander-group`: create and change the groups of repositories `expanders` turns on',
  '- `similar`: find immich-app/immich issues and discussions like a message',
  '',
  '**Scheduled messages**',
  '- `schedule-add`, `schedule-list`, `schedule-edit`, `schedule-remove`: post messages in this stream on a cron schedule',
  '',
  '**RSS**',
  '- `rss-subscribe`, `rss-unsubscribe`, `rss-list`: post RSS feeds in this stream',
  '',
  '**Discord mirror**',
  '- `discord-unlink`: unlink your Zulip and Discord accounts; `/zulip-link` on Discord links them',
  '',
  '*Left out here: the commands taken in the Immich team streams only and the commands for organization administrators and owners.*',
  '',
  HELP_FINE_PRINT,
].join('\n');

const bareNumbers = (kind: string) =>
  `A bare \`#1234\` goes to the repository of the ${kind}'s groups whose pull request, issue or discussion of that number I have seen activity on last, which only a GitHub repository of \`immich-app\` or \`futo-org\` can be; a GitLab project or another repository needs \`name#1234\` or a link.`;

const BARE_NUMBERS = bareNumbers('stream');

const PREFIXES =
  '`!1234` asks for a pull request (a merge request on GitLab) and `^1234` for an issue, bare or after a name (`immich!1234`), where `#1234` takes any kind; `owner/name!1234` and `owner/name^1234` outside the groups work for `immich-app` or `futo-org` only.';

const DIRECT_MESSAGE_HELP = [
  '**In a direct message**, send me one of these; in a group conversation, mention me first.',
  '',
  '**Issues and links**',
  '- `expanders`: choose the groups of repositories a bare `#1234` looks in, in this conversation',
  '',
  '**Discord mirror**',
  '- `link <code>`: link your Zulip account with the Discord account `/zulip-link` gave you the code on',
  '- `unlink`: unlink your Zulip account from your Discord account',
  '',
  '```spoiler How it works',
  '- `expanders on <group>`, `expanders off [group]` and `expanders list` work as in a stream; `expander-group list`, in a stream, lists the groups.',
  `- ${bareNumbers('conversation')}`,
  `- ${PREFIXES}`,
  '- Links expand here without a group, unless a guest is in the conversation.',
  '- Everyone in the conversation sees what `expanders` changes; anything else is answered to you alone.',
  '```',
].join('\n');

describe('tokenize', () => {
  it.each([
    { text: '', expected: [] },
    { text: '   ', expected: [] },
    { text: 'update 123', expected: ['update', '123'] },
    { text: '  update\n123 ', expected: ['update', '123'] },
    { text: 'text="two words"', expected: ['text=two words'] },
    { text: '"two words" three', expected: ['two words', 'three'] },
    { text: 'text=“curly quotes”', expected: ['text=curly quotes'] },
    { text: 'a""b', expected: ['ab'] },
    { text: 'text=""', expected: ['text='] },
    { text: '""', expected: [''] },
  ])('should split $text into $expected', ({ text, expected }) => {
    expect(tokenize(text)).toEqual(expected);
  });

  it('should refuse a quote that is never closed', () => {
    expect(tokenize('text="two words')).toBeUndefined();
  });
});

describe('parseCommand', () => {
  it.each([
    '@**Immich** help',
    '@_**Immich** help',
    '@**Immich|7** help',
    '@_**Immich|7** help',
    '\n\n@**Immich**\nhelp',
  ])('should read the command after the mention in %j', (content) => {
    expect(parseCommand(content, 'Immich')).toEqual({ status: 'ok', command: { name: 'help', tokens: [] } });
  });

  it('should match the name whatever its case', () => {
    expect(parseCommand('@**immich** HELP', 'Immich')).toEqual({ status: 'ok', command: { name: 'help', tokens: [] } });
  });

  it('should match a name that holds regex characters', () => {
    expect(parseCommand('@**Immich (bot)** help', 'Immich (bot)')).toMatchObject({ status: 'ok' });
    expect(parseCommand('@**Immich bot** help', 'Immich (bot)')).toEqual({ status: 'ignored' });
  });

  it('should keep every token after the command, quoted or not, in order and lowercase nothing but the name', () => {
    expect(parseCommand('@**Immich** Fourthwall update 123 text="two words" Note=x', 'Immich')).toEqual({
      status: 'ok',
      command: { name: 'fourthwall', tokens: ['update', '123', 'text=two words', 'Note=x'] },
    });
  });

  it('should read a mention alone as the empty command', () => {
    expect(parseCommand('@**Immich**', 'Immich')).toEqual({ status: 'ok', command: { name: '', tokens: [] } });
  });

  it('should call a quote that is never closed malformed', () => {
    expect(parseCommand('@**Immich** similar text="two words', 'Immich')).toEqual({
      status: 'malformed',
      reason: 'a quote is opened and never closed',
    });
  });

  it.each([
    'help',
    'thanks @**Immich**',
    'hey @**Immich** help',
    '@**Alice** help',
    '@**Immich Bot** help',
    '@**all** help',
    'Immich help',
  ])('should ignore %j, which does not start with a mention of the bot', (content) => {
    expect(parseCommand(content, 'Immich')).toEqual({ status: 'ignored' });
  });

  it.each([
    '    @**Immich** emote-sync',
    '\t@**Immich** emote-sync',
    '\n    @**Immich** emote-sync',
    ' @**Immich** emote-sync',
    '```\n@**Immich** emote-sync\n```',
    '~~~quote\n@**Immich** emote-sync\n~~~',
    '> @**Immich** emote-sync',
    '`@**Immich** emote-sync`',
  ])('should ignore %j, where the mention is in a code block, a quote, or behind whitespace', (content) => {
    expect(parseCommand(content, 'Immich')).toEqual({ status: 'ignored' });
  });

  it.each([
    '@_**Immich** [said](https://zulip.example.com/#narrow/stream/107/topic/deploy/near/500):\n```quote\nDone syncing\n```\nlooks good',
    '@_**Immich|7** [said](https://zulip.example.com/#narrow/stream/107/topic/deploy/near/500):\n```quote\nDone syncing\n```\nsimilar',
    '@**Immich** [said](https://zulip.example.com/#narrow/stream/107/topic/deploy/near/500):\n```quote\nDone syncing\n```',
  ])('should ignore %j, a "Quote and reply" of a message of the bot', (content) => {
    expect(parseCommand(content, 'Immich')).toEqual({ status: 'ignored' });
  });

  it('should match no message when the bot has no name', () => {
    expect(parseCommand('@**** help', '')).toEqual({ status: 'ignored' });
  });
});

describe('splitArguments', () => {
  it('should read the key=value tokens the command declares as options, lowercasing the key', () => {
    expect(splitArguments(['update', '123', 'text=two words', 'Note=x'], ['text', 'note'])).toEqual({
      args: ['update', '123'],
      options: { text: 'two words', note: 'x' },
    });
  });

  it('should keep a key=value token the command does not declare as a positional argument, in its place', () => {
    expect(splitArguments(['the', 'upload', 'fails', 'when', 'CORS=strict', 'on', 'nginx'], ['text'])).toEqual({
      args: ['the', 'upload', 'fails', 'when', 'CORS=strict', 'on', 'nginx'],
      options: {},
    });
    expect(splitArguments(['pr=1234'], ['number'])).toEqual({ args: ['pr=1234'], options: {} });
  });

  it('should keep a token that is not a word before its = as a positional argument', () => {
    expect(splitArguments(['#1234=5', '=x'], ['text'])).toEqual({ args: ['#1234=5', '=x'], options: {} });
  });

  it('should take the last value of an option given twice', () => {
    expect(splitArguments(['text=a', 'TEXT=b'], ['text'])).toEqual({ args: [], options: { text: 'b' } });
  });
});

describe('ZulipCommandService', () => {
  let sut: ZulipCommandService;
  let zulipMock: Mocked<IZulipInterface>;
  let zulipServiceMock: ReturnType<typeof newZulipServiceMock>;
  let chatServiceMock: ReturnType<typeof newChatServiceMock>;
  let githubServiceMock: ReturnType<typeof newGithubServiceMock>;
  let gitlabMock: ReturnType<typeof newGitlabMock>;
  let githubMock: { getOwnerRepositories: ReturnType<typeof vitest.fn> };
  let webhookServiceMock: ReturnType<typeof newWebhookServiceMock>;
  let database: ReturnType<typeof newFakeDatabase>;
  let discordMock: Mocked<Pick<IDiscordInterface, 'sendMessage'>>;
  let rssMock: Mocked<IRSSInterface>;
  let mirrorLinksMock: ReturnType<typeof newMirrorLinkServiceMock>;
  let zulipExpanders: ZulipExpanderService;

  const fromClaude = { senderId: 30, senderEmail: 'claude-bot@zulip.example.com', senderFullName: 'Claude' };
  const replies = () => zulipMock.sendMessage.mock.calls.map(([payload]) => payload);
  const send = (content: string, overrides: Partial<ZulipReceivedMessage> = {}) =>
    sut.onZulipMessage(message({ content, ...overrides }));

  beforeEach(() => {
    vitest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    zulipMock = newZulipMock();
    zulipServiceMock = newZulipServiceMock();
    chatServiceMock = newChatServiceMock();
    githubServiceMock = newGithubServiceMock();
    gitlabMock = newGitlabMock();
    githubMock = { getOwnerRepositories: vitest.fn() };
    webhookServiceMock = newWebhookServiceMock();
    database = newFakeDatabase();
    discordMock = { sendMessage: vitest.fn() };
    rssMock = { getFeed: vitest.fn() };
    mirrorLinksMock = newMirrorLinkServiceMock();
    const discord = discordMock as unknown as IDiscordInterface;
    const db = database as unknown as IDatabaseRepository;
    zulipExpanders = new ZulipExpanderService(
      db,
      githubMock as unknown as IGithubInterface,
      gitlabMock as unknown as IGitlabInterface,
    );
    sut = new ZulipCommandService(
      zulipMock,
      gitlabMock as unknown as IGitlabInterface,
      db,
      zulipServiceMock as unknown as ZulipService,
      chatServiceMock as unknown as ChatService,
      githubServiceMock as unknown as GithubService,
      webhookServiceMock as unknown as WebhookService,
      new ScheduledMessageService(db, discord, zulipMock),
      new RSSService(db, new NotificationService(discord, zulipMock), rssMock),
      mirrorLinksMock as unknown as MirrorLinkService,
      zulipExpanders,
    );
  });

  afterEach(() => {
    vitest.restoreAllMocks();
  });

  describe('init', () => {
    it('should subscribe one handler to the event loop, which answers the listed bots too', async () => {
      database.commandBots.push({ userId: 30, createdBy: 'Alice on Zulip (user 12)', createdAt: new Date() });

      await sut.init();

      expect(zulipServiceMock.onMessage).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { withBots: true });
      const [handler] = zulipServiceMock.onMessage.mock.calls[0];
      await handler(message({ ...fromClaude, content: '@**Immich** rss-list', streamId: 999 }));
      expect(replies()).toEqual([
        { stream: 999, topic: 'deploy', content: 'This stream is not subscribed to any RSS feed.' },
      ]);
    });
  });

  describe('bots', () => {
    const fromCi = { senderId: 31, senderEmail: 'ci-bot@zulip.example.com', senderFullName: 'CI' };

    beforeEach(async () => {
      database.commandBots.push({ userId: 30, createdBy: 'Alice on Zulip (user 12)', createdAt: new Date() });
      await sut.init();
    });

    it("should answer a listed bot's command", async () => {
      await send('@**Immich** rss-list', { ...fromClaude, streamId: 999 });

      expect(replies()).toEqual([
        { stream: 999, topic: 'deploy', content: 'This stream is not subscribed to any RSS feed.' },
      ]);
    });

    it.each(['@**Immich** rss-list', '@**Immich** help', '@**Immich** nonsense'])(
      'should ignore %j from a bot that is not listed, without a word',
      async (content) => {
        await send(content, { ...fromCi, streamId: 999 });

        expect(zulipMock.sendMessage).not.toHaveBeenCalled();
        expect(zulipMock.getUser).not.toHaveBeenCalled();
      },
    );

    it("should ignore the Notification Bot's notice that the bot resolved a topic", async () => {
      await send('@_**Immich|7** has marked this topic as resolved.', {
        senderId: 5,
        senderEmail: 'notification-bot@zulip.com',
        senderFullName: 'Notification Bot',
        streamId: Constants.Zulip.Streams.ImmichPullRequests,
      });

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should ignore a command sent through the email gateway, which cannot be listed', async () => {
      await send('@**Immich** rss-list', {
        senderId: 6,
        senderEmail: 'emailgateway@zulip.com',
        senderFullName: 'Email Gateway',
        streamId: 999,
      });

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it.each(['see #4242', 'Unknown command `nonsense`. Mention me with `help` for the list.', '@**Claude** help'])(
      'should say nothing to a listed bot message that is not a command: %j',
      async (content) => {
        await send(content, fromClaude);

        expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      },
    );

    it("should ignore a listed bot's direct message", async () => {
      await send('link ABCD2345', { ...fromClaude, type: 'private', streamId: undefined, topic: '' });

      expect(mirrorLinksMock.redeemIdentityCode).not.toHaveBeenCalled();
      expect(zulipMock.sendDirectMessage).not.toHaveBeenCalled();
    });

    it("should check a listed bot's role as any sender's for the administrators' commands", async () => {
      zulipMock.getUser.mockResolvedValue({ userId: 30, fullName: 'Claude', role: 400 });

      await send('@**Immich** mirror-list', { ...fromClaude, streamId: 120 });

      expect(zulipMock.getUser).toHaveBeenCalledExactlyOnceWith(30);
      expect(mirrorLinksMock.list).not.toHaveBeenCalled();
      expect(replies().map(({ content }) => content)).toEqual([
        'Only Zulip organization administrators and owners can change or list the Discord-Zulip mirror.',
      ]);
    });

    it('should refuse a team command from a listed bot outside the team streams', async () => {
      await send('@**Immich** emote-sync', { ...fromClaude, streamId: 999 });

      expect(chatServiceMock.syncEmotes).not.toHaveBeenCalled();
      expect(replies().map(({ content }) => content)).toEqual([
        '`emote-sync` is taken in the Immich team streams only.',
      ]);
    });
  });

  describe('gating', () => {
    it('should take commands in every immich team stream', () => {
      expect(Constants.Zulip.Commands).toEqual([107, 108, 109, 110, 111, 112, 113]);
    });

    it('should refuse a team command outside the team streams, saying so', async () => {
      await send('@**Immich** emote-sync', { streamId: Constants.Zulip.Streams.Immich });
      await send('@**Immich** backfill-pull-requests 1234', { streamId: 999 });
      await send('@**Immich** fourthwall update all', { streamId: 999 });

      expect(replies().map(({ content }) => content)).toEqual([
        '`emote-sync` is taken in the Immich team streams only.',
        '`backfill-pull-requests` is taken in the Immich team streams only.',
        '`fourthwall` is taken in the Immich team streams only.',
      ]);
      expect(chatServiceMock.syncEmotes).not.toHaveBeenCalled();
      expect(chatServiceMock.updateFourthwallOrders).not.toHaveBeenCalled();
    });

    it('should take every other command in any stream, and answer an unknown one', async () => {
      await send('@**Immich** similar text="hello"', { streamId: 999 });
      await send('@**Immich** rss-list', { streamId: 999 });
      await send('@**Immich** nonsense', { streamId: 999 });

      expect(chatServiceMock.handleFindSimilarIssuesOrDiscussions).toHaveBeenCalledOnce();
      expect(replies().map(({ stream, content }) => [stream, content])).toEqual([
        [999, 'Nothing similar to `hello` was found.'],
        [999, 'This stream is not subscribed to any RSS feed.'],
        [999, 'Unknown command `nonsense`. Mention me with `help` for the list.'],
      ]);
    });

    it('should answer help and a bare mention in any stream, with the commands taken there', async () => {
      zulipMock.getUser.mockResolvedValue(MEMBER);

      await send('@**Immich** help', { streamId: Constants.Zulip.Streams.Immich });
      await send('@**Immich**', { streamId: 999 });

      expect(replies().map(({ stream, content }) => ({ stream, content }))).toEqual([
        { stream: Constants.Zulip.Streams.Immich, content: HELP_FOR_EVERYONE },
        { stream: 999, content: HELP_FOR_EVERYONE },
      ]);
    });

    it('should ignore a direct message, without a reply', async () => {
      await send('@**Immich** help', { type: 'private', streamId: undefined });

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should ignore a message that does not start with a mention of the bot', async () => {
      await send('help');
      await send('thanks @**Immich**');
      await send('@**Alice** help');

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should take no command, and warn once, when the bot has no name', async () => {
      zulipServiceMock.ownUser = { userId: 7, fullName: '' };

      await send('@**Immich** help');
      await send('@**** help');

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).toHaveBeenCalledExactlyOnceWith(
        'Zulip reported no name for the bot, so no message can mention it: commands are off',
      );
    });

    it('should take no command before the loop has read the bot account', async () => {
      zulipServiceMock.ownUser = undefined;

      await send('@**Immich** help');

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('replies', () => {
    it('should answer in the same stream and topic', async () => {
      zulipMock.getUser.mockResolvedValue(ADMIN);

      await send('@**Immich** help', { streamId: 109, topic: 'ios build' });

      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({ stream: 109, topic: 'ios build', content: HELP });
    });

    it('should answer in the empty topic when the command was given there', async () => {
      zulipMock.getUser.mockResolvedValue(ADMIN);

      await send('@**Immich** help', { topic: '' });

      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({ stream: 107, topic: '', content: HELP });
    });

    it("should cut every reply to Zulip's message limit, whatever built it", async () => {
      chatServiceMock.handleFindSimilarIssuesOrDiscussions.mockResolvedValue('x'.repeat(50_000));

      await send('@**Immich** similar text="hello"');

      const [content] = replies().map(({ content }) => content);
      expect(content).toMatch(/^Similar to `hello`:\nx+\.\.\.$/);
      expect(content).toHaveLength(10_000);
    });

    it('should close an inline-code span the cut fell inside, within the limit', async () => {
      chatServiceMock.handleFindSimilarIssuesOrDiscussions.mockResolvedValue(`\`${'y'.repeat(50_000)}\``);

      await send('@**Immich** similar text="hello"');

      const [content] = replies().map(({ content }) => content);
      expect(content).toMatch(/^Similar to `hello`:\n`y+\.\.\.`$/);
      expect(content).toHaveLength(10_000);
    });

    it('should not add a backtick when the shorter cut drops the one that opened the span', async () => {
      const prefix = 'Similar to `hello`:\n';
      chatServiceMock.handleFindSimilarIssuesOrDiscussions.mockResolvedValue(
        `${'x'.repeat(9996 - prefix.length)}\`${'y'.repeat(50_000)}`,
      );

      await send('@**Immich** similar text="hello"');

      const [content] = replies().map(({ content }) => content);
      expect(content).toMatch(/^Similar to `hello`:\nx+\.\.\.$/);
      expect(content).toHaveLength(9999);
    });

    it('should leave a reply within the limit as it is, backticks included', async () => {
      chatServiceMock.handleFindSimilarIssuesOrDiscussions.mockResolvedValue(
        '[Issue] a `lone backtick (x), Similarity: 0.5',
      );

      await send('@**Immich** similar text="hello"');

      expect(replies()[0].content).toBe('Similar to `hello`:\n[Issue] a `lone backtick (x), Similarity: 0.5');
    });

    it('should log a reply that cannot be posted and resolve all the same', async () => {
      zulipMock.sendMessage.mockRejectedValue(new Error('fetch failed'));

      await expect(send('@**Immich** help')).resolves.toBeUndefined();

      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        'Could not reply to the Zulip command in message 500',
        expect.any(Error),
      );
    });
  });

  describe('help', () => {
    const COMMANDS = [
      'help',
      'emote-sync',
      'backfill-pull-requests',
      'fourthwall',
      'schedule-add',
      'schedule-list',
      'schedule-edit',
      'schedule-remove',
      'rss-subscribe',
      'rss-unsubscribe',
      'rss-list',
      'mirror-link',
      'mirror-unlink',
      'mirror-backfill',
      'mirror-list',
      'expanders',
      'expander-group',
      'discord-unlink',
      'similar',
      'command-bots',
    ];
    const SCHEDULE_ADD = [
      '`schedule-add <name> cron=<expression> message=<text> [topic=<topic>] [suppress-embeds=<true|false>]`',
      'Post the message in this stream on that cron schedule, in the topic given or this one; `suppress-embeds` is accepted and ignored: Zulip cannot turn off link previews for one message.',
      '- Taken in any stream.',
      '- Options: `name=`, `cron=`, `message=`, `topic=`, `suppress-embeds=`',
      '- Example: `schedule-add standup cron="0 9 * * 1-5" message="Standup in five minutes" topic=standup`',
    ].join('\n');
    const contents = () => replies().map(({ content }) => content);
    const lines = (content: string) => content.split('\n');

    beforeEach(() => {
      zulipMock.getUser.mockResolvedValue(ADMIN);
    });

    it('should list the commands under their sections for an administrator in a team stream', async () => {
      await send('@**Immich** help');

      expect(replies()).toEqual([{ stream: 107, topic: 'deploy', content: HELP }]);
      expect(zulipMock.getUser).toHaveBeenCalledExactlyOnceWith(12);
    });

    it.each(['@**Immich**', '@**Immich** help ""'])('should answer %j with the list too', async (content) => {
      await send(content);

      expect(contents()).toEqual([HELP]);
    });

    it('should name the bot by its Zulip name, which is not hard-coded', async () => {
      zulipServiceMock.ownUser = { userId: 7, fullName: 'FUBot' };

      await send('@**FUBot** help');

      expect(contents()[0]).toMatch(/^\*\*FUBot\*\*: mention me, then a command\./);
    });

    it('should list only what a member can run outside the team streams, and say what is left out', async () => {
      zulipMock.getUser.mockResolvedValue(MEMBER);

      await send('@**Immich** help', { streamId: 999 });

      expect(contents()).toEqual([HELP_FOR_EVERYONE]);
    });

    it('should leave the team tools out for an administrator outside the team streams', async () => {
      await send('@**Immich** help', { streamId: 999 });

      const [content] = contents();
      expect(content).not.toContain('**Team tools**');
      expect(content).toContain('- `mirror-link`, `mirror-unlink`:');
      expect(lines(content)).toContain('*Left out here: the commands taken in the Immich team streams only.*');
    });

    it("should leave the administrators' commands out for a member in a team stream", async () => {
      zulipMock.getUser.mockResolvedValue(MEMBER);

      await send('@**Immich** help');

      const [content] = contents();
      expect(content).toContain('**Team tools**');
      expect(content).not.toContain('**Other bots**');
      expect(lines(content).filter((line) => line.startsWith('- `mirror-'))).toEqual([]);
      expect(lines(content)).toContain('*Left out here: the commands for organization administrators and owners.*');
    });

    it("should answer with a member's list, and log it at debug, when the sender's role cannot be read", async () => {
      zulipMock.getUser.mockResolvedValue(MEMBER);
      await send('@**Immich** help');
      const error = new Error('Zulip is down');
      zulipMock.getUser.mockRejectedValue(error);

      await send('@**Immich** help');

      const [member, unread] = contents();
      expect(unread).toBe(member);
      expect(lines(unread)).toContain('*Left out here: the commands for organization administrators and owners.*');
      expect(Logger.prototype.debug).toHaveBeenCalledExactlyOnceWith(
        'Could not read the role of Zulip user 12 for help',
        error,
      );
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it('should explain one command, without reading any role', async () => {
      await send('@**Immich** help schedule-add');

      expect(contents()).toEqual([SCHEDULE_ADD]);
      expect(zulipMock.getUser).not.toHaveBeenCalled();
    });

    it('should explain a command whatever its case', async () => {
      await send('@**Immich** help SCHEDULE-ADD');

      expect(contents()).toEqual([SCHEDULE_ADD]);
    });

    it("should explain an administrators' command to anyone, saying who it is taken from", async () => {
      zulipMock.getUser.mockResolvedValue(MEMBER);

      await send('@**Immich** help mirror-list');

      expect(contents()).toEqual([
        [
          '`mirror-list`',
          'List the mirrored channels and streams, and the linked accounts.',
          '- Taken in any stream, from organization administrators and owners only.',
        ].join('\n'),
      ]);
      expect(zulipMock.getUser).not.toHaveBeenCalled();
    });

    it('should explain each form of command-bots, saying who it is taken from', async () => {
      zulipMock.getUser.mockResolvedValue(MEMBER);

      await send('@**Immich** help command-bots');

      expect(contents()).toEqual([
        [
          '`command-bots <add|remove> <bot> | list`',
          "Choose the other bots whose commands I take, in every stream, with their role checked as anyone's; every other bot's are ignored, and people's are always taken. A bot is named by its mention, its email, its name or its user ID.",
          '- `add <bot>`: take the commands of that bot',
          '- `remove <bot>`: stop taking the commands of that bot',
          '- `list`: list the bots whose commands I take',
          '- Taken in any stream, from organization administrators and owners only.',
          '- Example: `command-bots add Claude`',
        ].join('\n'),
      ]);
    });

    it('should explain a team command outside the team streams instead of refusing it', async () => {
      await send('@**Immich** help emote-sync', { streamId: 999 });

      expect(contents()).toEqual([
        [
          '`emote-sync`',
          `Upload every emote of ${SERVER} to Zulip, skipping a name Zulip already has.`,
          '- Taken in the Immich team streams only.',
        ].join('\n'),
      ]);
    });

    it('should explain each form of a command that has several on a line of its own, with no host turned into a link', async () => {
      await send('@**Immich** help expanders');

      expect(contents()).toEqual([
        [
          '`expanders <on <group>|off [group]|list>`',
          `Choose the groups of repositories a bare \`#1234\` and \`name#1234\` look among in this stream. ${BARE_NUMBERS} ${PREFIXES} GitHub and \`gitlab.futo.org\` issue, pull request, merge request and discussion links, file permalinks and \`owner/name#1234\` expand in every subscribed stream, with or without a group, and \`x.com\` links are mirrored on \`nitter.net\`.`,
          '- `on <group>`: turn that group on here',
          '- `off [group]`: turn that group off here, or every group when none is named',
          '- `list`: list the streams with groups',
          '- Taken in any stream.',
          '- Example: `expanders on immich`',
        ].join('\n'),
      ]);
    });

    it('should say which repositories a bare number reaches in the expander groups help too', async () => {
      await send('@**Immich** help expander-group');

      expect(lines(contents()[0]).slice(0, 2)).toEqual([
        '`expander-group <create|add|remove> <group> <repository>… | delete <group> | info <group> | list`',
        'Create and change the groups of repositories `expanders on` turns on. A repository is `owner/repo` on GitHub or `gitlab.futo.org/namespace/project`, or `owner/*` or `gitlab.futo.org/namespace/*` for every repository of that owner or group, kept up to date; URLs work too. ' +
          BARE_NUMBERS,
      ]);
      expect(contents()[0]).not.toMatch(/threshold|default/);
    });

    it.each([
      ['backfill-pull-requests', '- Example: `backfill-pull-requests 1234`'],
      ['fourthwall', '- Example: `fourthwall update ORD-1`'],
    ])('should offer the narrow form of %s to copy, never the wide one', async (name, example) => {
      await send(`@**Immich** help ${name}`);

      expect(lines(contents()[0]).at(-1)).toBe(example);
    });

    it.each([
      ['nonsense', '`nonsense`'],
      ['constructor', '`constructor`'],
      ['__proto__', '`__proto__`'],
      ['@**all**', '`@\u200B**all**`'],
    ])('should answer help %j with no such command, mentioning nobody', async (given, echo) => {
      await send(`@**Immich** help ${given}`);

      expect(contents()).toEqual([`There is no command ${echo}; \`help\` lists them.`]);
    });

    it('should echo a name it does not know shortened', async () => {
      await send(`@**Immich** help ${'y'.repeat(9000)}`);

      expect(contents()).toEqual([`There is no command \`${'y'.repeat(77)}...\`; \`help\` lists them.`]);
    });

    it.each(COMMANDS)('should explain %s whole', async (name) => {
      await send(`@**Immich** help ${name}`);

      const [content] = contents();
      expect(content.startsWith(`\`${name}`)).toBe(true);
      expect(lines(content)[1]).toMatch(/\.$/);
    });

    it('should answer an unknown command with a pointer to help, mentioning nobody', async () => {
      await send('@**Immich** deploy @**all**');
      await send('@**Immich** @**all**');

      expect(replies().map(({ content }) => content)).toEqual([
        'Unknown command `deploy`. Mention me with `help` for the list.',
        'Unknown command `@\u200B**all**`. Mention me with `help` for the list.',
      ]);
    });

    it('should echo an unknown command shortened, as it echoes the text `similar` compared', async () => {
      await send(`@**Immich** ${'y'.repeat(9000)}`);

      expect(replies().map(({ content }) => content)).toEqual([
        `Unknown command \`${'y'.repeat(77)}...\`. Mention me with \`help\` for the list.`,
      ]);
    });

    it('should answer a command it cannot parse with what went wrong', async () => {
      await send('@**Immich** similar text="two words');

      expect(replies().map(({ content }) => content)).toEqual([
        'Could not read that: a quote is opened and never closed. Mention me with `help` for the commands.',
      ]);
    });

    it.each([
      ['@**Immich** help me please', 'Usage: `help [command]`'],
      ['@**Immich** emote-sync server=foo', 'Usage: `emote-sync`'],
      ['@**Immich** emote-sync now', 'Usage: `emote-sync`'],
      ['@**Immich** backfill-pull-requests 1 2', 'Usage: `backfill-pull-requests <number|all>`'],
      ['@**Immich** backfill-pull-requests pr=1234', 'Usage: `backfill-pull-requests <number|all>`'],
      ['@**Immich** backfill-pull-requests', 'Usage: `backfill-pull-requests <number|all>`'],
      ['@**Immich** fourthwall update ORD-1 order=ORD-2', 'Usage: `fourthwall update <id|all>`'],
      ['@**Immich** fourthwall update', 'Usage: `fourthwall update <id|all>`'],
      ['@**Immich** similar text="a" and more', 'Usage: `similar [text]`'],
    ])(
      'should answer %j, an argument the command does not take, with its usage and run nothing',
      async (content, usage) => {
        await send(content);

        expect(chatServiceMock.syncEmotes).not.toHaveBeenCalled();
        expect(githubServiceMock.getOpenPullRequests).not.toHaveBeenCalled();
        expect(chatServiceMock.updateFourthwallOrders).not.toHaveBeenCalled();
        expect(chatServiceMock.handleFindSimilarIssuesOrDiscussions).not.toHaveBeenCalled();
        expect(replies().map(({ content }) => content)).toEqual([usage]);
      },
    );
  });

  describe('emote-sync', () => {
    const report: EmoteSyncReport = {
      total: 3,
      zulipUploaded: 3,
      failed: [],
      renamed: ['nameless:3 → nameless_3'],
      replaced: [],
      alreadyOnZulip: [],
    };
    const DONE = `Done syncing the emotes of ${SERVER}: 3 emotes, 3 uploaded to Zulip, 1 renamed: nameless:3 → nameless_3`;

    it('should acknowledge at once, naming the server, sync it in the background and post the report when done', async () => {
      let finish!: (report: EmoteSyncReport) => void;
      chatServiceMock.syncEmotes.mockReturnValue(new Promise((resolve) => (finish = resolve)));

      await send('@**Immich** emote-sync');

      expect(chatServiceMock.syncEmotes).toHaveBeenCalledExactlyOnceWith(Constants.Discord.EmoteSyncServer.id);
      expect(Constants.Discord.EmoteSyncServer).toEqual({ id: '979116623879368755', name: 'Immich' });
      expect(replies().map(({ content }) => content)).toEqual([
        `Syncing the emotes of ${SERVER} to Zulip, this can take a few minutes…`,
      ]);

      finish(report);
      await flush();

      expect(replies().map(({ content }) => content)).toEqual([
        `Syncing the emotes of ${SERVER} to Zulip, this can take a few minutes…`,
        DONE,
      ]);
    });

    it('should report the same outcome as Discord does, naming the server', async () => {
      chatServiceMock.syncEmotes.mockResolvedValue({
        total: 3,
        zulipUploaded: 0,
        zulipSkipped: 'unlisted',
        failed: ['pepeD'],
        renamed: [],
        replaced: [],
        alreadyOnZulip: ['catJAM', 'CatJam → catjam2'],
      });

      await send('@**Immich** emote-sync');
      await flush();

      expect(replies().at(-1)?.content).toBe(
        `Done syncing the emotes of ${SERVER}: 3 emotes, 0 uploaded to Zulip (skipped: its emoji could not be listed), 1 failed: pepeD, 2 already on Zulip: catJAM, CatJam → catjam2`,
      );
    });

    it('should mention nobody through an emote name', async () => {
      chatServiceMock.syncEmotes.mockResolvedValue({
        ...report,
        failed: ['@**all**'],
        renamed: ['#**general** → general'],
      });

      await send('@**Immich** emote-sync');
      await flush();

      expect(replies().at(-1)?.content).toBe(
        `Done syncing the emotes of ${SERVER}: 3 emotes, 3 uploaded to Zulip, 1 failed: @\u200B**all**, 1 renamed: #\u200B**general** → general`,
      );
    });

    it("should keep the report within Zulip's message limit", async () => {
      chatServiceMock.syncEmotes.mockResolvedValue({
        ...report,
        total: 1000,
        failed: Array.from({ length: 1000 }, (_, index) => `emote_number_${index}`),
        renamed: [],
      });

      await send('@**Immich** emote-sync');
      await flush();

      const outcome = replies().at(-1)!.content;
      expect(outcome).toMatch(
        /^Done syncing the emotes of the Immich Discord server \(979116623879368755\): 1000 emotes, 3 uploaded to Zulip, 1000 failed: emote_number_0, /,
      );
      expect(outcome).toMatch(/\.\.\.$/);
      expect(outcome).toHaveLength(10_000);
    });

    it('should run one sync at a time and say so', async () => {
      let finish!: (report: EmoteSyncReport) => void;
      chatServiceMock.syncEmotes.mockReturnValue(new Promise((resolve) => (finish = resolve)));

      await send('@**Immich** emote-sync');
      await send('@**Immich** emote-sync', { id: 501 });

      expect(chatServiceMock.syncEmotes).toHaveBeenCalledOnce();
      expect(replies().at(-1)?.content).toBe('`emote-sync` is already running; wait for it to finish.');

      finish(report);
      await flush();
      await send('@**Immich** emote-sync', { id: 502 });

      expect(chatServiceMock.syncEmotes).toHaveBeenCalledTimes(2);
    });

    it('should log a sync that fails, say so in the topic, and take the next one', async () => {
      chatServiceMock.syncEmotes.mockRejectedValueOnce(new Error('Discord is down')).mockResolvedValueOnce(report);

      await send('@**Immich** emote-sync');
      await flush();

      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        'The Zulip command emote-sync failed on message 500',
        expect.any(Error),
      );
      expect(replies().at(-1)?.content).toBe('`emote-sync` failed: `Discord is down`');

      await send('@**Immich** emote-sync', { id: 501 });
      await flush();

      expect(replies().at(-1)?.content).toBe(DONE);
    });

    it('should say the sync failed when the bot cannot read the server, rather than report it done', async () => {
      chatServiceMock.syncEmotes.mockRejectedValue(
        new Error(
          'Cannot read the emotes of Discord server 979116623879368755: the bot is not logged in to Discord, or not a member of that server',
        ),
      );

      await send('@**Immich** emote-sync');
      await flush();

      expect(replies().at(-1)?.content).toBe(
        '`emote-sync` failed: `Cannot read the emotes of Discord server 979116623879368755: the bot is not logged in to Discord, or not a member of that server`',
      );
    });

    it('should log an outcome that cannot be posted, and not stay locked', async () => {
      chatServiceMock.syncEmotes.mockResolvedValue(report);
      zulipMock.sendMessage.mockResolvedValueOnce({ id: 1 }).mockRejectedValueOnce(new Error('fetch failed'));

      await send('@**Immich** emote-sync');
      await flush();

      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        'Could not post the outcome of the Zulip command emote-sync',
        expect.any(Error),
      );

      await send('@**Immich** emote-sync', { id: 501 });
      await flush();

      expect(chatServiceMock.syncEmotes).toHaveBeenCalledTimes(2);
      expect(replies().at(-1)?.content).toBe(DONE);
    });

    it('should not start the sync when the acknowledgement cannot be posted, and not stay locked', async () => {
      zulipMock.sendMessage.mockRejectedValueOnce(new Error('fetch failed'));

      await send('@**Immich** emote-sync');

      expect(chatServiceMock.syncEmotes).not.toHaveBeenCalled();
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'The Zulip command emote-sync failed on message 500',
        expect.any(Error),
      );

      chatServiceMock.syncEmotes.mockResolvedValue(report);
      await send('@**Immich** emote-sync', { id: 501 });
      await flush();

      expect(chatServiceMock.syncEmotes).toHaveBeenCalledOnce();
    });
  });

  describe('backfill-pull-requests', () => {
    const ACK =
      'Going through every open pull request, creating the Discord thread and the Zulip topic each one lacks; this can take a while…';

    it('should acknowledge, then list the open pull requests and backfill them on both platforms in the background', async () => {
      let finish!: (report: BackfillReport) => void;
      githubServiceMock.getOpenPullRequests.mockResolvedValue([pullRequest(1), pullRequest(2)]);
      webhookServiceMock.backfillPullRequests.mockReturnValue(new Promise((resolve) => (finish = resolve)));

      await send('@**Immich** backfill-pull-requests all');
      await flush();

      expect(replies().map(({ content }) => content)).toEqual([ACK]);
      expect(zulipMock.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
        githubServiceMock.getOpenPullRequests.mock.invocationCallOrder[0],
      );
      expect(webhookServiceMock.backfillPullRequests).toHaveBeenCalledExactlyOnceWith(
        [pullRequest(1), pullRequest(2)],
        BOTH_PLATFORMS,
      );

      finish({ total: 2, threads: [], topics: [1, 2], skipped: [], failed: [] });
      await flush();

      expect(replies().at(-1)?.content).toBe(
        'Backfill of 2 open pull requests done: created 0 Discord threads and 2 Zulip topics; skipped 0; failed 0.',
      );
    });

    it('should report what was created, skipped and failed, never a blanket success', async () => {
      githubServiceMock.getOpenPullRequests.mockResolvedValue([
        pullRequest(1),
        pullRequest(2),
        pullRequest(3),
        pullRequest(4),
      ]);
      webhookServiceMock.backfillPullRequests.mockResolvedValue({
        total: 4,
        threads: [1],
        topics: [1, 2],
        skipped: [
          { number: 3, reason: 'already complete' },
          { number: 4, reason: 'not tracked' },
        ],
        failed: [2],
      });

      await send('@**Immich** backfill-pull-requests all');
      await flush();

      expect(replies().at(-1)?.content).toBe(
        'Backfill of 4 open pull requests done: created 1 Discord thread and 2 Zulip topics; skipped 2 (1 already complete, 1 not tracked); failed 1 (#2), see the log.',
      );
    });

    it('should say so when there was one, or none', async () => {
      githubServiceMock.getOpenPullRequests.mockResolvedValueOnce([pullRequest(1)]).mockResolvedValueOnce([]);

      await send('@**Immich** backfill-pull-requests all');
      await flush();
      await send('@**Immich** backfill-pull-requests number=ALL', { id: 501 });
      await flush();

      expect(replies().map(({ content }) => content)).toEqual([
        ACK,
        'Backfill of 1 open pull request done: created 1 Discord thread and 1 Zulip topic; skipped 0; failed 0.',
        ACK,
        'Backfill of 0 open pull requests done: created 0 Discord threads and 0 Zulip topics; skipped 0; failed 0.',
      ]);
    });

    it('should acknowledge at once and hold the lock while GitHub keeps the list waiting, as a rate limit does', async () => {
      let list!: (pullRequests: PullRequestBaseEvent[]) => void;
      githubServiceMock.getOpenPullRequests.mockReturnValueOnce(new Promise((resolve) => (list = resolve)));

      await send('@**Immich** backfill-pull-requests all');
      await flush();

      expect(replies().map(({ content }) => content)).toEqual([ACK]);
      expect(webhookServiceMock.backfillPullRequests).not.toHaveBeenCalled();

      await send('@**Immich** backfill-pull-requests all', { id: 501 });

      expect(githubServiceMock.getOpenPullRequests).toHaveBeenCalledOnce();
      expect(replies().at(-1)?.content).toBe('`backfill-pull-requests` is already running; wait for it to finish.');

      list([pullRequest(1)]);
      await flush();

      expect(replies().at(-1)?.content).toBe(
        'Backfill of 1 open pull request done: created 1 Discord thread and 1 Zulip topic; skipped 0; failed 0.',
      );
    });

    it('should say so in the topic when the pull requests cannot be listed, after the acknowledgement, and not stay locked', async () => {
      githubServiceMock.getOpenPullRequests.mockRejectedValueOnce(new Error('GitHub is down')).mockResolvedValue([]);

      await send('@**Immich** backfill-pull-requests all');
      await flush();

      expect(replies().map(({ content }) => content)).toEqual([
        ACK,
        '`backfill-pull-requests` failed: `GitHub is down`',
      ]);
      expect(webhookServiceMock.backfillPullRequests).not.toHaveBeenCalled();
      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        'The Zulip command backfill-pull-requests failed on message 500',
        expect.any(Error),
      );

      await send('@**Immich** backfill-pull-requests all', { id: 501 });
      await flush();

      expect(replies().at(-1)?.content).toBe(
        'Backfill of 0 open pull requests done: created 0 Discord threads and 0 Zulip topics; skipped 0; failed 0.',
      );
    });

    it('should run one backfill at a time', async () => {
      webhookServiceMock.backfillPullRequests.mockReturnValue(new Promise(() => {}));

      await send('@**Immich** backfill-pull-requests all');
      await send('@**Immich** backfill-pull-requests all', { id: 501 });

      expect(githubServiceMock.getOpenPullRequests).toHaveBeenCalledOnce();
      expect(replies().at(-1)?.content).toBe('`backfill-pull-requests` is already running; wait for it to finish.');
    });

    it('should not backfill one pull request while every one is being backfilled, which would create it twice', async () => {
      let finish!: (report: BackfillReport) => void;
      githubServiceMock.getOpenPullRequests.mockResolvedValue([pullRequest(1234)]);
      githubServiceMock.getOpenPullRequest.mockResolvedValue(pullRequest(1234));
      webhookServiceMock.backfillPullRequests.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

      await send('@**Immich** backfill-pull-requests all');
      await send('@**Immich** backfill-pull-requests 1234', { id: 501 });

      expect(githubServiceMock.getOpenPullRequest).not.toHaveBeenCalled();
      expect(webhookServiceMock.backfillPullRequests).toHaveBeenCalledOnce();
      expect(replies().at(-1)?.content).toBe('`backfill-pull-requests` is already running; wait for it to finish.');

      finish({ total: 1, threads: [], topics: [], skipped: [], failed: [1234] });
      await flush();
      await send('@**Immich** backfill-pull-requests 1234', { id: 502 });

      expect(webhookServiceMock.backfillPullRequests).toHaveBeenLastCalledWith([pullRequest(1234)], BOTH_PLATFORMS);
      expect(replies().at(-1)?.content).toBe(
        'Backfill of pull request #1234 done: created 1 Discord thread and 1 Zulip topic; skipped 0; failed 0.',
      );
    });

    it('should release the lock of a one pull request backfill that fails', async () => {
      githubServiceMock.getOpenPullRequest.mockRejectedValueOnce(new Error('GitHub is down'));
      githubServiceMock.getOpenPullRequest.mockResolvedValueOnce(pullRequest(1234));

      await send('@**Immich** backfill-pull-requests 1234');
      await send('@**Immich** backfill-pull-requests 1234', { id: 501 });

      expect(replies().map(({ content }) => content)).toEqual([
        '`backfill-pull-requests` failed: `GitHub is down`',
        'Backfill of pull request #1234 done: created 1 Discord thread and 1 Zulip topic; skipped 0; failed 0.',
      ]);
    });

    it.each([
      '@**Immich** backfill-pull-requests 1234',
      '@**Immich** backfill-pull-requests number=1234',
      '@**Immich** backfill-pull-requests #1234',
    ])(
      'should fetch the one pull request %j names directly, and backfill it inline on both platforms',
      async (content) => {
        githubServiceMock.getOpenPullRequest.mockResolvedValue(pullRequest(1234));

        await send(content);

        expect(githubServiceMock.getOpenPullRequest).toHaveBeenCalledExactlyOnceWith(1234);
        expect(githubServiceMock.getOpenPullRequests).not.toHaveBeenCalled();
        expect(webhookServiceMock.backfillPullRequests).toHaveBeenCalledExactlyOnceWith(
          [pullRequest(1234)],
          BOTH_PLATFORMS,
        );
        expect(replies().map(({ content }) => content)).toEqual([
          'Backfill of pull request #1234 done: created 1 Discord thread and 1 Zulip topic; skipped 0; failed 0.',
        ]);
      },
    );

    it('should say when the pull request named is not open, and touch nothing', async () => {
      await send('@**Immich** backfill-pull-requests 1234');

      expect(githubServiceMock.getOpenPullRequest).toHaveBeenCalledExactlyOnceWith(1234);
      expect(webhookServiceMock.backfillPullRequests).not.toHaveBeenCalled();
      expect(replies().map(({ content }) => content)).toEqual([
        'Pull request #1234 is not open in immich-app/immich, so there is nothing to backfill.',
      ]);
    });

    it('should say what happened to the one pull request, skipped or failed', async () => {
      githubServiceMock.getOpenPullRequest.mockResolvedValue(pullRequest(1234));
      webhookServiceMock.backfillPullRequests
        .mockResolvedValueOnce({
          total: 1,
          threads: [],
          topics: [],
          skipped: [{ number: 1234, reason: 'already complete' }],
          failed: [],
        })
        .mockResolvedValueOnce({ total: 1, threads: [1234], topics: [], skipped: [], failed: [1234] });

      await send('@**Immich** backfill-pull-requests 1234');
      await send('@**Immich** backfill-pull-requests 1234', { id: 501 });

      expect(replies().map(({ content }) => content)).toEqual([
        'Backfill of pull request #1234 done: created 0 Discord threads and 0 Zulip topics; skipped 1 (1 already complete); failed 0.',
        'Backfill of pull request #1234 done: created 1 Discord thread and 0 Zulip topics; skipped 0; failed 1 (#1234), see the log.',
      ]);
    });

    it.each([
      '@**Immich** backfill-pull-requests abc',
      '@**Immich** backfill-pull-requests 12 number=12',
      '@**Immich** backfill-pull-requests',
      '@**Immich** backfill-pull-requests number=',
    ])('should answer %j with the usage rather than backfill everything', async (content) => {
      await send(content);

      expect(githubServiceMock.getOpenPullRequests).not.toHaveBeenCalled();
      expect(githubServiceMock.getOpenPullRequest).not.toHaveBeenCalled();
      expect(webhookServiceMock.backfillPullRequests).not.toHaveBeenCalled();
      expect(replies().map(({ content }) => content)).toEqual(['Usage: `backfill-pull-requests <number|all>`']);
    });
  });

  describe('fourthwall', () => {
    it.each([
      '@**Immich** fourthwall',
      '@**Immich** fourthwall refresh',
      '@**Immich** fourthwall update',
      '@**Immich** fourthwall update id=',
      '@**Immich** fourthwall update 1 2',
      '@**Immich** fourthwall update banana id=5',
    ])('should answer %j with the usage', async (content) => {
      await send(content);

      expect(chatServiceMock.updateFourthwallOrders).not.toHaveBeenCalled();
      expect(replies().map(({ content }) => content)).toEqual(['Usage: `fourthwall update <id|all>`']);
    });

    it('should update one order given positionally and reply when done', async () => {
      await send('@**Immich** fourthwall update ORD-123');

      expect(chatServiceMock.updateFourthwallOrders).toHaveBeenCalledExactlyOnceWith('ORD-123');
      expect(replies().map(({ content }) => content)).toEqual(['Updated Fourthwall order `ORD-123`.']);
    });

    it('should update one order given as id=, whatever the case of the action', async () => {
      await send('@**Immich** fourthwall Update id=ORD-123');

      expect(chatServiceMock.updateFourthwallOrders).toHaveBeenCalledExactlyOnceWith('ORD-123');
      expect(replies().map(({ content }) => content)).toEqual(['Updated Fourthwall order `ORD-123`.']);
    });

    it('should update every order in the background when asked for all, acknowledging first', async () => {
      let finish!: () => void;
      chatServiceMock.updateFourthwallOrders.mockReturnValue(new Promise((resolve) => (finish = resolve)));

      await send('@**Immich** fourthwall update all');

      expect(chatServiceMock.updateFourthwallOrders).toHaveBeenCalledExactlyOnceWith();
      expect(replies().map(({ content }) => content)).toEqual([
        'Updating every Fourthwall order, this can take a while…',
      ]);

      finish();
      await flush();

      expect(replies().at(-1)?.content).toBe('Updated every Fourthwall order.');
    });

    it('should not update one order while every order is being updated, and say so', async () => {
      chatServiceMock.updateFourthwallOrders.mockReturnValue(new Promise(() => {}));

      await send('@**Immich** fourthwall update all');
      await send('@**Immich** fourthwall update ORD-1', { id: 501 });

      expect(chatServiceMock.updateFourthwallOrders).toHaveBeenCalledExactlyOnceWith();
      expect(replies().at(-1)?.content).toBe('`fourthwall` is already running; wait for it to finish.');
    });

    it('should say so in the topic when the update fails, and log it', async () => {
      chatServiceMock.updateFourthwallOrders.mockRejectedValue(new Error('Order not found'));

      await expect(send('@**Immich** fourthwall update ORD-404')).resolves.toBeUndefined();

      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        'The Zulip command fourthwall failed on message 500',
        expect.any(Error),
      );
      expect(replies().map(({ content }) => content)).toEqual(['`fourthwall` failed: `Order not found`']);
    });
  });

  describe('similar', () => {
    const found = [
      '[Issue] Thumbnails crash (https://github.com/immich-app/immich/issues/1), Similarity: 0.912',
      '[Discussion] Ping @**all** (https://github.com/immich-app/immich/discussions/2), Similarity: 0.800',
    ].join('\n');

    it('should compare the text given, quoted or not, and list what was found with mentions neutralised', async () => {
      chatServiceMock.handleFindSimilarIssuesOrDiscussions.mockResolvedValue(found);

      await send('@**Immich** similar thumbnails crash on upload');
      await send('@**Immich** similar text="thumbnails crash on upload"', { id: 501 });

      expect(chatServiceMock.handleFindSimilarIssuesOrDiscussions.mock.calls).toEqual([
        ['thumbnails crash on upload', neutraliseZulipLabel],
        ['thumbnails crash on upload', neutraliseZulipLabel],
      ]);
      expect(zulipMock.getMessages).not.toHaveBeenCalled();
      const expected = [
        'Similar to `thumbnails crash on upload`:',
        '[Issue] Thumbnails crash (https://github.com/immich-app/immich/issues/1), Similarity: 0.912',
        '[Discussion] Ping @\u200B**all** (https://github.com/immich-app/immich/discussions/2), Similarity: 0.800',
      ].join('\n');
      expect(replies().map(({ content }) => content)).toEqual([expected, expected]);
    });

    it('should compare free text that holds a word=value token, which is not an option it reads', async () => {
      await send('@**Immich** similar the upload fails when CORS=strict on nginx');

      expect(chatServiceMock.handleFindSimilarIssuesOrDiscussions).toHaveBeenCalledExactlyOnceWith(
        'the upload fails when CORS=strict on nginx',
        neutraliseZulipLabel,
      );
      expect(replies().map(({ content }) => content)).toEqual([
        'Nothing similar to `the upload fails when CORS=strict on nginx` was found.',
      ]);
    });

    it('should not answer a "Quote and reply" of one of its own messages', async () => {
      await send(
        '@_**Immich|7** [said](https://zulip.example.com/#narrow/stream/107/topic/deploy/near/500):\n```quote\nDone syncing\n```\nlooks good',
      );

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should compare the last message a human wrote in the topic, skipping the command, the bot and other commands', async () => {
      zulipMock.getMessages.mockResolvedValue([
        message({ id: 490, content: 'the thumbnails crash on upload since v1.100' }),
        message({ id: 491, content: '@**Immich** similar' }),
        message({ id: 492, senderId: BOT.userId, senderEmail: 'immich-bot@example.com', content: 'Nothing similar…' }),
        message({ id: 493, senderId: 30, senderEmail: 'github-bot@example.com', content: 'CI failed' }),
        message({ id: 500, content: '@**Immich** similar' }),
      ]);
      chatServiceMock.handleFindSimilarIssuesOrDiscussions.mockResolvedValue(found.split('\n')[0]);

      await send('@**Immich** similar');

      expect(zulipMock.getMessages).toHaveBeenCalledExactlyOnceWith({ stream: 107, topic: 'deploy', numBefore: 10 });
      expect(chatServiceMock.handleFindSimilarIssuesOrDiscussions).toHaveBeenCalledExactlyOnceWith(
        'the thumbnails crash on upload since v1.100',
        neutraliseZulipLabel,
      );
      expect(replies().map(({ content }) => content)).toEqual([
        [
          'Similar to `the thumbnails crash on upload since v1.100`:',
          '[Issue] Thumbnails crash (https://github.com/immich-app/immich/issues/1), Similarity: 0.912',
        ].join('\n'),
      ]);
    });

    it('should take the newest human message whatever order the server listed them in, and echo it on one line, shortened', async () => {
      zulipMock.getMessages.mockResolvedValue([
        message({ id: 495, content: 'a'.repeat(200) }),
        message({ id: 490, content: 'first\nline\n\nand   the ' + 'b'.repeat(100) }),
      ]);
      chatServiceMock.handleFindSimilarIssuesOrDiscussions.mockResolvedValue('');

      await send('@**Immich** similar');

      expect(chatServiceMock.handleFindSimilarIssuesOrDiscussions).toHaveBeenCalledExactlyOnceWith(
        'a'.repeat(200),
        neutraliseZulipLabel,
      );
      expect(replies().map(({ content }) => content)).toEqual([
        `Nothing similar to \`${'a'.repeat(77)}...\` was found.`,
      ]);
    });

    it('should say when there is nothing to compare', async () => {
      zulipMock.getMessages.mockResolvedValue([message({ id: 500, content: '@**Immich** similar' })]);

      await send('@**Immich** similar');

      expect(chatServiceMock.handleFindSimilarIssuesOrDiscussions).not.toHaveBeenCalled();
      expect(replies().map(({ content }) => content)).toEqual([
        'There is no message in this topic to compare; pass the text instead: `similar text="…"`.',
      ]);
    });

    it('should say when nothing similar was found, mentioning nobody', async () => {
      await send('@**Immich** similar "@**all** please look"');

      expect(replies().map(({ content }) => content)).toEqual([
        'Nothing similar to `@\u200B**all** please look` was found.',
      ]);
    });

    it('should say so in the topic when the search fails, and log it', async () => {
      chatServiceMock.handleFindSimilarIssuesOrDiscussions.mockRejectedValue(new Error('loop is down'));

      await expect(send('@**Immich** similar crash')).resolves.toBeUndefined();

      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        'The Zulip command similar failed on message 500',
        expect.any(Error),
      );
      expect(replies().map(({ content }) => content)).toEqual(['`similar` failed: `loop is down`']);
    });

    it('should say so in the topic when the topic cannot be read', async () => {
      zulipMock.getMessages.mockRejectedValue(new Error('fetch failed'));

      await send('@**Immich** similar');

      expect(replies().map(({ content }) => content)).toEqual(['`similar` failed: `fetch failed`']);
    });
  });

  describe('failures', () => {
    it('should keep a failure reply short, in code, and free of mentions', async () => {
      chatServiceMock.updateFourthwallOrders.mockRejectedValue(new Error(`@**all** ${'x'.repeat(400)}`));

      await send('@**Immich** fourthwall update 1');

      const [reply] = replies().map(({ content }) => content);
      expect(reply).toMatch(/^`fourthwall` failed: `@\u200B\*\*all\*\* x+\.\.\.`$/);
      expect(reply).toHaveLength('`fourthwall` failed: `'.length + 300 + 1 + 1);
    });

    it('should keep an error message on one line, with no backtick, so it can add no structure to the reply', async () => {
      chatServiceMock.updateFourthwallOrders.mockRejectedValue(
        new Error('Order not found\n\n# Everything is fine\n```\nrm -rf\n```\n- `x`\ttab'),
      );

      await send('@**Immich** fourthwall update 1');

      expect(replies().map(({ content }) => content)).toEqual([
        '`fourthwall` failed: `Order not found # Everything is fine rm -rf - x tab`',
      ]);
    });

    it('should describe a rejection that is not an Error', async () => {
      chatServiceMock.updateFourthwallOrders.mockRejectedValue('nope');

      await send('@**Immich** fourthwall update 1');

      expect(replies().map(({ content }) => content)).toEqual(['`fourthwall` failed: `nope`']);
    });
  });

  describe('scheduled messages', () => {
    const everyMinute = '* * * * *';
    const nextMinute = () => vitest.advanceTimersByTimeAsync(60_000);
    const contents = () => replies().map(({ content }) => content);
    const posts = (topic: string) =>
      replies()
        .filter((reply) => reply.topic === topic)
        .map(({ stream, content }) => [stream, content]);

    beforeEach(() => {
      vitest.useFakeTimers();
      vitest.setSystemTime(new Date('2026-01-05T08:59:30.000Z'));
    });

    afterEach(() => {
      vitest.clearAllTimers();
      vitest.useRealTimers();
    });

    it('should create, list, edit and remove a scheduled message, posting it on its schedule in between', async () => {
      await send(`@**Immich** schedule-add standup cron="${everyMinute}" message="@*mobile* Standup in **5 minutes**"`);
      expect(database.scheduled).toMatchObject([
        {
          name: 'standup',
          cronExpression: everyMinute,
          message: '@*mobile* Standup in **5 minutes**',
          channelId: '107',
          topic: 'deploy',
          createdBy: '12',
          service: 'zulip',
        },
      ]);

      await nextMinute();
      await send('@**Immich** schedule-list');
      await send('@**Immich** schedule-edit standup message="Standup now" topic=daily');
      await nextMinute();
      await send('@**Immich** schedule-remove name=standup');
      await nextMinute();
      await send('@**Immich** schedule-list');

      expect(contents()).toEqual([
        'Scheduled message `standup` created with cron `* * * * *`, posting in topic `deploy` of this stream.',
        '@*mobile* Standup in **5 minutes**',
        'Scheduled messages of this stream:\n- `standup`: `* * * * *` in topic `deploy`: `@\u200B*mobile* Standup in **5 minutes**`',
        'Updated scheduled message `standup`: it posts with cron `* * * * *` in topic `daily` of this stream.',
        'Standup now',
        'Removed scheduled message `standup`.',
        'There are no scheduled messages in this stream.',
      ]);
      expect(posts('daily')).toEqual([[107, 'Standup now']]);
      expect(database.scheduled).toEqual([]);
    });

    it('should move a scheduled message to a new schedule', async () => {
      await send('@**Immich** schedule-add yearly cron="0 0 1 1 *" message=Hi');
      await nextMinute();
      await send(`@**Immich** schedule-edit yearly cron="${everyMinute}"`);
      await nextMinute();

      expect(contents().filter((content) => content === 'Hi')).toHaveLength(1);
    });

    it('should post to the topic given, and say that suppress-embeds is ignored on Zulip', async () => {
      await send(
        `@**Immich** schedule-add weekly cron="${everyMinute}" message=Hi topic="weekly sync" suppress-embeds=false`,
      );
      await nextMinute();

      expect(contents()[0]).toBe(
        'Scheduled message `weekly` created with cron `* * * * *`, posting in topic `weekly sync` of this stream. `suppress-embeds` is accepted and ignored: Zulip cannot turn off link previews for one message.',
      );
      expect(posts('weekly sync')).toEqual([[107, 'Hi']]);
      expect(database.scheduled[0]).toMatchObject({ topic: 'weekly sync', suppressEmbeds: true });
    });

    it('should post in the general chat topic when the command was given there', async () => {
      await send(`@**Immich** schedule-add weekly cron="${everyMinute}" message=Hi`, { topic: '' });
      await nextMinute();

      expect(contents()[0]).toBe(
        'Scheduled message `weekly` created with cron `* * * * *`, posting in the general chat topic of this stream.',
      );
      expect(posts('')).toEqual([
        [107, contents()[0]],
        [107, 'Hi'],
      ]);
    });

    it.each([
      ['@**Immich** schedule-add standup message=Hi', 'schedule-add'],
      ['@**Immich** schedule-add cron="* * * * *" message=Hi', 'schedule-add'],
      ['@**Immich** schedule-add standup cron="* * * * *"', 'schedule-add'],
      ['@**Immich** schedule-add standup cron="* * * * *" message=Hi suppress-embeds=maybe', 'schedule-add'],
      ['@**Immich** schedule-add standup "* * * * *" Hi', 'schedule-add'],
      ['@**Immich** schedule-edit standup', 'schedule-edit'],
      ['@**Immich** schedule-edit standup message=""', 'schedule-edit'],
      ['@**Immich** schedule-edit message=Hi', 'schedule-edit'],
      ['@**Immich** schedule-remove', 'schedule-remove'],
      ['@**Immich** schedule-list all', 'schedule-list'],
    ])('should answer %j with the usage of %s and change nothing', async (content, name) => {
      await send(content);

      expect(contents()).toEqual([expect.stringMatching(new RegExp(`^Usage: \`${name}( |\`)`))]);
      expect(database.scheduled).toEqual([]);
    });

    it('should answer an invalid cron expression with the error, storing nothing', async () => {
      await send('@**Immich** schedule-add standup cron="not a cron" message=Hi');

      expect(contents()).toEqual([
        '`schedule-add` failed: `Invalid cron expression not a cron: Error: Unknown alias: not`',
      ]);
      expect(database.scheduled).toEqual([]);
    });

    it('should say a name already taken in this stream is here, and how to change it', async () => {
      await send(`@**Immich** schedule-add standup cron="${everyMinute}" message=Hi`);
      await send(`@**Immich** schedule-add standup cron="${everyMinute}" message=Again`);

      expect(contents()[1]).toBe(
        'There is already a scheduled message named `standup` in this stream; `schedule-edit standup` changes it.',
      );
      expect(database.scheduled).toMatchObject([{ message: 'Hi' }]);
    });

    it('should answer an invalid cron for a message of another stream with not found', async () => {
      await database.createScheduledMessage({
        name: 'customers',
        cronExpression: '0 9 * * 1',
        message: 'Weekly check-in',
        channelId: '120',
        createdBy: '12',
        service: 'zulip',
      });

      await send('@**Immich** schedule-edit customers cron="not a cron"');

      expect(contents()).toEqual([
        'There is no scheduled message `customers` in this stream; `schedule-list` lists them.',
      ]);
    });

    it.each([
      ['on Discord', { channelId: '991930592843272342', service: 'discord' as const }],
      ['in another stream', { channelId: '120', service: 'zulip' as const }],
    ])('should say a name already taken %s is shared, storing nothing', async (_, taken) => {
      await database.createScheduledMessage({
        name: 'standup',
        cronExpression: '0 9 * * 1',
        message: 'Elsewhere',
        createdBy: 'user-1',
        ...taken,
      });

      await send(`@**Immich** schedule-add standup cron="${everyMinute}" message=Hi`);

      expect(contents()).toEqual([
        'There is already a scheduled message named `standup`, in another stream or on Discord: every stream and Discord share the names, so pick another.',
      ]);
      expect(database.scheduled).toMatchObject([{ message: 'Elsewhere' }]);
    });

    it('should neither list, edit nor remove a scheduled message of another platform', async () => {
      await database.createScheduledMessage({
        name: 'standup',
        cronExpression: '0 9 * * 1',
        message: 'Discord standup',
        channelId: '991930592843272342',
        createdBy: 'user-1',
        service: 'discord',
      });

      await send('@**Immich** schedule-list');
      await send('@**Immich** schedule-edit standup message=Hijacked');
      await send('@**Immich** schedule-remove standup');

      const notFound = 'There is no scheduled message `standup` in this stream; `schedule-list` lists them.';
      expect(contents()).toEqual(['There are no scheduled messages in this stream.', notFound, notFound]);
      expect(database.scheduled).toMatchObject([{ name: 'standup', message: 'Discord standup', service: 'discord' }]);
    });

    it('should neither list, edit nor remove a scheduled message of another stream, but take them in its own', async () => {
      await database.createScheduledMessage({
        name: 'customers',
        cronExpression: '0 9 * * 1',
        message: 'Weekly check-in',
        channelId: '120',
        topic: 'check-ins',
        createdBy: '12',
        service: 'zulip',
      });

      await send('@**Immich** schedule-list');
      await send('@**Immich** schedule-edit customers message=Hijacked');
      await send('@**Immich** schedule-remove customers');
      expect(database.scheduled).toMatchObject([{ name: 'customers', message: 'Weekly check-in' }]);

      await send('@**Immich** schedule-list', { streamId: 120 });
      await send('@**Immich** schedule-edit customers message="Monthly check-in"', { streamId: 120 });
      await send('@**Immich** schedule-remove customers', { streamId: 120 });

      const notFound = 'There is no scheduled message `customers` in this stream; `schedule-list` lists them.';
      expect(contents()).toEqual([
        'There are no scheduled messages in this stream.',
        notFound,
        notFound,
        'Scheduled messages of this stream:\n- `customers`: `0 9 * * 1` in topic `check-ins`: `Weekly check-in`',
        'Updated scheduled message `customers`: it posts with cron `0 9 * * 1` in topic `check-ins` of this stream.',
        'Removed scheduled message `customers`.',
      ]);
      expect(database.scheduled).toEqual([]);
    });

    it('should list a message on one line, shortened, mentioning nobody', async () => {
      const message = `@**all** line one\nline \`two\` ${'x'.repeat(100)}`;
      await database.createScheduledMessage({
        name: 'long',
        cronExpression: '0 9 * * 1',
        message,
        channelId: '107',
        topic: null,
        createdBy: '12',
        service: 'zulip',
      });

      await send('@**Immich** schedule-list');

      expect(contents()).toEqual([
        `Scheduled messages of this stream:\n- \`long\`: \`0 9 * * 1\` in the general chat topic: \`@\u200B**all** line one line two ${'x'.repeat(48)}...\``,
      ]);
    });
  });

  describe('rss', () => {
    const feedUrl = 'https://immich.app/blog/rss.xml';
    const newestPost = {
      id: 'p2',
      title: 'Immich v2.0.0',
      summary: 'Stable at last',
      link: 'https://immich.app/blog/v2',
      pubDate: '2025-06-10T09:30:00Z',
    };
    const contents = () => replies().map(({ content }) => content);

    beforeEach(() => {
      zulipMock.isInitialised.mockReturnValue(true);
      rssMock.getFeed.mockResolvedValue({ feed: { title: 'Immich Blog' }, posts: [newestPost, { id: 'p1' }] });
    });

    it('should subscribe, list and unsubscribe a feed, posting its newest post in the topic given', async () => {
      await send(`@**Immich** rss-subscribe ${feedUrl} topic=blog`);
      await flush();
      await send('@**Immich** rss-list', { id: 501 });
      await send(`@**Immich** rss-subscribe url=${feedUrl}`, { id: 502 });
      await send(`@**Immich** rss-unsubscribe ${feedUrl}`, { id: 503 });
      await send('@**Immich** rss-list', { id: 504 });
      await send(`@**Immich** rss-unsubscribe ${feedUrl}`, { id: 505 });

      expect(replies()).toEqual([
        {
          stream: 107,
          topic: 'deploy',
          content: `Subscribing this stream to \`${feedUrl}\`: fetching the feed to post its newest post in topic \`blog\`…`,
        },
        {
          stream: 107,
          topic: 'blog',
          content: `**[Immich v2.0.0](https://immich.app/blog/v2)** — [Immich Blog](${feedUrl}) · <time:2025-06-10T09:30:00.000Z>\n~~~ quote\nStable at last\n~~~`,
        },
        {
          stream: 107,
          topic: 'deploy',
          content: `Subscribed this stream to \`${feedUrl}\`: its new posts go to topic \`blog\`.`,
        },
        { stream: 107, topic: 'deploy', content: `RSS feeds of this stream:\n- \`${feedUrl}\` in topic \`blog\`` },
        {
          stream: 107,
          topic: 'deploy',
          content: `This stream is already subscribed to \`${feedUrl}\`, in topic \`blog\`.`,
        },
        { stream: 107, topic: 'deploy', content: `Unsubscribed this stream from \`${feedUrl}\`.` },
        { stream: 107, topic: 'deploy', content: 'This stream is not subscribed to any RSS feed.' },
        {
          stream: 107,
          topic: 'deploy',
          content: `This stream is not subscribed to \`${feedUrl}\`; \`rss-list\` lists the feeds it is.`,
        },
      ]);
      expect(rssMock.getFeed).toHaveBeenCalledExactlyOnceWith(feedUrl, null);
      expect(discordMock.sendMessage).not.toHaveBeenCalled();
      expect(database.feeds).toEqual([]);
    });

    it('should store the feed as a Zulip row for this stream and topic, at its newest post', async () => {
      await send(`@**Immich** rss-subscribe ${feedUrl}`, { streamId: 109, topic: 'ios build' });
      await flush();

      expect(database.feeds).toEqual([
        {
          url: feedUrl,
          channelId: '109',
          service: 'zulip',
          topic: 'ios build',
          lastId: 'p2',
          title: 'Immich Blog',
          profileImageUrl: null,
        },
      ]);
    });

    it('should list and remove only the feeds of the stream it is run in, and never a Discord one', async () => {
      await database.createRSSFeed({ url: feedUrl, channelId: '109', service: 'zulip', topic: 'blog' });
      await database.createRSSFeed({ url: feedUrl, channelId: '107' });

      await send('@**Immich** rss-list');
      await send(`@**Immich** rss-unsubscribe ${feedUrl}`);

      expect(contents()).toEqual([
        'This stream is not subscribed to any RSS feed.',
        `This stream is not subscribed to \`${feedUrl}\`; \`rss-list\` lists the feeds it is.`,
      ]);
      expect(database.feeds).toHaveLength(2);
    });

    it('should answer a feed that cannot be subscribed to with the error, keeping no row', async () => {
      rssMock.getFeed.mockResolvedValue({ feed: {}, posts: [] });

      await send(`@**Immich** rss-subscribe ${feedUrl}`);
      await flush();
      await send(`@**Immich** rss-subscribe ${feedUrl}`, { id: 501 });

      expect(contents().slice(0, 2)).toEqual([
        `Subscribing this stream to \`${feedUrl}\`: fetching the feed to post its newest post in topic \`deploy\`…`,
        `\`rss-subscribe\` failed: \`Could not fetch posts from ${feedUrl}\``,
      ]);
      expect(contents()[2]).toMatch(/^Subscribing this stream/);
      expect(database.feeds).toEqual([]);
    });

    it.each([
      ['@**Immich** rss-subscribe', 'rss-subscribe <url> [topic=<topic>]'],
      [`@**Immich** rss-subscribe ${feedUrl} blog`, 'rss-subscribe <url> [topic=<topic>]'],
      [`@**Immich** rss-subscribe ${feedUrl} url=${feedUrl}`, 'rss-subscribe <url> [topic=<topic>]'],
      ['@**Immich** rss-unsubscribe', 'rss-unsubscribe <url>'],
      ['@**Immich** rss-list all', 'rss-list'],
    ])('should answer %j with its usage and subscribe nothing', async (content, usage) => {
      await send(content);

      expect(contents()).toEqual([`Usage: \`${usage}\``]);
      expect(rssMock.getFeed).not.toHaveBeenCalled();
    });
  });

  describe('mirror', () => {
    const NOT_AN_ADMINISTRATOR =
      'Only Zulip organization administrators and owners can change or list the Discord-Zulip mirror.';
    const REQUESTED = 'To mirror this stream with a Discord channel, run `/mirror-link id:K7Q2XM` in that channel.';
    const unlinked: MirrorLinkReply = {
      summary: 'Unlinked Discord channel **#dev** from Zulip stream **#immich-dev**.',
      details: ['⚠ Could not unpin the link announcement on Discord: unknown-message (10008).'],
      zulipAnnouncement: { streamId: 120, topic: '#dev' },
    };

    beforeEach(() => {
      zulipMock.getUser.mockResolvedValue(ADMIN);
      mirrorLinksMock.requestLink.mockResolvedValue(REQUESTED);
      mirrorLinksMock.unlink.mockResolvedValue(unlinked);
    });

    it('should take the mirror commands in any stream', async () => {
      await send('@**Immich** mirror-link', { streamId: 120, topic: 'setup' });
      await send('@**Immich** mirror-list', { streamId: Constants.Zulip.Streams.Immich });
      await send('@**Immich** help', { streamId: 120 });
      await send('@**Immich** discord-unlink', { streamId: 120 });

      expect(zulipMock.getUser).toHaveBeenCalledWith(12);
      expect(mirrorLinksMock.requestLink).toHaveBeenCalledExactlyOnceWith({
        zulipStreamId: 120,
        mainTopic: undefined,
        actor: { platform: 'zulip', id: '12', name: 'Alice' },
      });
      expect(mirrorLinksMock.unlinkIdentity).toHaveBeenCalledExactlyOnceWith({ zulipUserId: 12 }, 'zulip');
      expect(replies().slice(0, 3)).toEqual([
        { stream: 120, topic: 'setup', content: REQUESTED },
        { stream: 54, topic: 'deploy', content: 'No channel is mirrored.' },
        { stream: 120, topic: 'deploy', content: expect.stringContaining('- `mirror-link`, `mirror-unlink`:') },
      ]);
      expect(replies()[2].content).not.toContain('**Team tools**');
    });

    it.each([
      ['an owner', 100, true],
      ['an administrator', 200, true],
      ['a moderator', 300, false],
      ['a member', 400, false],
      ['a guest', 600, false],
    ])('should take the mirror commands from %s: %s', async (_, role, allowed) => {
      zulipMock.getUser.mockResolvedValue({ ...ADMIN, role });

      await send('@**Immich** mirror-link topic="#dev"', { streamId: 120 });
      await send('@**Immich** mirror-unlink', { streamId: 120 });
      await send('@**Immich** mirror-list', { streamId: 120 });

      const calls = [mirrorLinksMock.requestLink, mirrorLinksMock.unlink, mirrorLinksMock.list].map(
        (method) => method.mock.calls.length,
      );
      expect(calls).toEqual(allowed ? [1, 1, 1] : [0, 0, 0]);
      if (!allowed) {
        expect(replies().map(({ content }) => content)).toEqual(Array(3).fill(NOT_AN_ADMINISTRATOR));
      }
    });

    it('should answer when the role cannot be read, and run nothing', async () => {
      zulipMock.getUser.mockRejectedValue(new Error('Zulip is down'));

      await send('@**Immich** mirror-list', { streamId: 120 });

      expect(mirrorLinksMock.list).not.toHaveBeenCalled();
      expect(replies().map(({ content }) => content)).toEqual(['`mirror-list` failed: `Zulip is down`']);
    });

    it('should pass the main topic on, and unlink this stream', async () => {
      await send('@**Immich** mirror-link topic="dev chat"', { streamId: 120 });
      await send('@**Immich** mirror-unlink', { streamId: 120, topic: 'setup' });

      expect(mirrorLinksMock.requestLink.mock.calls[0][0].mainTopic).toBe('dev chat');
      expect(mirrorLinksMock.unlink).toHaveBeenCalledExactlyOnceWith({
        zulipStreamId: 120,
        actor: { platform: 'zulip', id: '12', name: 'Alice' },
      });
      expect(replies()[1].content).toBe(`${unlinked.summary}\n${unlinked.details[0]}`);
    });

    it.each([
      ['@**Immich** mirror-link 100000000000000001', 'mirror-link [topic=<main topic>]'],
      ['@**Immich** mirror-link discord=100000000000000001', 'mirror-link [topic=<main topic>]'],
      ['@**Immich** mirror-unlink discord=100000000000000001', 'mirror-unlink'],
      ['@**Immich** mirror-list all', 'mirror-list'],
    ])('should answer %j with its usage', async (content, usage) => {
      await send(content, { streamId: 120 });

      expect(mirrorLinksMock.requestLink).not.toHaveBeenCalled();
      expect(mirrorLinksMock.unlink).not.toHaveBeenCalled();
      expect(replies().map(({ content: reply }) => reply)).toEqual([`Usage: \`${usage}\``]);
    });

    it('should leave out what the unlink announcement in the same topic already says', async () => {
      await send('@**Immich** mirror-unlink', { streamId: 120, topic: '#dev' });
      mirrorLinksMock.unlink.mockResolvedValue({ ...unlinked, details: [] });
      await send('@**Immich** mirror-unlink', { streamId: 120, topic: '#dev' });

      expect(replies()).toEqual([{ stream: 120, topic: '#dev', content: unlinked.details[0] }]);
    });

    it('should know the general chat topic of an event as the empty topic of the announcement', async () => {
      mirrorLinksMock.unlink.mockResolvedValue({ ...unlinked, zulipAnnouncement: { streamId: 120, topic: '' } });

      await send('@**Immich** mirror-unlink', { streamId: 120, topic: 'general chat' });

      expect(replies()).toEqual([{ stream: 120, topic: 'general chat', content: unlinked.details[0] }]);
    });

    describe('mirror-backfill', () => {
      const ACK = '📜 Copying the messages of the Discord thread 200000000000000001 into this topic…';

      it('should acknowledge in the topic, in any stream, and leave the report to the notices', async () => {
        let finish: (report: string | undefined) => void = () => {};
        mirrorLinksMock.backfill.mockImplementation(async (_, acknowledge) => {
          await acknowledge(ACK);
          return { done: new Promise((resolve) => (finish = resolve)) };
        });

        await send('@**Immich** mirror-backfill', { streamId: 120, topic: 'Crash on upload' });
        finish(undefined);
        await new Promise((resolve) => setImmediate(resolve));

        expect(mirrorLinksMock.backfill).toHaveBeenCalledExactlyOnceWith(
          {
            target: { zulipStreamId: 120, topic: 'Crash on upload' },
            actor: { platform: 'zulip', id: '12', name: 'Alice' },
          },
          expect.any(Function),
        );
        expect(replies()).toEqual([{ stream: 120, topic: 'Crash on upload', content: ACK }]);
      });

      it('should post the report of a backfill that found nothing to copy', async () => {
        mirrorLinksMock.backfill.mockImplementation(async (_, acknowledge) => {
          await acknowledge(ACK);
          return {
            done: Promise.resolve(
              'Nothing to backfill: every Discord message of this conversation is already on Zulip.',
            ),
          };
        });

        await send('@**Immich** mirror-backfill', { streamId: 120, topic: 'general chat' });
        await new Promise((resolve) => setImmediate(resolve));

        expect(replies()).toEqual([
          { stream: 120, topic: 'general chat', content: ACK },
          {
            stream: 120,
            topic: 'general chat',
            content: 'Nothing to backfill: every Discord message of this conversation is already on Zulip.',
          },
        ]);
      });

      it('should answer a refusal', async () => {
        mirrorLinksMock.backfill.mockResolvedValue({
          reply: 'This topic is not linked with a Discord channel or thread, so there is nothing to backfill from.',
        });

        await send('@**Immich** mirror-backfill', { streamId: 120, topic: 'lunch' });

        expect(replies()).toEqual([
          {
            stream: 120,
            topic: 'lunch',
            content: 'This topic is not linked with a Discord channel or thread, so there is nothing to backfill from.',
          },
        ]);
      });

      it('should take it from administrators and owners only', async () => {
        zulipMock.getUser.mockResolvedValue({ ...ADMIN, role: 400 });

        await send('@**Immich** mirror-backfill', { streamId: 120 });

        expect(mirrorLinksMock.backfill).not.toHaveBeenCalled();
        expect(replies().map(({ content }) => content)).toEqual([NOT_AN_ADMINISTRATOR]);
      });

      it('should answer an argument with the usage', async () => {
        await send('@**Immich** mirror-backfill all', { streamId: 120 });

        expect(mirrorLinksMock.backfill).not.toHaveBeenCalled();
        expect(replies().map(({ content }) => content)).toEqual(['Usage: `mirror-backfill`']);
      });

      it('should log an outcome it cannot post', async () => {
        mirrorLinksMock.backfill.mockResolvedValue({ done: Promise.resolve('Nothing to backfill.') });
        zulipMock.sendMessage.mockRejectedValue(new Error('Zulip is down'));

        await send('@**Immich** mirror-backfill', { streamId: 120 });
        await new Promise((resolve) => setImmediate(resolve));

        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'Could not post the outcome of the Zulip command mirror-backfill',
          expect.any(Error),
        );
      });
    });

    it("should unlink the sender's own account in a team stream", async () => {
      await send('@**Immich** discord-unlink');

      expect(zulipMock.getUser).not.toHaveBeenCalled();
      expect(mirrorLinksMock.unlinkIdentity).toHaveBeenCalledExactlyOnceWith({ zulipUserId: 12 }, 'zulip');
      expect(replies().map(({ content }) => content)).toEqual(['Unlinked.']);
    });

    describe('direct messages', () => {
      const direct = (content: string, overrides: Partial<ZulipReceivedMessage> = {}) =>
        send(content, { type: 'private', streamId: undefined, topic: '', ...overrides });
      const answers = () => zulipMock.sendDirectMessage.mock.calls;

      it.each(['link ABCD2345', 'Link abcd-2345', 'discord-link ABCD2345', '@**Immich** link ABCD2345'])(
        'should redeem a code sent as %j, answering the sender alone',
        async (content) => {
          await direct(content);

          expect(mirrorLinksMock.redeemIdentityCode).toHaveBeenCalledExactlyOnceWith(
            { id: 12, fullName: 'Alice' },
            content.split(' ').at(-1),
          );
          expect(answers()).toEqual([[[12], 'Linked.']]);
          expect(zulipMock.sendMessage).not.toHaveBeenCalled();
        },
      );

      it.each(['unlink', 'discord-unlink', '@**Immich** unlink'])('should unlink the sender on %j', async (content) => {
        await direct(content);

        expect(mirrorLinksMock.unlinkIdentity).toHaveBeenCalledExactlyOnceWith({ zulipUserId: 12 }, 'zulip');
        expect(answers()).toEqual([[[12], 'Unlinked.']]);
      });

      it.each(['hello', 'link', 'link me the doc', 'unlink it please', 'link "ABCD', ''])(
        'should say nothing to %j',
        async (content) => {
          await direct(content);

          expect(mirrorLinksMock.redeemIdentityCode).not.toHaveBeenCalled();
          expect(mirrorLinksMock.unlinkIdentity).not.toHaveBeenCalled();
          expect(answers()).toEqual([]);
          expect(zulipMock.sendMessage).not.toHaveBeenCalled();
        },
      );

      it.each(['unlink', 'link ABCD2345'])(
        'should take no %j that does not mention the bot in a group direct message',
        async (content) => {
          await direct(content, { recipientIds: [12, 99, 13] });

          expect(mirrorLinksMock.redeemIdentityCode).not.toHaveBeenCalled();
          expect(mirrorLinksMock.unlinkIdentity).not.toHaveBeenCalled();
          expect(answers()).toEqual([]);
        },
      );

      it('should take a command that mentions the bot in a group direct message, answering the sender alone', async () => {
        await direct('@**Immich** unlink', { recipientIds: [12, 99, 13] });

        expect(mirrorLinksMock.unlinkIdentity).toHaveBeenCalledExactlyOnceWith({ zulipUserId: 12 }, 'zulip');
        expect(answers()).toEqual([[[12], 'Unlinked.']]);
      });

      it('should take a command without a mention in a direct message with the bot alone', async () => {
        await direct('unlink', { recipientIds: [12, 99] });

        expect(mirrorLinksMock.unlinkIdentity).toHaveBeenCalledOnce();
      });

      it('should answer a failure, and log one it cannot answer', async () => {
        mirrorLinksMock.redeemIdentityCode.mockRejectedValue(new Error('database is down'));
        await direct('link ABCD2345');
        expect(answers()).toEqual([[[12], '`link` failed: `database is down`']]);

        zulipMock.sendDirectMessage.mockRejectedValue(new Error('Zulip is down'));
        await expect(direct('unlink')).resolves.toBeUndefined();
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'Could not answer the Zulip direct message 500',
          expect.any(Error),
        );
      });
    });
  });

  describe('expanders', () => {
    const ALICE = 'Alice on Zulip (user 12)';
    const NOT_SUBSCRIBED =
      '⚠ I am not subscribed to this stream, so none of its messages reach me and nothing is expanded here until an administrator subscribes me.';
    const NOT_SUBSCRIBED_MARK = ' (⚠ I am not subscribed, so nothing reaches me there)';
    const HEADER = 'Groups are on in:';
    const USAGE = 'Usage: `expanders <on <group>|off [group]|list>`';
    const NO_GROUP = (name: string) => `There is no expander group \`${name}\`; the groups are \`fhs\`, \`immich\`.`;
    const GITHUB: Record<string, string> = {
      'immich-app/immich': 'immich-app/immich',
      'immich-app/static-pages': 'immich-app/static-pages',
      'futo-org/fhs-core': 'futo-org/fhs-core',
      'futo-org/fhs-web': 'futo-org/fhs-web',
      'futo-org/grayjay': 'futo-org/Grayjay',
    };
    const GITLAB: Record<string, string> = {
      'videostreaming/grayjay': 'videostreaming/Grayjay',
      'videostreaming/plugins/kick': 'videostreaming/plugins/kick',
    };
    const group = (name: string, repositories: string[]): ZulipExpanderGroup => ({
      name,
      repositories,
      createdBy: 'migration',
      createdAt: new Date(0),
    });
    const row = (streamId: number, groupName = 'immich'): ZulipExpander => ({
      streamId,
      groupName,
      createdBy: 'migration',
      createdAt: new Date(0),
    });
    const contents = () => replies().map(({ content }) => content);
    const stored = () => database.expanders.map(({ streamId, groupName }) => `${streamId}:${groupName}`).sort();
    const repositoriesOf = (name: string) => database.groups.find((candidate) => candidate.name === name)?.repositories;
    const reset = async () => {
      database.groups.splice(0);
      database.expanders.splice(0);
      await zulipExpanders.init();
    };

    beforeEach(async () => {
      zulipMock.getUser.mockResolvedValue(ADMIN);
      zulipMock.getSubscriptions.mockResolvedValue([{ streamId: 107 }, { streamId: 120 }]);
      githubServiceMock.getRepositoryName.mockImplementation((fullName) =>
        Promise.resolve(GITHUB[fullName.toLowerCase()]),
      );
      gitlabMock.getProjectPath.mockImplementation((path) => Promise.resolve(GITLAB[path.toLowerCase()]));
      database.groups.push(
        group('immich', ['immich-app/immich']),
        group('fhs', ['futo-org/fhs-core', 'futo-org/fhs-web']),
      );
      database.expanders.push(row(107));
      await zulipExpanders.init();
    });

    describe('in direct messages', () => {
      const direct = (content: string, recipientIds: number[]) =>
        send(content, { type: 'private', streamId: undefined, topic: '', recipientIds });
      const answers = () => zulipMock.sendDirectMessage.mock.calls;
      const conversations = () =>
        database.conversations.map(({ conversation, groupName }) => `${conversation}:${groupName}`);

      it('should turn a group on in a conversation with the bot alone, answering the sender', async () => {
        await direct('expanders on fhs', [12, BOT.userId]);

        expect(conversations()).toEqual(['7,12:fhs']);
        expect(stored()).toEqual(['107:immich']);
        expect(zulipMock.getSubscriptions).not.toHaveBeenCalled();
        expect(answers()).toEqual([
          [[12], 'Turned on the group `fhs` (`futo-org/fhs-core`, `futo-org/fhs-web`) in this conversation.'],
        ]);
      });

      it('should take expanders in a group conversation only when they mention the bot, answering everyone', async () => {
        await direct('expanders on fhs', [12, BOT.userId, 13]);
        expect(conversations()).toEqual([]);

        await direct('@**Immich** expanders on fhs', [12, BOT.userId, 13]);
        await direct('@**Immich** expanders off immich', [13, BOT.userId, 12]);
        await direct('@**Immich** expanders off', [12, BOT.userId, 13]);

        expect(answers().map(([recipients]) => recipients)).toEqual([
          [12, 13],
          [13, 12],
          [12, 13],
        ]);
        expect(answers().map(([, content]) => content)).toEqual([
          'Turned on the group `fhs` (`futo-org/fhs-core`, `futo-org/fhs-web`) in this conversation.',
          'Nothing changed: the group `immich` was not on in this conversation.',
          'Turned off every group in this conversation (`fhs`): links still expand here, a bare `#1234` no longer does.',
        ]);
        expect(conversations()).toEqual([]);
      });

      it('should answer the usage, and change nothing, for expanders given too many arguments', async () => {
        await direct('expanders on fhs', [12, BOT.userId]);
        zulipMock.sendDirectMessage.mockClear();

        await direct('expanders off fhs immich', [12, BOT.userId]);

        expect(conversations()).toEqual(['7,12:fhs']);
        expect(answers()).toEqual([[[12], expect.stringContaining('expanders <on <group>|off [group]|list>')]]);
      });

      it.each([
        { content: 'help', recipientIds: [12, BOT.userId] },
        { content: '@**Immich**', recipientIds: [12, BOT.userId, 13] },
      ])(
        'should answer $content with the direct message commands, to the sender alone',
        async ({ content, recipientIds }) => {
          await direct(content, recipientIds);

          expect(answers()).toEqual([[[12], DIRECT_MESSAGE_HELP]]);
          expect(zulipMock.getUser).not.toHaveBeenCalled();
        },
      );
    });

    describe('on', () => {
      it('should turn a group on in this stream, in any stream, and store who did it', async () => {
        await send('@**Immich** expanders on immich', { streamId: 120, topic: 'setup' });

        expect(replies()).toEqual([
          {
            stream: 120,
            topic: 'setup',
            content: 'Turned on the group `immich` (`immich-app/immich`) in this stream.',
          },
        ]);
        expect(database.expanders).toEqual([
          row(107),
          { streamId: 120, groupName: 'immich', createdBy: ALICE, createdAt: expect.any(Date) },
        ]);
        expect(zulipExpanders.isEnabled(120)).toBe(true);
      });

      it('should add a second group, whatever its case, after the first', async () => {
        await send('@**Immich** expanders on FHS');

        expect(contents()).toEqual([
          'Turned on the group `fhs` (`futo-org/fhs-core`, `futo-org/fhs-web`) in this stream.',
        ]);
        expect(stored()).toEqual(['107:fhs', '107:immich']);
        expect(zulipExpanders.getPlaceGroups(107)).toEqual(['immich', 'fhs']);
      });

      it('should say when the group was already on, whatever the case of the command', async () => {
        await send('@**Immich** EXPANDERS ON Immich');

        expect(contents()).toEqual(['Nothing changed: the group `immich` was already on in this stream.']);
        expect(stored()).toEqual(['107:immich']);
      });

      it('should name the groups there are when the group is unknown, and change nothing', async () => {
        await send('@**Immich** expanders on nope', { streamId: 120 });

        expect(contents()).toEqual([NO_GROUP('nope')]);
        expect(stored()).toEqual(['107:immich']);
        expect(zulipMock.getSubscriptions).not.toHaveBeenCalled();
      });

      it('should say how to create a group when there is none', async () => {
        await reset();

        await send('@**Immich** expanders on immich', { streamId: 120 });

        expect(contents()).toEqual([
          'There is no expander group `immich`; `expander-group create <group> <repository>…` creates one.',
        ]);
        expect(database.expanders).toEqual([]);
      });

      it('should warn when it turns a group on in a stream the bot is not subscribed to, and not when it turns it off', async () => {
        await send('@**Immich** expanders on immich', { streamId: 130 });
        await send('@**Immich** expanders on immich', { streamId: 130 });
        await send('@**Immich** expanders off', { streamId: 130 });

        expect(contents()).toEqual([
          `Turned on the group \`immich\` (\`immich-app/immich\`) in this stream.\n${NOT_SUBSCRIBED}`,
          `Nothing changed: the group \`immich\` was already on in this stream.\n${NOT_SUBSCRIBED}`,
          'Turned off every group in this stream (`immich`): links still expand here, a bare `#1234` no longer does.',
        ]);
        expect(zulipMock.getSubscriptions).toHaveBeenCalledTimes(2);
      });

      it('should change nothing when the subscriptions cannot be read, and say so', async () => {
        zulipMock.getSubscriptions.mockRejectedValue(new Error('Zulip is down'));

        await send('@**Immich** expanders on immich', { streamId: 120 });

        expect(contents()).toEqual(['`expanders` failed: `Zulip is down`']);
        expect(stored()).toEqual(['107:immich']);
        expect(zulipExpanders.isEnabled(120)).toBe(false);
      });

      it('should keep the cache as it was when the table refuses the change', async () => {
        vitest.spyOn(database, 'addZulipExpander').mockRejectedValue(new Error('connection terminated'));

        await send('@**Immich** expanders on immich', { streamId: 120 });

        expect(contents()).toEqual(['`expanders` failed: `connection terminated`']);
        expect(zulipExpanders.list()).toEqual([107]);
      });
    });

    describe('off', () => {
      it('should turn every group off without a group, and then say it was already off', async () => {
        await send('@**Immich** expanders on fhs');
        await send('@**Immich** expanders Off');
        await send('@**Immich** expanders off');

        expect(contents().slice(1)).toEqual([
          'Turned off every group in this stream (`immich`, `fhs`): links still expand here, a bare `#1234` no longer does.',
          'Nothing changed: no group was on in this stream.',
        ]);
        expect(stored()).toEqual([]);
        expect(zulipExpanders.isEnabled(107)).toBe(false);
      });

      it('should turn one group off and keep the others on', async () => {
        await send('@**Immich** expanders on fhs');
        await send('@**Immich** expanders off IMMICH');
        await send('@**Immich** expanders off fhs');

        expect(contents().slice(1)).toEqual([
          'Turned off the group `immich` in this stream.',
          'Turned off every group in this stream (`fhs`): links still expand here, a bare `#1234` no longer does.',
        ]);
        expect(stored()).toEqual([]);
      });

      it('should say when the group was not on in this stream', async () => {
        await send('@**Immich** expanders off fhs');

        expect(contents()).toEqual(['Nothing changed: the group `fhs` was not on in this stream.']);
        expect(stored()).toEqual(['107:immich']);
      });

      it('should change this stream only', async () => {
        await send('@**Immich** expanders on immich', { streamId: 120 });
        await send('@**Immich** expanders off', { streamId: 107 });

        expect(zulipExpanders.list()).toEqual([120]);
        expect(stored()).toEqual(['120:immich']);
      });
    });

    describe('list', () => {
      it('should say when no group is on in any stream, and point to the groups', async () => {
        await send('@**Immich** expanders off');
        await send('@**Immich** expanders list');

        expect(contents()[1]).toBe('No group is on in any stream; `expander-group list` lists the groups.');
        expect(zulipMock.getStream).not.toHaveBeenCalled();
      });

      it('should list every stream by name and ID with its groups, and mark one the bot is not subscribed to', async () => {
        database.expanders.push(row(54), row(130, 'fhs'), row(140), row(107, 'fhs'));
        await zulipExpanders.init();
        const names: Record<number, string> = { 54: 'Immich', 107: 'immich-general', 130: '@**all** news' };
        zulipMock.getStream.mockImplementation((streamId) =>
          streamId === 140
            ? Promise.reject(new Error('Invalid channel ID'))
            : Promise.resolve({ streamId, name: names[streamId], inviteOnly: false }),
        );
        zulipMock.getSubscriptions.mockResolvedValue([{ streamId: 54 }, { streamId: 107 }]);

        await send('@**Immich** expanders list', { streamId: 120 });

        expect(contents()).toEqual([
          [
            HEADER,
            '- **#Immich** (54): `immich`',
            '- **#immich-general** (107): `immich`, `fhs`',
            '- **#@​**all** news** (130)' + NOT_SUBSCRIBED_MARK + ': `fhs`',
            `- stream 140${NOT_SUBSCRIBED_MARK}: \`immich\``,
          ].join('\n'),
        ]);
      });

      it('should list without the subscription marks when the subscriptions cannot be read', async () => {
        zulipMock.getStream.mockResolvedValue({ streamId: 107, name: 'immich-general', inviteOnly: true });
        zulipMock.getSubscriptions.mockRejectedValue(new Error('Zulip is down'));

        await send('@**Immich** expanders list');

        expect(contents()).toEqual([[HEADER, '- **#immich-general** (107): `immich`'].join('\n')]);
      });
    });

    it.each([
      ['an owner', 100],
      ['an administrator', 200],
      ['a moderator', 300],
      ['a member', 400],
      ['a guest', 600],
    ])('should take the expanders command from %s: %s, in any stream', async (_, role) => {
      zulipMock.getUser.mockResolvedValue({ ...ADMIN, role });

      await send('@**Immich** expanders on immich', { streamId: 120 });
      await send('@**Immich** expanders off', { streamId: 107 });
      await send('@**Immich** expanders list', { streamId: 54 });

      expect(zulipMock.getUser).not.toHaveBeenCalled();
      expect(stored()).toEqual(['120:immich']);
      expect(contents()).toHaveLength(3);
    });

    it.each([
      '@**Immich** expanders',
      '@**Immich** expanders toggle',
      '@**Immich** expanders on',
      '@**Immich** expanders default',
      '@**Immich** expanders default fhs-core',
      '@**Immich** expanders list all',
      '@**Immich** expanders on immich fhs',
      '@**Immich** expanders off immich fhs',
    ])('should answer %j with the usage and change nothing', async (content) => {
      await send(content, { streamId: 120 });

      expect(contents()).toEqual([USAGE]);
      expect(stored()).toEqual(['107:immich']);
      expect(zulipMock.getSubscriptions).not.toHaveBeenCalled();
    });

    describe('expander-group', () => {
      const REPOSITORY_FORMS =
        '`owner/repo` on GitHub or `gitlab.futo.org/namespace/project`, or `owner/*` or `gitlab.futo.org/namespace/*` for every repository of that owner or group, kept up to date';
      const GROUP_USAGE =
        'Usage: `expander-group <create|add|remove> <group> <repository>… | delete <group> | info <group> | list`';

      describe('create', () => {
        it('should create a group with the names GitHub spells, from names and URLs, without duplicates', async () => {
          await send(
            '@**Immich** expander-group create Apps futo-org/grayjay https://github.com/immich-app/static-pages/ FUTO-ORG/GRAYJAY',
          );

          expect(contents()).toEqual([
            'Created the expander group `apps` with `futo-org/Grayjay`, `immich-app/static-pages`. Turn it on in a stream with `expanders on apps`.',
          ]);
          expect(database.groups.find(({ name }) => name === 'apps')).toEqual({
            name: 'apps',
            repositories: ['futo-org/Grayjay', 'immich-app/static-pages'],
            createdBy: ALICE,
            createdAt: expect.any(Date),
          });
          expect(zulipExpanders.getGroup('apps')).toEqual({
            name: 'apps',
            repositories: ['futo-org/Grayjay', 'immich-app/static-pages'],
          });
        });

        it.each(['-bad', 'a.b', 'a'.repeat(33), 'ünïcode'])('should refuse %j as a name', async (name) => {
          await send(`@**Immich** expander-group create ${name} immich-app/immich`);

          expect(contents()).toEqual([
            `\`${name}\` cannot name a group: use up to 32 lowercase letters, digits, \`-\` and \`_\`, starting with a letter or digit.`,
          ]);
          expect(githubServiceMock.getRepositoryName).not.toHaveBeenCalled();
          expect(database.groups).toHaveLength(2);
        });

        it.each([
          ['its name with the host', 'gitlab.futo.org/videostreaming/grayjay'],
          ['its URL', 'https://gitlab.futo.org/videostreaming/grayjay'],
          ['the URL of a page inside it', 'https://gitlab.futo.org/videostreaming/grayjay/-/issues/3'],
        ])('should create a group with a GitLab project given by %s, as GitLab spells it', async (_, given) => {
          await send(`@**Immich** expander-group create apps ${given}`);

          expect(gitlabMock.getProjectPath).toHaveBeenCalledExactlyOnceWith('videostreaming/grayjay');
          expect(githubServiceMock.getRepositoryName).not.toHaveBeenCalled();
          expect(contents()).toEqual([
            'Created the expander group `apps` with `gitlab.futo.org/videostreaming/Grayjay`. Turn it on in a stream with `expanders on apps`.',
          ]);
          expect(repositoriesOf('apps')).toEqual(['gitlab.futo.org/videostreaming/Grayjay']);
        });

        it('should take GitLab projects in nested namespaces, and GitHub and GitLab in one command', async () => {
          await send(
            '@**Immich** expander-group create apps futo-org/grayjay gitlab.futo.org/videostreaming/plugins/kick GITLAB.futo.org/videostreaming/Grayjay',
          );

          expect(gitlabMock.getProjectPath).toHaveBeenCalledWith('videostreaming/plugins/kick');
          expect(gitlabMock.getProjectPath).toHaveBeenCalledWith('videostreaming/Grayjay');
          expect(githubServiceMock.getRepositoryName).toHaveBeenCalledExactlyOnceWith('futo-org/grayjay');
          expect(repositoriesOf('apps')).toEqual([
            'futo-org/Grayjay',
            'gitlab.futo.org/videostreaming/plugins/kick',
            'gitlab.futo.org/videostreaming/Grayjay',
          ]);
        });

        it('should refuse the whole command when GitLab does not know a project', async () => {
          await send('@**Immich** expander-group create apps immich-app/immich gitlab.futo.org/videostreaming/nope');

          expect(contents()).toEqual([
            'There is no repository `gitlab.futo.org/videostreaming/nope`, or I cannot see it.',
          ]);
          expect(database.groups).toHaveLength(2);
        });

        it('should refuse a GitLab project without a namespace, before asking GitLab', async () => {
          await send('@**Immich** expander-group create apps gitlab.futo.org/onlyone');

          expect(contents()).toEqual([`\`gitlab.futo.org/onlyone\` is not ${REPOSITORY_FORMS}.`]);
          expect(gitlabMock.getProjectPath).not.toHaveBeenCalled();
          expect(database.groups).toHaveLength(2);
        });

        it('should refuse what is not owner/repo, before asking GitHub', async () => {
          await send('@**Immich** expander-group create apps immich');
          await send('@**Immich** expander-group create apps immich futo-org/ immich-app/immich');

          expect(contents()).toEqual([
            `\`immich\` is not ${REPOSITORY_FORMS}.`,
            `\`immich\`, \`futo-org\` are not ${REPOSITORY_FORMS}.`,
          ]);
          expect(githubServiceMock.getRepositoryName).not.toHaveBeenCalled();
          expect(database.groups).toHaveLength(2);
        });

        it('should refuse repositories GitHub does not know', async () => {
          await send('@**Immich** expander-group create apps immich-app/nope futo-org/fhs-core immich-app/gone');

          expect(contents()).toEqual([
            'There is no repository `immich-app/nope`, `immich-app/gone`, or I cannot see it.',
          ]);
          expect(database.groups).toHaveLength(2);
        });

        it('should say when GitHub cannot be asked', async () => {
          githubServiceMock.getRepositoryName.mockRejectedValue(new Error('Bad credentials'));

          await send('@**Immich** expander-group create apps immich-app/immich');

          expect(contents()).toEqual(['`expander-group` failed: `Bad credentials`']);
          expect(database.groups).toHaveLength(2);
        });

        it('should refuse a name that is taken, whatever its case', async () => {
          await send('@**Immich** expander-group create FHS immich-app/immich');

          expect(contents()).toEqual([
            'There is already an expander group `fhs`; `expander-group add fhs <repository>…` adds repositories to it.',
          ]);
          expect(repositoriesOf('fhs')).toEqual(['futo-org/fhs-core', 'futo-org/fhs-web']);
        });
      });

      describe('add', () => {
        it('should add the repositories the group lacks, as GitHub spells them', async () => {
          await send('@**Immich** expander-group add fhs futo-org/grayjay futo-org/fhs-core');

          expect(contents()).toEqual(['Added `futo-org/Grayjay` to the expander group `fhs`.']);
          expect(repositoriesOf('fhs')).toEqual(['futo-org/fhs-core', 'futo-org/fhs-web', 'futo-org/Grayjay']);
          expect(zulipExpanders.getGroup('fhs')?.repositories).toEqual([
            'futo-org/fhs-core',
            'futo-org/fhs-web',
            'futo-org/Grayjay',
          ]);
        });

        it('should say when the group has them all, without a write', async () => {
          const update = vitest.spyOn(database, 'updateZulipExpanderGroup');

          await send('@**Immich** expander-group add fhs FUTO-org/fhs-core');

          expect(contents()).toEqual(['Nothing changed: the expander group `fhs` already has `futo-org/fhs-core`.']);
          expect(update).not.toHaveBeenCalled();
        });

        it('should refuse an unknown group before asking GitHub', async () => {
          await send('@**Immich** expander-group add nope immich-app/immich');

          expect(contents()).toEqual([NO_GROUP('nope')]);
          expect(githubServiceMock.getRepositoryName).not.toHaveBeenCalled();
        });

        it('should add a GitLab project as GitLab spells it', async () => {
          await send('@**Immich** expander-group add fhs https://gitlab.futo.org/videostreaming/grayjay.git');

          expect(gitlabMock.getProjectPath).toHaveBeenCalledExactlyOnceWith('videostreaming/grayjay');
          expect(contents()).toEqual(['Added `gitlab.futo.org/videostreaming/Grayjay` to the expander group `fhs`.']);
          expect(repositoriesOf('fhs')).toEqual([
            'futo-org/fhs-core',
            'futo-org/fhs-web',
            'gitlab.futo.org/videostreaming/Grayjay',
          ]);
        });

        it('should refuse a repository GitHub does not know', async () => {
          await send('@**Immich** expander-group add fhs futo-org/nope');

          expect(contents()).toEqual(['There is no repository `futo-org/nope`, or I cannot see it.']);
          expect(repositoriesOf('fhs')).toEqual(['futo-org/fhs-core', 'futo-org/fhs-web']);
        });
      });

      describe('remove', () => {
        it('should remove a repository given in any case or as a URL, without asking GitHub', async () => {
          await send('@**Immich** expander-group remove fhs https://github.com/futo-org/FHS-web');

          expect(contents()).toEqual(['Removed `futo-org/fhs-web` from the expander group `fhs`.']);
          expect(repositoriesOf('fhs')).toEqual(['futo-org/fhs-core']);
          expect(githubServiceMock.getRepositoryName).not.toHaveBeenCalled();
        });

        it('should say when the group has none of them', async () => {
          await send('@**Immich** expander-group remove fhs immich-app/immich');

          expect(contents()).toEqual(['Nothing changed: the expander group `fhs` has none of `immich-app/immich`.']);
          expect(repositoriesOf('fhs')).toEqual(['futo-org/fhs-core', 'futo-org/fhs-web']);
        });

        it('should remove a GitLab project given as its URL, without asking GitLab', async () => {
          database.groups.push(group('apps', ['immich-app/static-pages', 'gitlab.futo.org/videostreaming/Grayjay']));
          await zulipExpanders.init();

          await send(
            '@**Immich** expander-group remove apps https://gitlab.futo.org/videostreaming/grayjay/-/merge_requests/5',
          );

          expect(contents()).toEqual([
            'Removed `gitlab.futo.org/videostreaming/Grayjay` from the expander group `apps`.',
          ]);
          expect(repositoriesOf('apps')).toEqual(['immich-app/static-pages']);
          expect(gitlabMock.getProjectPath).not.toHaveBeenCalled();
        });

        it('should refuse to leave a group with no repository', async () => {
          await send('@**Immich** expander-group remove immich immich-app/immich');

          expect(contents()).toEqual([
            'That would leave the expander group `immich` with no repository; `expander-group delete immich` deletes it.',
          ]);
          expect(repositoriesOf('immich')).toEqual(['immich-app/immich']);
          expect(zulipExpanders.getGroup('immich')?.repositories).toEqual(['immich-app/immich']);
        });

        it('should refuse an unknown group', async () => {
          await send('@**Immich** expander-group remove nope immich-app/immich');

          expect(contents()).toEqual([NO_GROUP('nope')]);
        });
      });

      describe('patterns', () => {
        const IMMICH_APP = Array.from(
          { length: 33 },
          (_, index) => `immich-app/repo-${String(index).padStart(2, '0')}`,
        );

        const ACK = (patterns: string) => `Reading the repositories of ${patterns}, this can take a while…`;
        const sendAndFinish = async (content: string, overrides: Partial<ZulipReceivedMessage> = {}) => {
          await send(content, overrides);
          await flush();
        };

        beforeEach(() => {
          githubMock.getOwnerRepositories.mockImplementation((owner: string) =>
            Promise.resolve(
              owner.toLowerCase() === 'immich-app' ? { owner: 'immich-app', repositories: IMMICH_APP } : undefined,
            ),
          );
          gitlabMock.getGroupProjects.mockImplementation((path: string) =>
            Promise.resolve(
              path.toLowerCase() === 'videostreaming'
                ? { path: 'videostreaming', projects: ['videostreaming/grayjay'] }
                : undefined,
            ),
          );
        });

        it('should create a group of patterns, as GitHub and GitLab spell them', async () => {
          await sendAndFinish(
            '@**Immich** expander-group create orgs IMMICH-APP/* https://gitlab.futo.org/videostreaming/*',
          );

          expect(contents()).toEqual([
            ACK('`IMMICH-APP/*`, `gitlab.futo.org/videostreaming/*`'),
            'Created the expander group `orgs` with `immich-app/*` (33 repositories), `gitlab.futo.org/videostreaming/*` (1 repository). Turn it on in a stream with `expanders on orgs`.',
          ]);
          expect(database.groups.find(({ name }) => name === 'orgs')?.repositories).toEqual([
            'immich-app/*',
            'gitlab.futo.org/videostreaming/*',
          ]);
          expect(githubServiceMock.getRepositoryName).not.toHaveBeenCalled();
        });

        it('should add a pattern beside the repositories a group names', async () => {
          await sendAndFinish('@**Immich** expander-group add immich immich-app/*');

          expect(contents()).toEqual([
            ACK('`immich-app/*`'),
            'Added `immich-app/*` (33 repositories) to the expander group `immich`.',
          ]);
          expect(database.groups.find(({ name }) => name === 'immich')?.repositories).toEqual([
            'immich-app/immich',
            'immich-app/*',
          ]);
        });

        it('should refuse an owner or group that is not there, or cannot be seen', async () => {
          await sendAndFinish('@**Immich** expander-group add immich nobody/* gitlab.futo.org/nothing/*');

          expect(contents()).toEqual([
            ACK('`nobody/*`, `gitlab.futo.org/nothing/*`'),
            'There is no repository `nobody/*`, `gitlab.futo.org/nothing/*`, or I cannot see it.',
          ]);
        });

        it.each(['a/b/*', 'gitlab.futo.org/*', '*'])('should refuse the malformed pattern %s', async (pattern) => {
          await sendAndFinish(`@**Immich** expander-group add immich ${pattern}`);

          expect(contents().at(-1)).toContain('is not `owner/repo` on GitHub');
          expect(githubMock.getOwnerRepositories).not.toHaveBeenCalled();
          expect(gitlabMock.getGroupProjects).not.toHaveBeenCalled();
        });

        it('should remove a pattern', async () => {
          await sendAndFinish('@**Immich** expander-group add immich immich-app/*');
          await sendAndFinish('@**Immich** expander-group remove immich IMMICH-APP/*');

          expect(contents()[2]).toBe('Removed `immich-app/*` from the expander group `immich`.');
          expect(database.groups.find(({ name }) => name === 'immich')?.repositories).toEqual(['immich-app/immich']);
        });

        it('should show what a pattern stands for, up to 30 repositories', async () => {
          zulipMock.getSubscriptions.mockResolvedValue([]);
          zulipMock.getStream.mockResolvedValue({ streamId: 107, name: 'immich-general', inviteOnly: false });
          await sendAndFinish('@**Immich** expander-group add immich immich-app/*');
          await send('@**Immich** expander-group info immich');

          expect(contents()[2].split('\n').slice(0, 3)).toEqual([
            'Expander group `immich`:',
            '- Repositories: `immich-app/immich`, `immich-app/*` (33 repositories)',
            `- \`immich-app/*\`: ${IMMICH_APP.slice(0, 30)
              .map((repository) => `\`${repository}\``)
              .join(', ')} and 3 more`,
          ]);
        });

        it('should say when a pattern has not been read yet', async () => {
          database.groups.push({
            name: 'unread',
            repositories: ['gitlab.futo.org/elsewhere/*'],
            createdBy: 'x',
            createdAt: new Date(0),
          });
          gitlabMock.getGroupProjects.mockRejectedValue(new Error('GitLab is down'));
          await zulipExpanders.init();

          await send('@**Immich** expander-group info unread');

          expect(contents()[0].split('\n')[2]).toBe(
            '- `gitlab.futo.org/elsewhere/*`: not read yet, so none of its repositories count until the hourly read finds them',
          );
        });

        it('should count the repositories a pattern stands for', async () => {
          await sendAndFinish('@**Immich** expander-group create orgs immich-app/*');
          await send('@**Immich** expander-group list');

          expect(contents()[2].split('\n')).toContain('- `orgs`: 33 repositories; on in 0 streams');
        });

        it('should turn a group of patterns on and list it as any other', async () => {
          await sendAndFinish('@**Immich** expander-group create orgs immich-app/*');
          zulipMock.getSubscriptions.mockResolvedValue([{ streamId: 120 }]);
          zulipMock.getStream.mockResolvedValue({ streamId: 120, name: 'orgs', inviteOnly: false });
          await send('@**Immich** expanders on orgs', { streamId: 120 });
          await send('@**Immich** expanders list', { streamId: 120 });

          expect(contents()[2]).toBe('Turned on the group `orgs` (`immich-app/*`) in this stream.');
          expect(contents()[3].split('\n')).toContain('- **#orgs** (120): `orgs`');
        });

        it('should refuse another change of the groups while a pattern is read', async () => {
          let finish = () => {};
          githubMock.getOwnerRepositories.mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                finish = () => resolve({ owner: 'immich-app', repositories: IMMICH_APP });
              }),
          );

          await send('@**Immich** expander-group add immich immich-app/*');
          await send('@**Immich** expander-group delete fhs');
          finish();
          await flush();

          expect(contents()).toEqual([
            ACK('`immich-app/*`'),
            '`expander-group` is already running; wait for it to finish.',
            'Added `immich-app/*` (33 repositories) to the expander group `immich`.',
          ]);
          expect(database.groups.map(({ name }) => name).sort()).toEqual(['fhs', 'immich']);
        });
      });

      describe('list', () => {
        it('should say there is no group yet', async () => {
          await reset();

          await send('@**Immich** expander-group list');

          expect(contents()).toEqual([
            'There is no expander group yet; `expander-group create <group> <repository>…` creates one.',
          ]);
        });

        it('should list every group with its size and how many streams it is on in', async () => {
          database.expanders.push(row(54));
          await zulipExpanders.init();

          await send('@**Immich** expander-group list');

          expect(contents()).toEqual([
            [
              'Expander groups:',
              '- `fhs`: 2 repositories; on in 0 streams',
              '- `immich`: 1 repository; on in 2 streams',
              '',
              '`expander-group info <group>` shows one in full.',
            ].join('\n'),
          ]);
          expect(zulipMock.getStream).not.toHaveBeenCalled();
        });
      });

      describe('info', () => {
        it('should show every repository and the streams by name', async () => {
          database.expanders.push(row(140));
          await zulipExpanders.init();
          zulipMock.getStream.mockImplementation((streamId) =>
            streamId === 140
              ? Promise.reject(new Error('Invalid channel ID'))
              : Promise.resolve({ streamId, name: 'immich-general', inviteOnly: false }),
          );
          zulipMock.getSubscriptions.mockResolvedValue([{ streamId: 107 }]);

          await send('@**Immich** expander-group info IMMICH');

          expect(contents()).toEqual([
            [
              'Expander group `immich`:',
              '- Repositories: `immich-app/immich`',
              `- On in: **#immich-general** (107), stream 140${NOT_SUBSCRIBED_MARK}`,
            ].join('\n'),
          ]);
        });

        it('should say when a group is on in no stream', async () => {
          await send('@**Immich** expander-group info fhs');

          expect(contents()).toEqual([
            [
              'Expander group `fhs`:',
              '- Repositories: `futo-org/fhs-core`, `futo-org/fhs-web`',
              '- On in no stream; `expanders on fhs` turns it on in the stream it is given in.',
            ].join('\n'),
          ]);
          expect(zulipMock.getStream).not.toHaveBeenCalled();
        });

        it('should refuse an unknown group', async () => {
          await send('@**Immich** expander-group info nope');

          expect(contents()).toEqual(['There is no expander group `nope`; the groups are `fhs`, `immich`.']);
        });
      });

      describe('delete', () => {
        it('should delete a group and turn it off in every stream', async () => {
          database.expanders.push(row(107, 'fhs'), row(120, 'fhs'));
          await zulipExpanders.init();

          await send('@**Immich** expander-group delete FHS');

          expect(contents()).toEqual(['Deleted the expander group `fhs` and turned it off in 2 streams.']);
          expect(database.groups.map(({ name }) => name)).toEqual(['immich']);
          expect(stored()).toEqual(['107:immich']);
          expect(zulipExpanders.getGroup('fhs')).toBeUndefined();
          expect(zulipExpanders.isEnabled(120)).toBe(false);
          expect(zulipExpanders.getPlaceGroups(107)).toEqual(['immich']);
        });

        it('should count one stream', async () => {
          await send('@**Immich** expander-group delete immich');

          expect(contents()).toEqual(['Deleted the expander group `immich` and turned it off in 1 stream.']);
          expect(zulipExpanders.list()).toEqual([]);
        });

        it('should delete a group that is on nowhere', async () => {
          await send('@**Immich** expander-group delete fhs');

          expect(contents()).toEqual(['Deleted the expander group `fhs`.']);
        });

        it('should refuse an unknown group', async () => {
          await send('@**Immich** expander-group delete nope');

          expect(contents()).toEqual([NO_GROUP('nope')]);
        });
      });

      it.each([
        '@**Immich** expander-group',
        '@**Immich** expander-group create',
        '@**Immich** expander-group create apps',
        '@**Immich** expander-group add fhs',
        '@**Immich** expander-group remove fhs',
        '@**Immich** expander-group threshold fhs',
        '@**Immich** expander-group threshold fhs 5',
        '@**Immich** expander-group delete fhs extra',
        '@**Immich** expander-group rename fhs apps',
        '@**Immich** expander-group info',
        '@**Immich** expander-group info fhs extra',
        '@**Immich** expander-group list fhs',
      ])('should answer %j with the usage and change nothing', async (content) => {
        await send(content);

        expect(contents()).toEqual([GROUP_USAGE]);
        expect(database.groups.map(({ name }) => name).sort()).toEqual(['fhs', 'immich']);
        expect(githubServiceMock.getRepositoryName).not.toHaveBeenCalled();
      });

      it.each([
        ['a moderator', 300],
        ['a member', 400],
        ['a guest', 600],
      ])('should take it from %s, in any stream', async (_, role) => {
        zulipMock.getUser.mockResolvedValue({ ...ADMIN, role });

        await send('@**Immich** expander-group create apps immich-app/immich', { streamId: 54 });
        await send('@**Immich** expander-group delete fhs', { streamId: 120 });

        expect(zulipMock.getUser).not.toHaveBeenCalled();
        expect(contents()).toHaveLength(2);
        expect(database.groups.map(({ name }) => name).sort()).toEqual(['apps', 'immich']);
      });
    });
  });

  describe('stickers', () => {
    const contents = () => replies().map(({ content }) => content);
    const UPLOAD = '/user_uploads/2/ab/cdEF12/my_party.gif';

    it('should add, list, update and remove a sticker', async () => {
      await send('@**Immich** sticker-list');
      await send('@**Immich** sticker-add Party https://example.com/party.gif');
      await send('@**Immich** sticker-add party https://example.com/party2.gif');
      await send('@**Immich** sticker-list');
      await send('@**Immich** sticker-remove PARTY');
      await send('@**Immich** sticker-remove party');

      expect(contents()).toEqual([
        'There are no stickers; `sticker-add <name> <image>` adds one.',
        'Added the sticker `party`: `:party:` is answered with the image, in any stream I can see.',
        'Updated the sticker `party`: `:party:` is answered with the new image.',
        'Stickers:\n- `:party:`: `https://example.com/party2.gif`',
        'Removed the sticker `party`.',
        'There is no sticker `party`; `sticker-list` lists them.',
      ]);
      expect(chatServiceMock.setSticker).toHaveBeenCalledWith(
        'party',
        'https://example.com/party.gif',
        'Alice on Zulip (user 12)',
      );
      expect(chatServiceMock.stickers.size).toBe(0);
    });

    it.each([
      { content: `@**Immich** sticker-add party\n[my party.gif](${UPLOAD})` },
      { content: `@**Immich** sticker-add party [party.gif](${UPLOAD})` },
      { content: `@**Immich** sticker-add party ![party](${UPLOAD})` },
      { content: `@**Immich** sticker-add party ${UPLOAD}` },
    ])('should keep an attached upload as inline image markdown, shown full size: $content', async ({ content }) => {
      await send(content);

      expect(chatServiceMock.stickers.get('party')).toBe(`![party](${UPLOAD})`);
      expect(contents()).toEqual([
        'Added the sticker `party`: `:party:` is answered with the image, in any stream I can see.',
      ]);
    });

    it.each([
      '@**Immich** sticker-add',
      '@**Immich** sticker-add party',
      '@**Immich** sticker-add party not-a-url',
      '@**Immich** sticker-add party https://example.com/a.gif https://example.com/b.gif',
      '@**Immich** sticker-add party https://example.com/@**all**.gif',
      '@**Immich** sticker-remove',
      '@**Immich** sticker-remove party extra',
      '@**Immich** sticker-list party',
    ])('should answer %j with the usage', async (content) => {
      await send(content);

      expect(contents()).toEqual([expect.stringMatching(/^Usage: `sticker-(add|remove|list)/)]);
      expect(chatServiceMock.setSticker).not.toHaveBeenCalled();
    });

    it.each(['"two words"', ':party:', 'pärty'])('should refuse to name a sticker %s', async (name) => {
      await send(`@**Immich** sticker-add ${name} https://example.com/party.gif`);

      expect(contents()).toEqual([expect.stringContaining('cannot name a sticker: an emoji name is letters, digits')]);
      expect(chatServiceMock.setSticker).not.toHaveBeenCalled();
    });

    it('should refuse every sticker command outside the team streams, saying so', async () => {
      await send('@**Immich** sticker-add party https://example.com/party.gif', { streamId: 999 });
      await send('@**Immich** sticker-remove party', { streamId: 999 });
      await send('@**Immich** sticker-list', { streamId: 999 });

      expect(contents()).toEqual([
        '`sticker-add` is taken in the Immich team streams only.',
        '`sticker-remove` is taken in the Immich team streams only.',
        '`sticker-list` is taken in the Immich team streams only.',
      ]);
      expect(chatServiceMock.setSticker).not.toHaveBeenCalled();
    });

    it("should take a listed bot's sticker command", async () => {
      database.commandBots.push({ userId: 30, createdBy: 'Alice on Zulip (user 12)', createdAt: new Date() });
      await sut.init();

      await send('@**Immich** sticker-add party https://example.com/party.gif', fromClaude);

      expect(chatServiceMock.setSticker).toHaveBeenCalledExactlyOnceWith(
        'party',
        'https://example.com/party.gif',
        'Claude on Zulip (user 30)',
      );
    });
  });

  describe('command-bots', () => {
    const CLAUDE: ZulipAccount = { userId: 30, fullName: 'Claude', email: 'claude-bot@zulip.example.com' };
    const CLAUDE_CODE: ZulipAccount = {
      userId: 32,
      fullName: 'Claude Code',
      email: 'claude-code-bot@zulip.example.com',
    };
    const ALICE: ZulipAccount = { userId: 12, fullName: 'Alice', email: 'user12@zulip.example.com' };
    const SELF: ZulipAccount = { userId: 7, fullName: 'Immich', email: 'immich-bot@zulip.example.com' };
    const USAGE = 'Usage: `command-bots <add|remove> <bot> | list`';
    const ADDED = "I now take the commands of `Claude` (user 30), with its role checked as anyone's.";
    const REMOVED = 'I no longer take the commands of `Claude` (user 30).';
    const RSS_LIST = 'This stream is not subscribed to any RSS feed.';
    const RUNNING = '`command-bots` is already running; wait for it to finish.';
    const NOT_AN_ADMINISTRATOR =
      'Only Zulip organization administrators and owners can choose the bots whose commands I take.';
    const noUser = (echo: string) =>
      `There is no user \`${echo}\` in this organization; Zulip's own bots, such as the Notification Bot, are not in it and cannot be added.`;
    const listed = (userId: number, createdBy: string, createdAt: string) =>
      database.commandBots.push({ userId, createdBy, createdAt: new Date(createdAt) });
    const contents = () => replies().map(({ content }) => content);
    const command = (text: string) => send(`@**Immich** command-bots ${text}`, { streamId: 999 });
    const fromClaudeHere = { ...fromClaude, streamId: 999 };

    beforeEach(async () => {
      zulipMock.getUser.mockResolvedValue(ADMIN);
      zulipMock.getUsers.mockResolvedValue([ALICE, SELF, CLAUDE, CLAUDE_CODE]);
      await sut.init();
    });

    it.each([
      '30',
      '@**Claude**',
      '@_**Claude**',
      '@**Claude|30**',
      '@_**Claude|30**',
      'claude-bot@zulip.example.com',
      'CLAUDE-BOT@zulip.example.com',
      'claude',
    ])('should add the bot named %j', async (given) => {
      await command(`add ${given}`);

      expect(database.commandBots).toEqual([
        { userId: 30, createdBy: 'Alice on Zulip (user 12)', createdAt: expect.any(Date) },
      ]);
      expect(contents()).toEqual([ADDED]);
    });

    it('should add a bot mentioned by a name with a space, which the arguments split in two', async () => {
      await command('add @**Claude Code**');

      expect(database.commandBots.map(({ userId }) => userId)).toEqual([32]);
      expect(contents()).toEqual([
        "I now take the commands of `Claude Code` (user 32), with its role checked as anyone's.",
      ]);
    });

    it("should take a bot's commands from the moment it is added and ignore them once it is removed, without reading the table again", async () => {
      const read = vitest.spyOn(database, 'getZulipCommandBots');

      await send('@**Immich** rss-list', fromClaudeHere);
      await command('add @**Claude**');
      await send('@**Immich** rss-list', fromClaudeHere);
      await command('remove @**Claude**');
      await send('@**Immich** rss-list', fromClaudeHere);

      expect(contents()).toEqual([ADDED, RSS_LIST, REMOVED]);
      expect(read).not.toHaveBeenCalled();
    });

    it('should change nothing when the bot is listed already', async () => {
      await command('add Claude');
      await command('add @**Claude|30**');

      expect(database.commandBots).toHaveLength(1);
      expect(contents()).toEqual([ADDED, 'Nothing changed: I already take the commands of `Claude` (user 30).']);
    });

    it('should take the commands of a bot listed in the table but not in memory once an add finds it there', async () => {
      listed(30, 'Bob on Zulip (user 13)', '2026-10-07T12:00:00Z');

      await send('@**Immich** rss-list', fromClaudeHere);
      await command('add Claude');
      await send('@**Immich** rss-list', fromClaudeHere);

      expect(contents()).toEqual(['Nothing changed: I already take the commands of `Claude` (user 30).', RSS_LIST]);
      expect(database.commandBots).toEqual([
        { userId: 30, createdBy: 'Bob on Zulip (user 13)', createdAt: new Date('2026-10-07T12:00:00Z') },
      ]);
    });

    it("should add a person whose email ends in -bot, whose commands are ignored as a bot's until then", async () => {
      const fromRobo = { senderId: 44, senderEmail: 'robo-bot@example.org', senderFullName: 'Robo', streamId: 999 };
      zulipMock.getUsers.mockResolvedValue([{ userId: 44, fullName: 'Robo', email: 'robo-bot@example.org' }]);

      await send('@**Immich** rss-list', fromRobo);
      await command('add @**Robo**');
      await send('@**Immich** rss-list', fromRobo);

      expect(contents()).toEqual([
        "I now take the commands of `Robo` (user 44), with its role checked as anyone's.",
        RSS_LIST,
      ]);
    });

    it.each([
      [
        'a person',
        '@**Alice**',
        "`Alice` (user 12) is a person, not a bot: people's commands are always taken; only bots are added.",
      ],
      ['the bot itself', '@**Immich|7**', '`Immich` (user 7) is me: my own messages are never commands.'],
      [
        "Zulip's Notification Bot, which is not in the organization",
        '@_**Notification Bot|5**',
        noUser('@​_**Notification Bot|5**'),
      ],
      ['a name nobody has', 'nobody', noUser('nobody')],
    ])('should refuse to add %s, saying why', async (_, given, reply) => {
      const add = vitest.spyOn(database, 'addZulipCommandBot');

      await command(`add ${given}`);

      expect(contents()).toEqual([reply]);
      expect(add).not.toHaveBeenCalled();
    });

    it('should list the users who share the name, and add none', async () => {
      zulipMock.getUsers.mockResolvedValue([
        CLAUDE,
        { ...CLAUDE, userId: 33, email: 'claude-two-bot@zulip.example.com' },
      ]);

      await command('add @**Claude**');

      expect(contents()).toEqual([
        [
          '`@​**Claude**` names several users; name the bot by its user ID:',
          '- `Claude` (user 30)',
          '- `Claude` (user 33)',
        ].join('\n'),
      ]);
      expect(database.commandBots).toEqual([]);
    });

    it('should remove a bot named by its name, and change nothing for one that is not listed or a name nobody has', async () => {
      await command('add Claude');

      await command('remove claude');
      await command('remove @**Claude Code**');
      await command('remove nobody');

      expect(database.commandBots).toEqual([]);
      expect(contents()).toEqual([
        ADDED,
        REMOVED,
        'Nothing changed: I did not take the commands of `Claude Code` (user 32); `command-bots list` lists the bots I do.',
        noUser('nobody'),
      ]);
    });

    it.each(['30', '@**Claude|30**'])(
      'should remove the bot %j by its ID without looking it up, so while Zulip cannot list the users too',
      async (given) => {
        await command('add Claude');
        zulipMock.getUsers.mockReset().mockRejectedValue(new Error('Zulip is down'));

        await command(`remove ${given}`);
        await send('@**Immich** rss-list', fromClaudeHere);

        expect(database.commandBots).toEqual([]);
        expect(zulipMock.getUsers).not.toHaveBeenCalled();
        expect(contents()).toEqual([ADDED, 'I no longer take the commands of user 30.']);
      },
    );

    it('should list the bots in the order they were added, with who added each and when', async () => {
      listed(30, 'Alice on Zulip (user 12)', '2026-10-07T12:00:00Z');
      listed(41, 'Bob on Zulip (user 13)', '2026-10-08T09:00:00Z');
      await sut.init();

      await command('list');

      expect(contents()).toEqual([
        [
          'I take the commands of these bots:',
          '- `Claude` (user 30), added by `Alice on Zulip (user 12)` on 2026-10-07',
          '- user 41, added by `Bob on Zulip (user 13)` on 2026-10-08',
        ].join('\n'),
      ]);
    });

    it("should keep the Markdown of the adder's name inside its code span", async () => {
      listed(30, '[Alice](https://example.com) on Zulip (user 12)', '2026-10-07T12:00:00Z');
      await sut.init();

      await command('list');

      expect(contents()).toEqual([
        'I take the commands of these bots:\n- `Claude` (user 30), added by `[Alice](https://example.com) on Zulip (user 12)` on 2026-10-07',
      ]);
    });

    it('should list the bots by their IDs when Zulip cannot list the users', async () => {
      listed(30, 'Alice on Zulip (user 12)', '2026-10-07T12:00:00Z');
      await sut.init();
      zulipMock.getUsers.mockRejectedValue(new Error('Zulip is down'));

      await command('list');

      expect(contents()).toEqual([
        'I take the commands of these bots:\n- user 30, added by `Alice on Zulip (user 12)` on 2026-10-07',
      ]);
    });

    it('should say how to add a bot when none is listed', async () => {
      await command('list');

      expect(contents()).toEqual(['I take the commands of no other bot; `command-bots add <bot>` adds one.']);
      expect(zulipMock.getUsers).not.toHaveBeenCalled();
    });

    it.each([
      ['an owner', 100, true],
      ['an administrator', 200, true],
      ['a moderator', 300, false],
      ['a member', 400, false],
      ['a guest', 600, false],
    ])('should take it from %s: %s', async (_, role, allowed) => {
      zulipMock.getUser.mockResolvedValue({ ...ADMIN, role });
      const add = vitest.spyOn(database, 'addZulipCommandBot');
      const remove = vitest.spyOn(database, 'removeZulipCommandBot');

      await command('add Claude');
      await command('list');
      await command('remove 30');

      if (allowed) {
        expect(contents()).toEqual([
          ADDED,
          expect.stringMatching(/^I take the commands of these bots:\n- `Claude` \(user 30\), added by `Alice/),
          'I no longer take the commands of user 30.',
        ]);
        return;
      }
      expect(contents()).toEqual(Array(3).fill(NOT_AN_ADMINISTRATOR));
      expect(zulipMock.getUsers).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    it.each(['', 'add', 'remove', 'list all', 'promote Claude'])(
      'should answer command-bots %j with the usage and change nothing',
      async (given) => {
        await send(`@**Immich** command-bots ${given}`.trim(), { streamId: 999 });

        expect(contents()).toEqual([USAGE]);
        expect(zulipMock.getUsers).not.toHaveBeenCalled();
      },
    );

    it('should refuse a second change while one runs, and finish the first', async () => {
      let release: (users: ZulipAccount[]) => void = () => {};
      zulipMock.getUsers.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      );

      const first = command('add Claude');
      await flush();
      await command('add Claude Code');
      await command('remove 30');
      release([CLAUDE]);
      await first;

      expect(contents()).toEqual([RUNNING, RUNNING, ADDED]);
      expect(database.commandBots.map(({ userId }) => userId)).toEqual([30]);
    });

    it('should say so when Zulip cannot list the users, and add nothing', async () => {
      zulipMock.getUsers.mockRejectedValue(new Error('Zulip is down'));

      await command('add Claude');

      expect(contents()).toEqual(['`command-bots` failed: `Zulip is down`']);
      expect(database.commandBots).toEqual([]);
    });
  });
});
