import { Logger } from '@nestjs/common';
import { Constants } from 'src/constants';
import { neutraliseZulipLabel } from 'src/format';
import { IDatabaseRepository, MirrorIdentityOwner } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { PullRequestBaseEvent } from 'src/interfaces/github.interface';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { IRSSInterface } from 'src/interfaces/rss.interface';
import { IZulipInterface, ZulipReceivedMessage, ZulipUser } from 'src/interfaces/zulip.interface';
import { NewRSSFeed, NewScheduledMessage, RSSFeed, ScheduledMessage, UpdateRSSFeed, ZulipExpander } from 'src/schema';
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

const newZulipMock = (): Mocked<IZulipInterface> => ({
  init: vitest.fn(),
  isInitialised: vitest.fn(),
  sendMessage: vitest.fn().mockResolvedValue({ id: 1000 }),
  sendDirectMessage: vitest.fn(),
  getMessage: vitest.fn(),
  updateMessage: vitest.fn(),
  createEmote: vitest.fn(),
  listEmoji: vitest.fn(),
  getSubscriptions: vitest.fn(),
  getOwnUser: vitest.fn(),
  getUser: vitest.fn(),
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
  onMessage: vitest.fn<(handler: ZulipMessageHandler) => void>(),
  ownUser: BOT as ZulipUser | undefined,
});

const newChatServiceMock = () => ({
  syncEmotes: vitest.fn<(guildId: string) => Promise<EmoteSyncReport>>(),
  updateFourthwallOrders: vitest.fn<(id?: string | null) => Promise<void>>().mockResolvedValue(),
  handleFindSimilarIssuesOrDiscussions: vitest.fn<(text: string) => Promise<string>>().mockResolvedValue(''),
});

const newGithubServiceMock = () => ({
  getOpenPullRequests: vitest.fn<() => Promise<PullRequestBaseEvent[]>>().mockResolvedValue([]),
  getOpenPullRequest: vitest
    .fn<(number: number) => Promise<PullRequestBaseEvent | undefined>>()
    .mockResolvedValue(undefined),
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
  const expanders: ZulipExpander[] = [];
  const findFeed = (url: string, channelId: string, service: RSSFeed['service']) =>
    feeds.findIndex((feed) => feed.url === url && feed.channelId === channelId && feed.service === service);
  return {
    scheduled,
    feeds,
    expanders,
    getZulipExpanders: () => Promise.resolve(expanders.map((row) => ({ ...row }))),
    addZulipExpander: (streamId: number, createdBy: string) => {
      if (expanders.some((row) => row.streamId === streamId)) {
        return Promise.resolve(false);
      }
      expanders.push({ streamId, createdBy, createdAt: new Date() });
      return Promise.resolve(true);
    },
    removeZulipExpander: (streamId: number) => {
      const index = expanders.findIndex((row) => row.streamId === streamId);
      if (index !== -1) {
        expanders.splice(index, 1);
      }
      return Promise.resolve(index !== -1);
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

const HELP = [
  'Mention me at the start of a message in a team stream, then one of:',
  '- `help`: this list',
  `- \`emote-sync\`: upload every emote of ${SERVER} to Zulip and Mattermost, skipping a name the platform already has`,
  '- `backfill-pull-requests <number|all>`: create the Discord team thread and the Zulip topic that open pull request lacks, or with `all` for every open one; one that has both, was opened by a bot, or is not in the database is skipped, and nothing that exists is touched',
  '- `fourthwall update <id|all>`: fetch that Fourthwall order again and update its row in the database, or with `all` every order',
  '- `schedule-add <name> cron=<expression> message=<text> [topic=<topic>] [suppress-embeds=<true|false>]`: post the message in this stream on that cron schedule, in the topic given or this one; `suppress-embeds` is accepted and ignored: Zulip cannot turn off link previews for one message',
  '- `schedule-list`: list every scheduled message on Zulip, with its schedule, stream, topic and the start of its text',
  '- `schedule-edit <name> [cron=<expression>] [message=<text>] [topic=<topic>] [suppress-embeds=<true|false>]`: change the schedule, text or topic of a scheduled message on Zulip, from its next post on; `suppress-embeds` is accepted and ignored: Zulip cannot turn off link previews for one message',
  '- `schedule-remove <name>`: delete a scheduled message on Zulip, which stops it',
  '- `rss-subscribe <url> [topic=<topic>]`: post the newest post of that RSS feed now, and every new one after it (checked every 15 minutes), in this stream, in the topic given or this one',
  '- `rss-unsubscribe <url>`: stop posting that RSS feed in this stream',
  '- `rss-list`: list the RSS feeds this stream is subscribed to, with their topics',
  "- `mirror-link [topic=<main topic>]` (administrators): start mirroring this stream with a Discord text channel or forum, both ways: this answers with the `/mirror-link` command a Discord administrator then runs in that channel; the main topic (text channels only, general chat by default) holds the channel's own messages",
  '- `mirror-unlink` (administrators): stop mirroring this stream with its Discord channel, and announce it on both sides',
  '- `mirror-backfill` (administrators): copy the messages of the Discord channel or thread this topic mirrors that are not here yet into this topic, oldest first, between two notices; new Discord messages there wait until it is done',
  '- `mirror-list` (administrators): list the mirrored channels and streams, and the linked accounts',
  '- `expanders <on|off|list>` (administrators): turn GitHub expansion (issue, pull request and discussion links and `#1234` to their titles, file permalinks to code) on or off in this stream, or `list` the streams it is on in; x.com links are mirrored on nitter.net in every stream',
  '- `discord-unlink`: unlink your Zulip account from your Discord account, so that your messages appear on Discord as "Name (Zulip)"',
  '- `similar [text]`: list the immich-app/immich issues and discussions like the text, or without text like the last message a human wrote in this topic, looked for among its ten newest',
  '',
  'Arguments are positional or `key=value`; quote a value with spaces (`text="two words"`). Every reply is posted here, in the topic.',
  'The commands marked (administrators) are taken in any stream, from organization administrators and owners only. To link your Zulip account with your Discord account, run `/zulip-link` on Discord and send me the code it gives you in a direct message.',
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
  let webhookServiceMock: ReturnType<typeof newWebhookServiceMock>;
  let database: ReturnType<typeof newFakeDatabase>;
  let discordMock: Mocked<Pick<IDiscordInterface, 'sendMessage'>>;
  let rssMock: Mocked<IRSSInterface>;
  let mirrorLinksMock: ReturnType<typeof newMirrorLinkServiceMock>;
  let zulipExpanders: ZulipExpanderService;

  const replies = () => zulipMock.sendMessage.mock.calls.map(([payload]) => payload);
  const send = (content: string, overrides: Partial<ZulipReceivedMessage> = {}) =>
    sut.onZulipMessage(message({ content, ...overrides }));

  beforeEach(() => {
    vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    zulipMock = newZulipMock();
    zulipServiceMock = newZulipServiceMock();
    chatServiceMock = newChatServiceMock();
    githubServiceMock = newGithubServiceMock();
    webhookServiceMock = newWebhookServiceMock();
    database = newFakeDatabase();
    discordMock = { sendMessage: vitest.fn() };
    rssMock = { getFeed: vitest.fn() };
    mirrorLinksMock = newMirrorLinkServiceMock();
    const discord = discordMock as unknown as IDiscordInterface;
    const mattermost = {} as IMattermostInterface;
    const db = database as unknown as IDatabaseRepository;
    zulipExpanders = new ZulipExpanderService(db);
    sut = new ZulipCommandService(
      zulipMock,
      zulipServiceMock as unknown as ZulipService,
      chatServiceMock as unknown as ChatService,
      githubServiceMock as unknown as GithubService,
      webhookServiceMock as unknown as WebhookService,
      new ScheduledMessageService(db, discord, mattermost, zulipMock),
      new RSSService(db, new NotificationService(discord, mattermost, zulipMock), rssMock),
      mirrorLinksMock as unknown as MirrorLinkService,
      zulipExpanders,
    );
  });

  afterEach(() => {
    vitest.restoreAllMocks();
  });

  describe('init', () => {
    it('should subscribe one handler to the event loop, which answers commands', async () => {
      await sut.init();

      expect(zulipServiceMock.onMessage).toHaveBeenCalledOnce();
      const [handler] = zulipServiceMock.onMessage.mock.calls[0];
      await handler(message());
      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
    });
  });

  describe('gating', () => {
    it('should take commands in every immich team stream', () => {
      expect(Constants.Zulip.Commands).toEqual([107, 108, 109, 110, 111, 112, 113]);
    });

    it('should ignore a command in a stream that is not allowlisted, without a reply', async () => {
      await send('@**Immich** help', { streamId: Constants.Zulip.Streams.Immich });
      await send('@**Immich** help', { streamId: 999 });

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
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
      await send('@**Immich** help', { streamId: 109, topic: 'ios build' });

      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({ stream: 109, topic: 'ios build', content: HELP });
    });

    it('should answer in the empty topic when the command was given there', async () => {
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
    it('should list every command with its arguments', async () => {
      await send('@**Immich** help');

      expect(replies()).toEqual([{ stream: 107, topic: 'deploy', content: HELP }]);
    });

    it('should answer a bare mention with the list too', async () => {
      await send('@**Immich**');

      expect(replies().map(({ content }) => content)).toEqual([HELP]);
    });

    it('should end the list with a blank line, so the line after it is not part of the last item', async () => {
      await send('@**Immich** help');

      expect(replies()[0].content).toMatch(/\n- `similar \[text]`: [^\n]+\n\nArguments are positional/);
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
      ['@**Immich** help me', 'Usage: `help`'],
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
      mattermostUploaded: 3,
      failed: [],
      renamed: ['nameless:3 → nameless_3'],
      alreadyOnZulip: [],
      alreadyOnMattermost: [],
    };
    const DONE = `Done syncing the emotes of ${SERVER}: 3 emotes, 3 uploaded to Zulip, 3 uploaded to Mattermost, 1 renamed: nameless:3 → nameless_3`;

    it('should acknowledge at once, naming the server, sync it in the background and post the report when done', async () => {
      let finish!: (report: EmoteSyncReport) => void;
      chatServiceMock.syncEmotes.mockReturnValue(new Promise((resolve) => (finish = resolve)));

      await send('@**Immich** emote-sync');

      expect(chatServiceMock.syncEmotes).toHaveBeenCalledExactlyOnceWith(Constants.Discord.EmoteSyncServer.id);
      expect(Constants.Discord.EmoteSyncServer).toEqual({ id: '979116623879368755', name: 'Immich' });
      expect(replies().map(({ content }) => content)).toEqual([
        `Syncing the emotes of ${SERVER} to Zulip and Mattermost, this can take a few minutes…`,
      ]);

      finish(report);
      await flush();

      expect(replies().map(({ content }) => content)).toEqual([
        `Syncing the emotes of ${SERVER} to Zulip and Mattermost, this can take a few minutes…`,
        DONE,
      ]);
    });

    it('should report the same outcome as Discord does, naming the server', async () => {
      chatServiceMock.syncEmotes.mockResolvedValue({
        total: 3,
        zulipUploaded: 0,
        mattermostUploaded: 2,
        zulipSkipped: 'unlisted',
        failed: ['pepeD'],
        renamed: [],
        alreadyOnZulip: ['catJAM', 'CatJam → catjam2'],
        alreadyOnMattermost: ['kekw'],
      });

      await send('@**Immich** emote-sync');
      await flush();

      expect(replies().at(-1)?.content).toBe(
        `Done syncing the emotes of ${SERVER}: 3 emotes, 0 uploaded to Zulip (skipped: its emoji could not be listed), 2 uploaded to Mattermost, 1 failed: pepeD, 2 already on Zulip: catJAM, CatJam → catjam2, 1 already on Mattermost: kekw`,
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
        `Done syncing the emotes of ${SERVER}: 3 emotes, 3 uploaded to Zulip, 3 uploaded to Mattermost, 1 failed: @\u200B**all**, 1 renamed: #\u200B**general** → general`,
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
        /^Done syncing the emotes of the Immich Discord server \(979116623879368755\): 1000 emotes, 3 uploaded to Zulip, 3 uploaded to Mattermost, 1000 failed: emote_number_0, /,
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
        'Scheduled messages on Zulip:\n- `standup`: `* * * * *` in stream 107 (ImmichGeneral), topic `deploy`: `@\u200B*mobile* Standup in **5 minutes**`',
        'Updated scheduled message `standup`: it posts with cron `* * * * *` in topic `daily` of stream 107 (ImmichGeneral).',
        'Standup now',
        'Removed scheduled message `standup`.',
        'There are no scheduled messages on Zulip.',
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

    it('should answer a name already taken, on any platform, with the error', async () => {
      await database.createScheduledMessage({
        name: 'standup',
        cronExpression: '0 9 * * 1',
        message: 'Discord standup',
        channelId: '991930592843272342',
        createdBy: 'user-1',
        service: 'discord',
      });

      await send(`@**Immich** schedule-add standup cron="${everyMinute}" message=Hi`);

      expect(contents()).toEqual([
        '`schedule-add` failed: `duplicate key value violates unique constraint "scheduled_message_name_uq"`',
      ]);
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

      const notFound = 'There is no scheduled message `standup` on Zulip; `schedule-list` lists them.';
      expect(contents()).toEqual(['There are no scheduled messages on Zulip.', notFound, notFound]);
      expect(database.scheduled).toMatchObject([{ name: 'standup', message: 'Discord standup', service: 'discord' }]);
    });

    it('should list a message on one line, shortened, mentioning nobody', async () => {
      const message = `@**all** line one\nline \`two\` ${'x'.repeat(100)}`;
      await database.createScheduledMessage({
        name: 'long',
        cronExpression: '0 9 * * 1',
        message,
        channelId: '999',
        topic: null,
        createdBy: '12',
        service: 'zulip',
      });

      await send('@**Immich** schedule-list');

      expect(contents()).toEqual([
        `Scheduled messages on Zulip:\n- \`long\`: \`0 9 * * 1\` in stream 999, the general chat topic: \`@\u200B**all** line one line two ${'x'.repeat(48)}...\``,
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
    const ADMIN = { userId: 12, fullName: 'Alice', role: 200 };
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

    it('should take the mirror commands in any stream, where the other commands stay ignored', async () => {
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
      expect(mirrorLinksMock.unlinkIdentity).not.toHaveBeenCalled();
      expect(replies()).toEqual([
        { stream: 120, topic: 'setup', content: REQUESTED },
        { stream: 54, topic: 'deploy', content: 'No channel is mirrored.' },
      ]);
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

      it.each(['hello', 'link', 'link me the doc', 'unlink it please', '@**Immich** help', 'link "ABCD', ''])(
        'should say nothing to %j',
        async (content) => {
          await direct(content);

          expect(mirrorLinksMock.redeemIdentityCode).not.toHaveBeenCalled();
          expect(mirrorLinksMock.unlinkIdentity).not.toHaveBeenCalled();
          expect(answers()).toEqual([]);
          expect(zulipMock.sendMessage).not.toHaveBeenCalled();
        },
      );

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
    const ADMIN = { userId: 12, fullName: 'Alice', role: 200 };
    const NOT_AN_ADMINISTRATOR =
      'Only Zulip organization administrators and owners can change or list GitHub expansion.';
    const NOT_SUBSCRIBED =
      '⚠ I am not subscribed to this stream, so none of its messages reach me and nothing is expanded here until an administrator subscribes me.';
    const HEADER =
      'GitHub expansion (issue, pull request and discussion links and `#1234` to their titles, file permalinks to code) is on in:';
    const USAGE = 'Usage: `expanders <on|off|list>`';
    const row = (streamId: number): ZulipExpander => ({ streamId, createdBy: 'migration', createdAt: new Date(0) });
    const contents = () => replies().map(({ content }) => content);
    const stored = () => database.expanders.map(({ streamId }) => streamId).sort((a, b) => a - b);

    beforeEach(async () => {
      zulipMock.getUser.mockResolvedValue(ADMIN);
      zulipMock.getSubscriptions.mockResolvedValue([{ streamId: 107 }, { streamId: 120 }]);
      database.expanders.push(row(107));
      await zulipExpanders.init();
    });

    it('should turn GitHub expansion on in this stream, in any stream, and store who did it', async () => {
      await send('@**Immich** expanders on', { streamId: 120, topic: 'setup' });

      expect(replies()).toEqual([
        { stream: 120, topic: 'setup', content: 'Turned on GitHub expansion in this stream.' },
      ]);
      expect(database.expanders).toEqual([
        row(107),
        { streamId: 120, createdBy: 'Alice on Zulip (user 12)', createdAt: expect.any(Date) },
      ]);
      expect(zulipExpanders.isEnabled(120)).toBe(true);
    });

    it('should say when it was already on or off, whatever the case of the command', async () => {
      await send('@**Immich** EXPANDERS ON');
      await send('@**Immich** expanders Off');
      await send('@**Immich** expanders off');

      expect(contents()).toEqual([
        'Nothing changed: GitHub expansion was already on in this stream.',
        'Turned off GitHub expansion in this stream.',
        'Nothing changed: GitHub expansion was already off in this stream.',
      ]);
      expect(stored()).toEqual([]);
      expect(zulipExpanders.isEnabled(107)).toBe(false);
    });

    it('should change this stream only', async () => {
      await send('@**Immich** expanders on', { streamId: 120 });
      await send('@**Immich** expanders off', { streamId: 107 });

      expect(zulipExpanders.list()).toEqual([120]);
      expect(stored()).toEqual([120]);
    });

    it('should warn when it turns expansion on in a stream the bot is not subscribed to, and not when it turns it off', async () => {
      await send('@**Immich** expanders on', { streamId: 130 });
      await send('@**Immich** expanders on', { streamId: 130 });
      await send('@**Immich** expanders off', { streamId: 130 });

      expect(contents()).toEqual([
        `Turned on GitHub expansion in this stream.\n${NOT_SUBSCRIBED}`,
        `Nothing changed: GitHub expansion was already on in this stream.\n${NOT_SUBSCRIBED}`,
        'Turned off GitHub expansion in this stream.',
      ]);
      expect(zulipMock.getSubscriptions).toHaveBeenCalledTimes(2);
    });

    it('should change nothing when the subscriptions cannot be read, and say so', async () => {
      zulipMock.getSubscriptions.mockRejectedValue(new Error('Zulip is down'));

      await send('@**Immich** expanders on', { streamId: 120 });

      expect(contents()).toEqual(['`expanders` failed: `Zulip is down`']);
      expect(stored()).toEqual([107]);
      expect(zulipExpanders.isEnabled(120)).toBe(false);
    });

    it('should keep the cache as it was when the table refuses the change', async () => {
      vitest.spyOn(database, 'addZulipExpander').mockRejectedValue(new Error('connection terminated'));

      await send('@**Immich** expanders on', { streamId: 120 });

      expect(contents()).toEqual(['`expanders` failed: `connection terminated`']);
      expect(zulipExpanders.list()).toEqual([107]);
    });

    it('should list every stream by name and ID, and mark one the bot is not subscribed to', async () => {
      database.expanders.push(row(54), row(130), row(140));
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
          '- **#Immich** (54)',
          '- **#immich-general** (107)',
          '- **#@​**all** news** (130) (⚠ I am not subscribed, so nothing reaches me there)',
          '- stream 140 (⚠ I am not subscribed, so nothing reaches me there)',
        ].join('\n'),
      ]);
    });

    it('should list without the subscription marks when the subscriptions cannot be read', async () => {
      zulipMock.getStream.mockResolvedValue({ streamId: 107, name: 'immich-general', inviteOnly: true });
      zulipMock.getSubscriptions.mockRejectedValue(new Error('Zulip is down'));

      await send('@**Immich** expanders list');

      expect(contents()).toEqual([`${HEADER}\n- **#immich-general** (107)`]);
    });

    it('should say when GitHub expansion is on in no stream', async () => {
      await send('@**Immich** expanders off');
      await send('@**Immich** expanders list');

      expect(contents()[1]).toBe('GitHub expansion is on in no stream.');
      expect(zulipMock.getStream).not.toHaveBeenCalled();
    });

    it.each([
      ['an owner', 100, true],
      ['an administrator', 200, true],
      ['a moderator', 300, false],
      ['a member', 400, false],
      ['a guest', 600, false],
    ])('should take the expanders command from %s: %s', async (_, role, allowed) => {
      zulipMock.getUser.mockResolvedValue({ ...ADMIN, role });

      await send('@**Immich** expanders on', { streamId: 120 });
      await send('@**Immich** expanders off', { streamId: 107 });
      await send('@**Immich** expanders list', { streamId: 54 });

      expect(zulipMock.getUser).toHaveBeenCalledTimes(3);
      expect(zulipMock.getUser).toHaveBeenCalledWith(12);
      if (allowed) {
        expect(stored()).toEqual([120]);
        expect(contents()).toHaveLength(3);
      } else {
        expect(stored()).toEqual([107]);
        expect(contents()).toEqual(Array(3).fill(NOT_AN_ADMINISTRATOR));
      }
    });

    it.each([
      '@**Immich** expanders',
      '@**Immich** expanders toggle',
      '@**Immich** expanders on github',
      '@**Immich** expanders off twitter',
      '@**Immich** expanders list all',
      '@**Immich** expanders on expander=github',
    ])('should answer %j with the usage and change nothing', async (content) => {
      await send(content, { streamId: 120 });

      expect(contents()).toEqual([USAGE]);
      expect(stored()).toEqual([107]);
      expect(zulipMock.getSubscriptions).not.toHaveBeenCalled();
    });
  });
});
