import { Logger } from '@nestjs/common';
import { Constants } from 'src/constants';
import { neutraliseZulipLabel } from 'src/format';
import { PullRequestBaseEvent } from 'src/interfaces/github.interface';
import { IZulipInterface, ZulipReceivedMessage, ZulipUser } from 'src/interfaces/zulip.interface';
import { ChatService, EmoteSyncReport } from 'src/services/chat.service';
import { GithubService } from 'src/services/github.service';
import { BackfillPlatforms, BackfillReport, WebhookService } from 'src/services/webhook.service';
import { ZulipCommandService, parseCommand, splitArguments, tokenize } from 'src/services/zulip-command.service';
import { ZulipMessageHandler, ZulipService } from 'src/services/zulip.service';
import { Mocked, afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

const BOT: ZulipUser = { userId: 7, fullName: 'Immich' };

const newZulipMock = (): Mocked<IZulipInterface> => ({
  init: vitest.fn(),
  isInitialised: vitest.fn(),
  sendMessage: vitest.fn().mockResolvedValue({ id: 1000 }),
  getMessage: vitest.fn(),
  updateMessage: vitest.fn(),
  createEmote: vitest.fn(),
  listEmoji: vitest.fn(),
  getSubscriptions: vitest.fn(),
  getOwnUser: vitest.fn(),
  getMessages: vitest.fn().mockResolvedValue([]),
  registerQueue: vitest.fn(),
  getEvents: vitest.fn(),
  deleteQueue: vitest.fn(),
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

const message = (overrides: Partial<ZulipReceivedMessage> = {}): ZulipReceivedMessage => ({
  id: 500,
  senderId: 12,
  senderEmail: 'alice@example.com',
  type: 'stream',
  streamId: Constants.Zulip.TeamStreams.ImmichGeneral,
  topic: 'deploy',
  content: '@**Immich** help',
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
  '- `similar [text]`: list the immich-app/immich issues and discussions like the text, or without text like the last message a human wrote in this topic, looked for among its ten newest',
  '',
  'Arguments are positional or `key=value`; quote a value with spaces (`text="two words"`). Every reply is posted here, in the topic.',
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
    sut = new ZulipCommandService(
      zulipMock,
      zulipServiceMock as unknown as ZulipService,
      chatServiceMock as unknown as ChatService,
      githubServiceMock as unknown as GithubService,
      webhookServiceMock as unknown as WebhookService,
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
      await send(`@**Immich** ${'y'.repeat(50_000)}`);

      const [content] = replies().map(({ content }) => content);
      expect(content).toMatch(/^Unknown command `y+\.\.\.`$/);
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
      zulipSkipped: false,
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
        zulipSkipped: true,
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
});
