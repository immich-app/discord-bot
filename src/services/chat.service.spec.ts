import { ClientError } from '@mattermost/client';
import { Logger } from '@nestjs/common';
import { CommandInteraction, GuildEmoji } from 'discord.js';
import { Constants } from 'src/constants';
import { DiscordCommands } from 'src/discord/commands';
import { neutraliseZulipLabel } from 'src/format';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';
import { IFourthwallRepository } from 'src/interfaces/fourthwall.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { ILoopDedupeInterface } from 'src/interfaces/loop-dedupe.interface';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { IOutlineInterface } from 'src/interfaces/outline.interface';
import { IZulipInterface, ZulipReceivedMessage } from 'src/interfaces/zulip.interface';
import { ZulipApiError } from 'src/repositories/zulip.client';
import { ZulipExpander } from 'src/schema';
import { ZulipExpanderKind } from 'src/schema/tables/zulip-expander.table';
import { ChatService, formatEmoteSyncReport, hasBlacklistedUrl, toZulipEmojiName } from 'src/services/chat.service';
import { NotificationService } from 'src/services/notification.service';
import { ZulipExpanderService } from 'src/services/zulip-expander.service';
import { ZulipMessageHandler, ZulipService } from 'src/services/zulip.service';
import { MockInstance, Mocked, afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

const config = vitest.hoisted(() => ({ botToken: 'dev' }));

vitest.mock('src/config', () => ({
  getConfig: () => ({
    commitSha: '0123456789abcdef',
    bot: { token: config.botToken },
    fourthwall: { user: 'fw-user', password: 'fw-password' },
    zulip: {
      bot: { username: 'bot@example.com', apiKey: 'bot-key' },
      user: { username: 'human@example.com', apiKey: 'user-key' },
      realm: 'https://zulip.example.com',
    },
  }),
}));

const newGithubMockRepository = (): Mocked<IGithubInterface> => ({
  search: vitest.fn(),
  getDiscussionMessage: vitest
    .fn()
    .mockImplementation((org, repo, id) => Promise.resolve(`https://github.com/${org}/${repo}/discussions/${id}`)),
  getForkCount: vitest.fn(),
  getIssueOrPrMessage: vitest
    .fn()
    .mockImplementation((org, repo, id) =>
      Promise.resolve(`https://github.com/${org}/${repo}/${id % 2 === 0 ? 'pull' : 'issues'}/${id}`),
    ),
  getStarCount: vitest.fn(),
  init: vitest.fn(),
  getRepositoryFileContent: vitest
    .fn()
    .mockImplementation((org, repo, ref, path) =>
      Promise.resolve([`function test() { return "${org}/${repo} @ ${ref}: ${path}"; }`]),
    ),
  getCheckSuiteTriggerCommit: vitest.fn(),
  getLatestReleaseTag: vitest.fn(),
  isCollaborator: vitest.fn(),
  getPullRequests: vitest.fn(),
  getPullRequest: vitest.fn(),
});

const newDiscordMockRepository = (): Mocked<IDiscordInterface> => ({
  login: vitest.fn(),
  isReady: vitest.fn().mockReturnValue(true),
  onHandlerError: vitest.fn(),
  sendMessage: vitest.fn(),
  createEmote: vitest.fn(),
  getEmotes: vitest.fn(),
  setThreadArchived: vitest.fn(),
  createThread: vitest.fn(),
  updateThread: vitest.fn(),
});

const newOutlineMockRepository = (): Mocked<IOutlineInterface> => ({
  addToDocument: vitest.fn(),
  createDocument: vitest.fn(),
  shareDocument: vitest.fn(),
  searchDocuments: vitest.fn(),
});

const newDatabaseMockRepository = (): Mocked<IDatabaseRepository> => ({
  addDiscordLink: vitest.fn(),
  createPayment: vitest.fn(),
  getDiscordLinks: vitest.fn(),
  getDiscordLink: vitest.fn(),
  removeDiscordLink: vitest.fn(),
  getTotalLicenseCount: vitest.fn(),
  runMigrations: vitest.fn(),
  updateDiscordLink: vitest.fn(),
  addDiscordMessage: vitest.fn(),
  getDiscordMessage: vitest.fn(),
  getDiscordMessages: vitest.fn(),
  removeDiscordMessage: vitest.fn(),
  updateDiscordMessage: vitest.fn(),
  createFourthwallOrder: vitest.fn(),
  getTotalFourthwallOrders: vitest.fn(),
  streamFourthwallOrders: vitest.fn(),
  updateFourthwallOrder: vitest.fn(),
  createRSSFeed: vitest.fn(),
  getRSSFeeds: vitest.fn(),
  updateRSSFeed: vitest.fn(),
  removeRSSFeed: vitest.fn(),
  getScheduledMessages: vitest.fn(),
  getScheduledMessage: vitest.fn(),
  createScheduledMessage: vitest.fn(),
  updateScheduledMessage: vitest.fn(),
  removeScheduledMessage: vitest.fn(),
  createPullRequest: vitest.fn(),
  getPullRequestById: vitest.fn(),
  updatePullRequest: vitest.fn(),
  upsertPullRequest: vitest.fn(),
  getLatestPullRequestByNumber: vitest.fn(),
  getMirrorConversation: vitest.fn(),
  getMirrorConversationByDiscord: vitest.fn(),
  getMirrorConversationByZulipTopic: vitest.fn(),
  getMirrorConversationsByAnchors: vitest.fn(),
  getActiveMirrorThreads: vitest.fn(),
  createMirrorConversation: vitest.fn(),
  updateMirrorConversation: vitest.fn(),
  removeMirrorConversation: vitest.fn(),
  createMirrorMessages: vitest.fn(),
  getMirrorMessagesByDiscordIds: vitest.fn(),
  getMirrorMessagesByZulipIds: vitest.fn(),
  getMirrorMessagesByConversation: vitest.fn(),
  getRecentMirrorMessages: vitest.fn(),
  getNewestMirrorZulipMessageId: vitest.fn(),
  updateMirrorMessages: vitest.fn(),
  markMirrorMessagesDeleted: vitest.fn(),
  removeMirrorMessages: vitest.fn(),
  getMirrorZulipHighWater: vitest.fn(),
  getMirrorDiscordHighWater: vitest.fn(),
  getMirrorLinks: vitest.fn(),
  createMirrorLink: vitest.fn(),
  setMirrorLinkAnnouncement: vitest.fn(),
  removeMirrorLink: vitest.fn(),
  getMirrorIdentities: vitest.fn(),
  setMirrorIdentity: vitest.fn(),
  removeMirrorIdentity: vitest.fn(),
  getZulipExpanders: vitest.fn(),
  addZulipExpanders: vitest.fn(),
  removeZulipExpanders: vitest.fn(),
});

const newMattermostMockRepository = (): Mocked<IMattermostInterface> => ({
  isInitialised: vitest.fn().mockReturnValue(true),
  init: vitest.fn(),
  registerEventListener: vitest.fn() as any,
  send: vitest.fn(),
  reply: vitest.fn(),
  updatePost: vitest.fn(),
  createEmote: vitest.fn(),
  listEmoji: vitest.fn(),
  streamChannels: vitest.fn(),
  joinChannel: vitest.fn(),
  registerCommand: vitest.fn() as any,
  runCommand: vitest.fn(),
  openDialog: vitest.fn(),
  submitDialog: vitest.fn(),
});

const newFourthwallMockRepository = (): Mocked<IFourthwallRepository> => ({
  getOrder: vitest.fn(),
});

const newZulipServiceMock = () => ({
  onMessage: vitest.fn<(handler: ZulipMessageHandler) => void>(),
});

const newZulipMockRepository = (): Mocked<IZulipInterface> => ({
  init: vitest.fn(),
  isInitialised: vitest.fn(),
  createEmote: vitest.fn(),
  sendMessage: vitest.fn(),
  sendDirectMessage: vitest.fn(),
  getMessage: vitest.fn(),
  updateMessage: vitest.fn(),
  listEmoji: vitest.fn(),
  getSubscriptions: vitest.fn(),
  getOwnUser: vitest.fn(),
  getUser: vitest.fn(),
  getStream: vitest.fn(),
  getMessages: vitest.fn(),
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

const newLoopDedupeMockRepository = (): Mocked<ILoopDedupeInterface> => ({
  getForText: vitest.fn(),
});

describe('Bot test', () => {
  let sut: ChatService;

  let discordMock: Mocked<IDiscordInterface>;
  let fourthwallMock: Mocked<IFourthwallRepository>;
  let githubMock: Mocked<IGithubInterface>;
  let loopDedupeMock: Mocked<ILoopDedupeInterface>;
  let outlineMock: Mocked<IOutlineInterface>;
  let databaseMock: Mocked<IDatabaseRepository>;
  let mattermostMock: Mocked<IMattermostInterface>;
  let zulipMock: Mocked<IZulipInterface>;
  let zulipServiceMock: ReturnType<typeof newZulipServiceMock>;
  let zulipExpanders: ZulipExpanderService;
  let fetchMock: ReturnType<typeof vitest.fn>;

  beforeEach(() => {
    discordMock = newDiscordMockRepository();
    fourthwallMock = newFourthwallMockRepository();
    githubMock = newGithubMockRepository();
    loopDedupeMock = newLoopDedupeMockRepository();
    outlineMock = newOutlineMockRepository();
    databaseMock = newDatabaseMockRepository();
    mattermostMock = newMattermostMockRepository();
    zulipMock = newZulipMockRepository();
    zulipServiceMock = newZulipServiceMock();
    zulipExpanders = new ZulipExpanderService(databaseMock);
    // 7TV and BTTV lookups go through the global fetch.
    fetchMock = vitest.fn();
    vitest.stubGlobal('fetch', fetchMock);

    sut = new ChatService(
      databaseMock,
      discordMock,
      fourthwallMock,
      githubMock,
      loopDedupeMock,
      outlineMock,
      mattermostMock,
      zulipMock,
      zulipServiceMock as unknown as ZulipService,
      new NotificationService(discordMock, mattermostMock, zulipMock),
      zulipExpanders,
    );
  });

  afterEach(() => {
    vitest.unstubAllGlobals();
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('handleSearchAutocompletion', () => {
    it('should return nothing if search fails', async () => {
      githubMock.search.mockRejectedValue('some error');
      const result = await sut.handleSearchAutocompletion('test');

      expect(result).toEqual([]);
      expect(githubMock.search).toHaveBeenCalledWith(
        expect.objectContaining({ query: `repo:immich-app/immich in:title test` }),
      );
    });

    it('should return nothing if search string is empty', async () => {
      const result = await sut.handleSearchAutocompletion('');

      expect(result).toEqual([]);
      expect(githubMock.search).not.toHaveBeenCalled();
    });

    it('should correctly map responses', async () => {
      githubMock.search.mockResolvedValue({
        items: [
          {
            pull_request: { url: 'something', diff_url: null, html_url: null, patch_url: null },
            number: 123,
            title: 'my-first-pr',
          },
          {
            number: 321,
            title: 'my-first-issue',
          },
        ],
      } as never);

      const result = await sut.handleSearchAutocompletion('first');
      expect(result).toEqual([
        { name: '[PR] (123) my-first-pr', value: '123' },
        { name: '[Issue] (321) my-first-issue', value: '321' },
      ]);
      expect(githubMock.search).toHaveBeenCalledWith(
        expect.objectContaining({ query: `repo:immich-app/immich in:title first` }),
      );
    });
  });

  describe('getStarsMessage', () => {
    it('should return an error message if the api call was unsuccessful', async () => {
      githubMock.getStarCount.mockRejectedValue('error');

      const result = await sut.getStarsMessage('123');

      expect(result).toEqual('Could not fetch stars count from the GitHub API');
      expect(githubMock.getStarCount).toHaveBeenCalled();
    });

    it('should return current star count', async () => {
      githubMock.getStarCount.mockResolvedValue(42);

      const result = await sut.getStarsMessage('1');

      expect(result).toEqual('Stars ⭐: 42');
      expect(githubMock.getStarCount).toHaveBeenCalled();
    });

    it('should include delta for subsequent calls', async () => {
      githubMock.getStarCount.mockResolvedValueOnce(42);
      githubMock.getStarCount.mockResolvedValueOnce(420);

      const result = await sut.getStarsMessage('2');

      expect(result).toEqual('Stars ⭐: 42');
      expect(githubMock.getStarCount).toHaveBeenCalledOnce();

      const secondResult = await sut.getStarsMessage('2');

      expect(secondResult).toEqual('Stars ⭐: 420 (+378 stars since the last call in this channel)');
      expect(githubMock.getStarCount).toHaveBeenCalledTimes(2);
    });

    it('should not include delta if in different channels', async () => {
      githubMock.getStarCount.mockResolvedValueOnce(42);
      githubMock.getStarCount.mockResolvedValueOnce(420);

      const result = await sut.getStarsMessage('3');

      expect(result).toEqual('Stars ⭐: 42');
      expect(githubMock.getStarCount).toHaveBeenCalledOnce();

      const secondResult = await sut.getStarsMessage('4');

      expect(secondResult).toEqual('Stars ⭐: 420');
      expect(githubMock.getStarCount).toHaveBeenCalledTimes(2);
    });
  });

  describe('getForksMessage', () => {
    it('should return an error message if the api call was unsuccessful', async () => {
      githubMock.getForkCount.mockRejectedValue('error');

      const result = await sut.getForksMessage('1');

      expect(result).toEqual('Could not fetch forks count from the GitHub API');
      expect(githubMock.getForkCount).toHaveBeenCalled();
    });

    it('should return current star count', async () => {
      githubMock.getForkCount.mockResolvedValue(42);

      const result = await sut.getForksMessage('1');

      expect(result).toEqual('Forks: 42');
      expect(githubMock.getForkCount).toHaveBeenCalled();
    });

    it('should include delta for subsequent calls', async () => {
      githubMock.getForkCount.mockResolvedValueOnce(42);
      githubMock.getForkCount.mockResolvedValueOnce(420);

      const result = await sut.getForksMessage('2');

      expect(result).toEqual('Forks: 42');
      expect(githubMock.getForkCount).toHaveBeenCalledOnce();

      const secondResult = await sut.getForksMessage('2');

      expect(secondResult).toEqual('Forks: 420 (+378 forks since the last call in this channel)');
      expect(githubMock.getForkCount).toHaveBeenCalledTimes(2);
    });

    it('should not include delta if in different channels', async () => {
      githubMock.getForkCount.mockResolvedValueOnce(42);
      githubMock.getForkCount.mockResolvedValueOnce(420);

      const result = await sut.getForksMessage('3');

      expect(result).toEqual('Forks: 42');
      expect(githubMock.getForkCount).toHaveBeenCalledOnce();

      const secondResult = await sut.getForksMessage('4');

      expect(secondResult).toEqual('Forks: 420');
      expect(githubMock.getForkCount).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleGithubThreadReferences', () => {
    it.each([
      {
        name: 'should handle a number',
        message: '#4242',
        links: ['https://github.com/immich-app/immich/pull/4242'],
      },
      {
        name: 'should handle multiple numbers',
        message: '#4242 #6969',
        links: ['https://github.com/immich-app/immich/pull/4242', 'https://github.com/immich-app/immich/issues/6969'],
      },
      {
        name: 'should ignore a reference under 1000',
        message: '#123',
        links: [],
      },
      {
        name: 'should ignore the reference under 1000',
        message: '#123 #4242',
        links: ['https://github.com/immich-app/immich/pull/4242'],
      },
      {
        name: 'should ignore references in code blocks',
        message: '```#4242 #1234``` #6969',
        links: ['https://github.com/immich-app/immich/issues/6969'],
      },
      {
        name: 'should support a reference to another immich repo',
        message: 'static-pages#4242',
        links: ['https://github.com/immich-app/static-pages/pull/4242'],
      },
      {
        name: 'should support a reference for another repo',
        message: 'octokit/rest.js#4242',
        links: ['https://github.com/octokit/rest.js/pull/4242'],
      },
      {
        name: 'should support github pull request references',
        message: 'https://github.com/immich-app/immich/pull/4242',
        links: ['https://github.com/immich-app/immich/pull/4242'],
      },
      {
        name: 'should deduplicate links',
        message: 'https://github.com/immich-app/immich/pull/4242 #4242 immich-app/immich#4242 immich#4242',
        links: ['https://github.com/immich-app/immich/pull/4242'],
      },
      {
        name: 'should properly parse numbers in repo names',
        message:
          'https://github.com/fluxcd/flux2-kustomize-helm-example https://github.com/fluxcd/flux2-kustomize-helm-example/pull/42',
        links: ['https://github.com/fluxcd/flux2-kustomize-helm-example/pull/42'],
      },
      {
        name: 'should return all the links',
        message: [
          '#1234',
          'immich#123',
          'static-pages#123',
          'immich-app/static-pages#123',
          'octokit/rest.js#123',
          'https://github.com/immich-app/immich/pull/1',
          'https://github.com/immich-app/immich/issues/2',
          'https://github.com/immich-app/immich/discussions/3',
        ].join('\n'),
        links: [
          'https://github.com/immich-app/immich/pull/1234',
          'https://github.com/immich-app/immich/issues/123',
          'https://github.com/immich-app/static-pages/issues/123',
          'https://github.com/octokit/rest.js/issues/123',
          'https://github.com/immich-app/immich/issues/1',
          'https://github.com/immich-app/immich/pull/2',
          'https://github.com/immich-app/immich/discussions/3',
        ],
      },
    ])('should $name', async ({ message: message, links }) => {
      await expect(sut.handleGithubThreadReferences({ content: message }, false)).resolves.toEqual(links);
    });

    it.each([
      { name: 'a Discord channel mention', message: 'see <#1369628205035688098>' },
      { name: 'a number too large for an issue', message: '#1369628205035688098' },
    ])('should not look up $name', async ({ message }) => {
      await expect(sut.handleGithubThreadReferences({ content: message }, false)).resolves.toEqual([]);
      expect(databaseMock.getLatestPullRequestByNumber).not.toHaveBeenCalled();
    });
  });

  describe('handleGithubFileReferences', () => {
    it('should return nothing if the message is empty', async () => {
      const result = await sut.handleGithubFileReferences('', false);

      expect(result).toEqual([]);
    });

    it('should return nothing if the message does not contain a file reference', async () => {
      const result = await sut.handleGithubFileReferences('This is a test message', false);

      expect(result).toEqual([]);
    });

    it('should return the full file in a snippet', async () => {
      const result = await sut.handleGithubFileReferences(
        'https://github.com/immich-app/immich/blob/main/src/test.js',
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('```js\n');
      expect(result[0]).toContain('function test() { return "immich-app/immich @ main: src/test.js"; }');
    });

    it('should return a line reference range', async () => {
      githubMock.getRepositoryFileContent.mockResolvedValueOnce(['line 1', 'line 2', 'line 3']);
      const result = await sut.handleGithubFileReferences(
        'https://github.com/immich-app/immich/blob/main/src/test.js#L1-L2',
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('```js\n');
      expect(result[0]).toContain('line 1');
      expect(result[0]).toContain('line 2');
      expect(result[0]).not.toContain('line 3');
    });

    it('should return a single line reference', async () => {
      githubMock.getRepositoryFileContent.mockResolvedValueOnce(['line 1', 'line 2', 'line 3']);
      const result = await sut.handleGithubFileReferences(
        'https://github.com/immich-app/immich/blob/main/src/test.js#L3',
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toContain('```js\n');
      expect(result[0]).not.toContain('line 1');
      expect(result[0]).not.toContain('line 2');
      expect(result[0]).toContain('line 3');
    });

    it('should support multiple file references', async () => {
      githubMock.getRepositoryFileContent.mockResolvedValueOnce(['line 1', 'line 2', 'line 3']);
      const result = await sut.handleGithubFileReferences(
        `
        https://github.com/immich-app/immich/blob/main/src/test.js#L3
        Test message in between
        https://github.com/immich-app/immich/blob/anotherref/file.txt
      `,
        false,
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toContain('```js\n');
      expect(result[0]).not.toContain('line 1');
      expect(result[0]).not.toContain('line 2');
      expect(result[0]).toContain('line 3');
      expect(result[1]).toContain('```txt\n');
      expect(result[1]).toContain('function test() { return "immich-app/immich @ anotherref: file.txt"; }');
    });
  });

  describe('createEmote', () => {
    it('should upload the emote to Zulip and then create it on Discord', async () => {
      const created = { id: '1', name: 'catJAM' } as unknown as GuildEmoji;
      discordMock.createEmote.mockResolvedValue(created);

      await expect(sut.createEmote('catJAM', 'https://example.com/catJAM.png', 'guild-1')).resolves.toBe(created);

      expect(zulipMock.createEmote).toHaveBeenCalledOnce();
      expect(zulipMock.createEmote).toHaveBeenCalledWith('catJAM', 'https://example.com/catJAM.png');
      expect(discordMock.createEmote).toHaveBeenCalledOnce();
      expect(discordMock.createEmote).toHaveBeenCalledWith('catJAM', 'https://example.com/catJAM.png', 'guild-1');
      expect(mattermostMock.createEmote).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      const [zulip] = zulipMock.createEmote.mock.invocationCallOrder;
      const [discord] = discordMock.createEmote.mock.invocationCallOrder;
      expect(zulip).toBeLessThan(discord);
    });
  });

  describe('create7TvEmote', () => {
    const id = '01F6MZGCNG000255K8Q0CMP4Q0';
    const sevenTvEmote = (files: { name: string; format: string; size: number }[]) =>
      new Response(JSON.stringify({ id, name: 'catJAM', host: { url: `//cdn.7tv.app/emote/${id}`, files } }));

    it('should fetch the emote from 7TV and pick the last GIF under 256000 bytes', async () => {
      const created = { id: '1', name: 'catJAM' } as unknown as GuildEmoji;
      discordMock.createEmote.mockResolvedValue(created);
      fetchMock.mockResolvedValue(
        sevenTvEmote([
          { name: '1x.webp', format: 'WEBP', size: 10_000 },
          { name: '1x.gif', format: 'GIF', size: 50_000 },
          { name: '2x.gif', format: 'GIF', size: 150_000 },
          { name: '2x.webp', format: 'WEBP', size: 40_000 },
          { name: '3x.gif', format: 'GIF', size: 255_999 },
          { name: '4x.gif', format: 'GIF', size: 256_000 },
          { name: '4x.webp', format: 'WEBP', size: 200_000 },
        ]),
      );

      await expect(sut.create7TvEmote(id, 'guild-1', null)).resolves.toBe(created);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(`https://7tv.io/v3/emotes/${id}`);
      expect(zulipMock.createEmote).toHaveBeenCalledOnce();
      expect(zulipMock.createEmote).toHaveBeenCalledWith('catJAM', `https://cdn.7tv.app/emote/${id}/3x.gif`);
      expect(discordMock.createEmote).toHaveBeenCalledOnce();
      expect(discordMock.createEmote).toHaveBeenCalledWith(
        'catJAM',
        `https://cdn.7tv.app/emote/${id}/3x.gif`,
        'guild-1',
      );
    });

    it('should fall back to the last WEBP under 256000 bytes when no GIF fits', async () => {
      fetchMock.mockResolvedValue(
        sevenTvEmote([
          { name: '1x.webp', format: 'WEBP', size: 10_000 },
          { name: '2x.webp', format: 'WEBP', size: 100_000 },
          { name: '3x.webp', format: 'WEBP', size: 256_000 },
          { name: '1x.gif', format: 'GIF', size: 300_000 },
          { name: '4x.webp', format: 'WEBP', size: 500_000 },
        ]),
      );

      await sut.create7TvEmote(id, 'guild-1', null);

      expect(zulipMock.createEmote).toHaveBeenCalledOnce();
      expect(zulipMock.createEmote).toHaveBeenCalledWith('catJAM', `https://cdn.7tv.app/emote/${id}/2x.webp`);
      expect(discordMock.createEmote).toHaveBeenCalledOnce();
      expect(discordMock.createEmote).toHaveBeenCalledWith(
        'catJAM',
        `https://cdn.7tv.app/emote/${id}/2x.webp`,
        'guild-1',
      );
    });

    it('should use the given name over the 7TV name', async () => {
      fetchMock.mockResolvedValue(sevenTvEmote([{ name: '1x.gif', format: 'GIF', size: 10_000 }]));

      await sut.create7TvEmote(id, 'guild-1', 'dancing_cat');

      expect(zulipMock.createEmote).toHaveBeenCalledWith('dancing_cat', `https://cdn.7tv.app/emote/${id}/1x.gif`);
      expect(discordMock.createEmote).toHaveBeenCalledWith(
        'dancing_cat',
        `https://cdn.7tv.app/emote/${id}/1x.gif`,
        'guild-1',
      );
    });
  });

  describe('createBttvEmote', () => {
    const id = '5f1b0186cf6d2144653d2970';
    const bttvEmote = () => new Response(JSON.stringify({ id, code: 'catJAM', imageType: 'gif', animated: 'true' }));

    it('should fetch the emote from BTTV and use the 3x CDN image', async () => {
      const created = { id: '1', name: 'catJAM' } as unknown as GuildEmoji;
      discordMock.createEmote.mockResolvedValue(created);
      fetchMock.mockResolvedValue(bttvEmote());

      await expect(sut.createBttvEmote(id, 'guild-1', null)).resolves.toBe(created);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(`https://api.betterttv.net/3/emotes/${id}`);
      expect(zulipMock.createEmote).toHaveBeenCalledOnce();
      expect(zulipMock.createEmote).toHaveBeenCalledWith('catJAM', `https://cdn.betterttv.net/emote/${id}/3x`);
      expect(discordMock.createEmote).toHaveBeenCalledOnce();
      expect(discordMock.createEmote).toHaveBeenCalledWith(
        'catJAM',
        `https://cdn.betterttv.net/emote/${id}/3x`,
        'guild-1',
      );
    });

    it('should use the given name over the BTTV code', async () => {
      fetchMock.mockResolvedValue(bttvEmote());

      await sut.createBttvEmote(id, 'guild-1', 'dancing_cat');

      expect(zulipMock.createEmote).toHaveBeenCalledWith('dancing_cat', `https://cdn.betterttv.net/emote/${id}/3x`);
      expect(discordMock.createEmote).toHaveBeenCalledWith(
        'dancing_cat',
        `https://cdn.betterttv.net/emote/${id}/3x`,
        'guild-1',
      );
    });
  });

  describe('createEmoteFromExistingOne', () => {
    const url = 'https://cdn.discordapp.com/emojis/123456789012345678.png';

    it('should parse the emote mention and use the Discord CDN image', async () => {
      const created = { id: '1', name: 'catJAM' } as unknown as GuildEmoji;
      discordMock.createEmote.mockResolvedValue(created);

      await expect(sut.createEmoteFromExistingOne('<:catJAM:123456789012345678>', 'guild-1', null)).resolves.toBe(
        created,
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(zulipMock.createEmote).toHaveBeenCalledOnce();
      expect(zulipMock.createEmote).toHaveBeenCalledWith('catJAM', url);
      expect(discordMock.createEmote).toHaveBeenCalledOnce();
      expect(discordMock.createEmote).toHaveBeenCalledWith('catJAM', url, 'guild-1');
    });

    it('should use the given name over the mentioned one', async () => {
      await sut.createEmoteFromExistingOne('<:catJAM:123456789012345678>', 'guild-1', 'dancing_cat');

      expect(zulipMock.createEmote).toHaveBeenCalledWith('dancing_cat', url);
      expect(discordMock.createEmote).toHaveBeenCalledWith('dancing_cat', url, 'guild-1');
    });
  });

  describe('syncEmotes', () => {
    const newInteraction = () => {
      const reply = { edit: vitest.fn() };
      const deferReply = vitest.fn().mockResolvedValue(reply);
      const interaction = { guildId: 'guild-1', deferReply } as unknown as CommandInteraction;
      return { interaction, deferReply, reply };
    };

    const syncEmotes = (interaction: CommandInteraction) =>
      new DiscordCommands(
        sut,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
      ).handleEmoteSync(interaction);

    beforeEach(() => {
      zulipMock.listEmoji.mockResolvedValue([]);
      zulipMock.getEmojiCodes.mockResolvedValue({ unicode: { fire: '🔥', tada: '🎉', wave: '👋' }, names: {} });
      mattermostMock.listEmoji.mockResolvedValue([]);
    });

    it('should upload every Discord emote to Zulip and Mattermost, then report done', async () => {
      const { interaction, deferReply, reply } = newInteraction();
      discordMock.getEmotes.mockResolvedValue([
        {
          id: '1',
          identifier: 'catJAM:1',
          name: 'catJAM',
          url: 'https://cdn.discordapp.com/emojis/1.webp',
          animated: false,
        },
        {
          id: '2',
          identifier: 'a:pepeD:2',
          name: 'pepeD',
          url: 'https://cdn.discordapp.com/emojis/2.webp',
          animated: true,
        },
        {
          id: '3',
          identifier: 'nameless:3',
          name: null,
          url: 'https://cdn.discordapp.com/emojis/3.png',
          animated: false,
        },
      ]);

      await syncEmotes(interaction);

      expect(discordMock.getEmotes).toHaveBeenCalledOnce();
      expect(discordMock.getEmotes).toHaveBeenCalledWith('guild-1');

      expect(zulipMock.createEmote.mock.calls).toEqual([
        ['catjam', 'https://cdn.discordapp.com/emojis/1.webp'],
        ['peped', 'https://cdn.discordapp.com/emojis/2.gif'],
        ['nameless_3', 'https://cdn.discordapp.com/emojis/3.png'],
      ]);
      expect(mattermostMock.createEmote.mock.calls).toEqual([
        ['catJAM', 'https://cdn.discordapp.com/emojis/1.webp'],
        ['pepeD', 'https://cdn.discordapp.com/emojis/2.gif'],
        ['nameless:3', 'https://cdn.discordapp.com/emojis/3.png'],
      ]);
      expect(discordMock.createEmote).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      expect(deferReply).toHaveBeenCalledOnce();
      expect(reply.edit).toHaveBeenCalledOnce();
      expect(reply.edit).toHaveBeenCalledWith(
        'Done syncing: 3 emotes, 3 uploaded to Zulip, 3 uploaded to Mattermost, 1 renamed: nameless:3 → nameless_3',
      );
    });

    it.each([
      {
        animated: true,
        url: 'https://cdn.discordapp.com/emojis/1.webp',
        expected: 'https://cdn.discordapp.com/emojis/1.gif',
      },
      {
        animated: true,
        url: 'https://cdn.discordapp.com/emojis/1.png',
        expected: 'https://cdn.discordapp.com/emojis/1.gif',
      },
      {
        animated: true,
        url: 'https://cdn.discordapp.com/emojis/1.gif',
        expected: 'https://cdn.discordapp.com/emojis/1.gif',
      },
      {
        animated: false,
        url: 'https://cdn.discordapp.com/emojis/1.webp',
        expected: 'https://cdn.discordapp.com/emojis/1.webp',
      },
    ])('should upload $url as $expected when animated is $animated', async ({ animated, url, expected }) => {
      const { interaction } = newInteraction();
      discordMock.getEmotes.mockResolvedValue([{ id: '1', identifier: 'catJAM:1', name: 'catJAM', url, animated }]);

      await syncEmotes(interaction);

      expect(zulipMock.createEmote).toHaveBeenCalledOnce();
      expect(zulipMock.createEmote).toHaveBeenCalledWith('catjam', expected);
      expect(mattermostMock.createEmote).toHaveBeenCalledOnce();
      expect(mattermostMock.createEmote).toHaveBeenCalledWith('catJAM', expected);
    });

    it('should defer the reply, upload each emote to Zulip then Mattermost one at a time, then edit the reply', async () => {
      const { interaction, deferReply, reply } = newInteraction();
      discordMock.getEmotes.mockResolvedValue([
        {
          id: '1',
          identifier: 'catJAM:1',
          name: 'catJAM',
          url: 'https://cdn.discordapp.com/emojis/1.webp',
          animated: false,
        },
        {
          id: '2',
          identifier: 'pepeD:2',
          name: 'pepeD',
          url: 'https://cdn.discordapp.com/emojis/2.webp',
          animated: false,
        },
      ]);

      await syncEmotes(interaction);

      const [defer] = deferReply.mock.invocationCallOrder;
      const [getEmotes] = discordMock.getEmotes.mock.invocationCallOrder;
      const [listEmoji] = zulipMock.listEmoji.mock.invocationCallOrder;
      const [zulipFirst, zulipSecond] = zulipMock.createEmote.mock.invocationCallOrder;
      const [mattermostFirst, mattermostSecond] = mattermostMock.createEmote.mock.invocationCallOrder;
      const [edit] = reply.edit.mock.invocationCallOrder;
      expect(defer).toBeLessThan(getEmotes);
      expect(getEmotes).toBeLessThan(zulipFirst);
      expect(getEmotes).toBeLessThan(listEmoji);
      expect(listEmoji).toBeLessThan(zulipFirst);
      expect(zulipFirst).toBeLessThan(mattermostFirst);
      expect(mattermostFirst).toBeLessThan(zulipSecond);
      expect(zulipSecond).toBeLessThan(mattermostSecond);
      expect(mattermostSecond).toBeLessThan(edit);
    });

    describe('Zulip names', () => {
      const emote = (name: string, id: number) => ({
        id: String(id),
        identifier: `${name}:${id}`,
        name,
        url: `https://cdn.discordapp.com/emojis/${id}.webp`,
        animated: false,
      });

      it.each([
        { name: 'catJAM', expected: 'catjam' },
        { name: 'pepe_D', expected: 'pepe_d' },
        { name: 'kekw-2', expected: 'kekw-2' },
        { name: 'nameless:3', expected: 'nameless_3' },
        { name: 'a:animated:4', expected: 'a_animated_4' },
        { name: 'dot.ted', expected: 'dot_ted' },
        { name: 'space bar', expected: 'space_bar' },
        { name: 'trailing_', expected: 'trailing' },
        { name: 'trailing-_', expected: 'trailing' },
        { name: '___', expected: 'emote' },
      ])('should upload $name to Zulip as $expected', async ({ name, expected }) => {
        const { interaction } = newInteraction();
        discordMock.getEmotes.mockResolvedValue([emote(name, 1)]);

        await syncEmotes(interaction);

        expect(zulipMock.createEmote).toHaveBeenCalledOnce();
        expect(zulipMock.createEmote).toHaveBeenCalledWith(expected, 'https://cdn.discordapp.com/emojis/1.webp');
        expect(mattermostMock.createEmote).toHaveBeenCalledWith(name, 'https://cdn.discordapp.com/emojis/1.webp');
      });

      it('should not report a name that only changed case', async () => {
        const { interaction, reply } = newInteraction();
        discordMock.getEmotes.mockResolvedValue([emote('catJAM', 1)]);

        await syncEmotes(interaction);

        expect(reply.edit).toHaveBeenCalledWith('Done syncing: 1 emote, 1 uploaded to Zulip, 1 uploaded to Mattermost');
      });

      it('should suffix the names of emotes that collide within the run, in Discord order, and report them', async () => {
        const { interaction, reply } = newInteraction();
        discordMock.getEmotes.mockResolvedValue([emote('catJAM', 1), emote('CatJam', 2), emote('CATJAM', 3)]);

        await syncEmotes(interaction);

        expect(zulipMock.createEmote.mock.calls).toEqual([
          ['catjam', 'https://cdn.discordapp.com/emojis/1.webp'],
          ['catjam2', 'https://cdn.discordapp.com/emojis/2.webp'],
          ['catjam3', 'https://cdn.discordapp.com/emojis/3.webp'],
        ]);
        expect(mattermostMock.createEmote.mock.calls).toEqual([
          ['catJAM', 'https://cdn.discordapp.com/emojis/1.webp'],
          ['CatJam', 'https://cdn.discordapp.com/emojis/2.webp'],
          ['CATJAM', 'https://cdn.discordapp.com/emojis/3.webp'],
        ]);
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 3 emotes, 3 uploaded to Zulip, 3 uploaded to Mattermost, 2 renamed: CatJam → catjam2, CATJAM → catjam3',
        );
      });

      it('should suffix an emote named like a Zulip built-in emoji instead of uploading under the built-in name', async () => {
        const { interaction, reply } = newInteraction();
        discordMock.getEmotes.mockResolvedValue([emote('fire', 1), emote('Tada', 2), emote('catJAM', 3)]);

        await syncEmotes(interaction);

        expect(zulipMock.getEmojiCodes).toHaveBeenCalledOnce();
        expect(zulipMock.createEmote.mock.calls).toEqual([
          ['fire2', 'https://cdn.discordapp.com/emojis/1.webp'],
          ['tada2', 'https://cdn.discordapp.com/emojis/2.webp'],
          ['catjam', 'https://cdn.discordapp.com/emojis/3.webp'],
        ]);
        expect(mattermostMock.createEmote.mock.calls).toEqual([
          ['fire', 'https://cdn.discordapp.com/emojis/1.webp'],
          ['Tada', 'https://cdn.discordapp.com/emojis/2.webp'],
          ['catJAM', 'https://cdn.discordapp.com/emojis/3.webp'],
        ]);
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 3 emotes, 3 uploaded to Zulip, 3 uploaded to Mattermost, 2 renamed: fire → fire2, Tada → tada2',
        );
      });

      it('should suffix an emote named like the Zulip logo emoji, which is not in the built-in table', async () => {
        const { interaction, reply } = newInteraction();
        discordMock.getEmotes.mockResolvedValue([emote('Zulip', 1), emote('zulip', 2)]);

        await syncEmotes(interaction);

        expect(zulipMock.createEmote.mock.calls).toEqual([
          ['zulip2', 'https://cdn.discordapp.com/emojis/1.webp'],
          ['zulip3', 'https://cdn.discordapp.com/emojis/2.webp'],
        ]);
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 2 emotes, 2 uploaded to Zulip, 2 uploaded to Mattermost, 2 renamed: Zulip → zulip2, zulip → zulip3',
        );
      });

      it('should skip a suffix that is built-in or already claimed in the run', async () => {
        const { interaction, reply } = newInteraction();
        zulipMock.getEmojiCodes.mockResolvedValue({ unicode: { fire: '🔥', fire3: '🔥' }, names: {} });
        discordMock.getEmotes.mockResolvedValue([emote('fire2', 1), emote('fire', 2), emote('FIRE', 3)]);

        await syncEmotes(interaction);

        expect(zulipMock.createEmote.mock.calls).toEqual([
          ['fire2', 'https://cdn.discordapp.com/emojis/1.webp'],
          ['fire4', 'https://cdn.discordapp.com/emojis/2.webp'],
          ['fire5', 'https://cdn.discordapp.com/emojis/3.webp'],
        ]);
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 3 emotes, 3 uploaded to Zulip, 3 uploaded to Mattermost, 2 renamed: fire → fire4, FIRE → fire5',
        );
      });

      it('should count a realm emoji that already overrides a built-in name as that emote, uploading no suffixed copy', async () => {
        const { interaction, reply } = newInteraction();
        zulipMock.listEmoji.mockResolvedValue([{ id: '1', name: 'fire', deactivated: false }]);
        discordMock.getEmotes.mockResolvedValue([emote('fire', 1), emote('Fire', 2), emote('tada', 3)]);

        await syncEmotes(interaction);

        expect(zulipMock.createEmote.mock.calls).toEqual([
          ['fire2', 'https://cdn.discordapp.com/emojis/2.webp'],
          ['tada2', 'https://cdn.discordapp.com/emojis/3.webp'],
        ]);
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 3 emotes, 2 uploaded to Zulip, 3 uploaded to Mattermost, 2 renamed: Fire → fire2, tada → tada2, 1 already on Zulip: fire',
        );
      });

      it('should suffix an emote named like a built-in whose override is deactivated', async () => {
        const { interaction } = newInteraction();
        zulipMock.listEmoji.mockResolvedValue([{ id: '1', name: 'fire', deactivated: true }]);
        discordMock.getEmotes.mockResolvedValue([emote('fire', 1)]);

        await syncEmotes(interaction);

        expect(zulipMock.createEmote).toHaveBeenCalledExactlyOnceWith(
          'fire2',
          'https://cdn.discordapp.com/emojis/1.webp',
        );
      });

      it('should skip an emote whose name is already on Zulip instead of uploading it again', async () => {
        const { interaction, reply } = newInteraction();
        discordMock.getEmotes.mockResolvedValue([emote('catJAM', 1), emote('pepeD', 2)]);
        zulipMock.listEmoji.mockResolvedValue([{ id: '1', name: 'catjam', deactivated: false }]);

        await syncEmotes(interaction);

        expect(zulipMock.createEmote).toHaveBeenCalledOnce();
        expect(zulipMock.createEmote).toHaveBeenCalledWith('peped', 'https://cdn.discordapp.com/emojis/2.webp');
        expect(mattermostMock.createEmote).toHaveBeenCalledTimes(2);
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 2 emotes, 1 uploaded to Zulip, 2 uploaded to Mattermost, 1 already on Zulip: catJAM',
        );
      });

      it('should treat a deactivated Zulip emoji as absent', async () => {
        const { interaction, reply } = newInteraction();
        discordMock.getEmotes.mockResolvedValue([emote('catJAM', 1)]);
        zulipMock.listEmoji.mockResolvedValue([{ id: '1', name: 'catjam', deactivated: true }]);

        await syncEmotes(interaction);

        expect(zulipMock.createEmote).toHaveBeenCalledOnce();
        expect(zulipMock.createEmote).toHaveBeenCalledWith('catjam', 'https://cdn.discordapp.com/emojis/1.webp');
        expect(reply.edit).toHaveBeenCalledWith('Done syncing: 1 emote, 1 uploaded to Zulip, 1 uploaded to Mattermost');
      });

      it('should be a no-op on Zulip when synced twice, suffixed and built-in names included', async () => {
        discordMock.getEmotes.mockResolvedValue([
          emote('catJAM', 1),
          emote('CatJam', 2),
          emote('nameless:3', 3),
          emote('wave', 4),
        ]);

        await syncEmotes(newInteraction().interaction);

        expect(zulipMock.createEmote.mock.calls).toEqual([
          ['catjam', 'https://cdn.discordapp.com/emojis/1.webp'],
          ['catjam2', 'https://cdn.discordapp.com/emojis/2.webp'],
          ['nameless_3', 'https://cdn.discordapp.com/emojis/3.webp'],
          ['wave2', 'https://cdn.discordapp.com/emojis/4.webp'],
        ]);

        zulipMock.createEmote.mockClear();
        zulipMock.listEmoji.mockResolvedValue(
          ['catjam', 'catjam2', 'nameless_3', 'wave2'].map((name, index) => ({
            id: String(index),
            name,
            deactivated: false,
          })),
        );
        const { interaction, reply } = newInteraction();

        await syncEmotes(interaction);

        expect(zulipMock.createEmote).not.toHaveBeenCalled();
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 4 emotes, 0 uploaded to Zulip, 4 uploaded to Mattermost, 4 already on Zulip: catJAM, CatJam → catjam2, nameless:3 → nameless_3, wave → wave2',
        );
      });
    });

    it('should report a server with no emotes as such, uploading nothing', async () => {
      const { interaction, reply } = newInteraction();
      discordMock.getEmotes.mockResolvedValue([]);

      await syncEmotes(interaction);

      expect(zulipMock.createEmote).not.toHaveBeenCalled();
      expect(mattermostMock.createEmote).not.toHaveBeenCalled();
      expect(reply.edit).toHaveBeenCalledWith(
        'Done syncing: the Discord server has no emotes, so nothing was uploaded',
      );
    });

    it('should fail, uploading nothing, when the bot cannot see the server', async () => {
      discordMock.getEmotes.mockResolvedValue(undefined);

      await expect(sut.syncEmotes('guild-1')).rejects.toThrow(
        'Cannot read the emotes of Discord server guild-1: the bot is not logged in to Discord, or not a member of that server',
      );

      expect(zulipMock.listEmoji).not.toHaveBeenCalled();
      expect(zulipMock.createEmote).not.toHaveBeenCalled();
      expect(mattermostMock.createEmote).not.toHaveBeenCalled();
    });

    describe('Mattermost names', () => {
      const emotes = [
        {
          id: '1',
          identifier: 'catJAM:1',
          name: 'catJAM',
          url: 'https://cdn.discordapp.com/emojis/1.webp',
          animated: false,
        },
        {
          id: '2',
          identifier: 'pepeD:2',
          name: 'pepeD',
          url: 'https://cdn.discordapp.com/emojis/2.webp',
          animated: false,
        },
      ];
      const duplicate = () =>
        new ClientError('https://mattermost.example.com', {
          message: 'Unable to create emoji. Another emoji with the same name already exists.',
          server_error_id: 'api.emoji.create.duplicate.app_error',
          status_code: 400,
          url: 'https://mattermost.example.com/api/v4/emoji',
        });

      beforeEach(() => {
        vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        discordMock.getEmotes.mockResolvedValue(emotes);
      });

      afterEach(() => {
        vitest.restoreAllMocks();
      });

      it('should skip a name Mattermost already has instead of uploading it again, and say so', async () => {
        const { interaction, reply } = newInteraction();
        mattermostMock.listEmoji.mockResolvedValue(['catJAM', 'someone_elses']);

        await syncEmotes(interaction);

        expect(mattermostMock.createEmote.mock.calls).toEqual([['pepeD', 'https://cdn.discordapp.com/emojis/2.webp']]);
        expect(zulipMock.createEmote).toHaveBeenCalledTimes(2);
        expect(Logger.prototype.error).not.toHaveBeenCalled();
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 2 emotes, 2 uploaded to Zulip, 1 uploaded to Mattermost, 1 already on Mattermost: catJAM',
        );
      });

      it('should count a name Mattermost refuses as a duplicate as already there, not as a failure', async () => {
        const { interaction, reply } = newInteraction();
        mattermostMock.createEmote.mockRejectedValueOnce(duplicate());

        await syncEmotes(interaction);

        expect(mattermostMock.createEmote).toHaveBeenCalledTimes(2);
        expect(Logger.prototype.error).not.toHaveBeenCalled();
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 2 emotes, 2 uploaded to Zulip, 1 uploaded to Mattermost, 1 already on Mattermost: catJAM',
        );
      });

      it('should still report another Mattermost refusal as a failure', async () => {
        const { interaction, reply } = newInteraction();
        mattermostMock.createEmote.mockRejectedValueOnce(
          new ClientError('https://mattermost.example.com', {
            message: 'Invalid emoji name.',
            server_error_id: 'model.emoji.name.app_error',
            status_code: 400,
          }),
        );

        await syncEmotes(interaction);

        expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
          'Could not sync emote catJAM - https://cdn.discordapp.com/emojis/1.webp to Mattermost',
          expect.any(ClientError),
        );
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 2 emotes, 2 uploaded to Zulip, 1 uploaded to Mattermost, 1 failed: catJAM',
        );
      });

      it('should upload every emote when Mattermost cannot list its emoji, still counting a duplicate as already there', async () => {
        const { interaction, reply } = newInteraction();
        mattermostMock.listEmoji.mockRejectedValue(new Error('fetch failed'));
        mattermostMock.createEmote.mockRejectedValueOnce(duplicate());

        await syncEmotes(interaction);

        expect(mattermostMock.createEmote).toHaveBeenCalledTimes(2);
        expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
          'Could not list the Mattermost emoji, so every emote is uploaded and a name Mattermost already has counts as already there',
          expect.any(Error),
        );
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 2 emotes, 2 uploaded to Zulip, 1 uploaded to Mattermost, 1 already on Mattermost: catJAM',
        );
      });
    });

    describe('failures', () => {
      const emotes = [
        {
          id: '1',
          identifier: 'catJAM:1',
          name: 'catJAM',
          url: 'https://cdn.discordapp.com/emojis/1.webp',
          animated: false,
        },
        {
          id: '2',
          identifier: 'pepeD:2',
          name: 'pepeD',
          url: 'https://cdn.discordapp.com/emojis/2.webp',
          animated: false,
        },
        {
          id: '3',
          identifier: 'nameless:3',
          name: null,
          url: 'https://cdn.discordapp.com/emojis/3.png',
          animated: false,
        },
      ];
      const zulipUploads = [
        ['catjam', 'https://cdn.discordapp.com/emojis/1.webp'],
        ['peped', 'https://cdn.discordapp.com/emojis/2.webp'],
        ['nameless_3', 'https://cdn.discordapp.com/emojis/3.png'],
      ];
      const mattermostUploads = [
        ['catJAM', 'https://cdn.discordapp.com/emojis/1.webp'],
        ['pepeD', 'https://cdn.discordapp.com/emojis/2.webp'],
        ['nameless:3', 'https://cdn.discordapp.com/emojis/3.png'],
      ];
      const renamed = '1 renamed: nameless:3 → nameless_3';

      beforeEach(() => {
        vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        discordMock.getEmotes.mockResolvedValue(emotes);
      });

      afterEach(() => {
        vitest.restoreAllMocks();
      });

      it('should keep syncing when a Zulip upload fails and report the emote', async () => {
        const { interaction, reply } = newInteraction();
        zulipMock.createEmote.mockRejectedValueOnce(new Error('This endpoint does not accept bot requests'));

        await syncEmotes(interaction);

        expect(zulipMock.createEmote.mock.calls).toEqual(zulipUploads);
        expect(mattermostMock.createEmote.mock.calls).toEqual(mattermostUploads);
        expect(Logger.prototype.error).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'Could not sync emote catJAM - https://cdn.discordapp.com/emojis/1.webp to Zulip',
          expect.any(Error),
        );
        expect(reply.edit).toHaveBeenCalledOnce();
        expect(reply.edit).toHaveBeenCalledWith(
          `Done syncing: 3 emotes, 2 uploaded to Zulip, 3 uploaded to Mattermost, 1 failed: catJAM, ${renamed}`,
        );
      });

      it('should keep syncing when a Mattermost upload fails and report the emote', async () => {
        const { interaction, reply } = newInteraction();
        mattermostMock.createEmote.mockResolvedValueOnce().mockRejectedValueOnce(new Error('boom'));

        await syncEmotes(interaction);

        expect(zulipMock.createEmote.mock.calls).toEqual(zulipUploads);
        expect(mattermostMock.createEmote.mock.calls).toEqual(mattermostUploads);
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'Could not sync emote pepeD - https://cdn.discordapp.com/emojis/2.webp to Mattermost',
          expect.any(Error),
        );
        expect(reply.edit).toHaveBeenCalledWith(
          `Done syncing: 3 emotes, 3 uploaded to Zulip, 2 uploaded to Mattermost, 1 failed: pepeD, ${renamed}`,
        );
      });

      it('should report each failed emote once, whichever platforms failed', async () => {
        const { interaction, reply } = newInteraction();
        zulipMock.createEmote.mockRejectedValueOnce(new Error('zulip')).mockRejectedValueOnce(new Error('zulip'));
        mattermostMock.createEmote.mockRejectedValueOnce(new Error('mattermost'));

        await syncEmotes(interaction);

        expect(zulipMock.createEmote.mock.calls).toEqual(zulipUploads);
        expect(mattermostMock.createEmote.mock.calls).toEqual(mattermostUploads);
        expect(Logger.prototype.error).toHaveBeenCalledTimes(3);
        expect(reply.edit).toHaveBeenCalledWith(
          `Done syncing: 3 emotes, 1 uploaded to Zulip, 2 uploaded to Mattermost, 2 failed: catJAM, pepeD, ${renamed}`,
        );
      });

      it('should skip Zulip and say so, blaming no emote, when the realm emoji cannot be listed, and still sync Mattermost', async () => {
        const { interaction, reply } = newInteraction();
        zulipMock.listEmoji.mockRejectedValue(new Error('Zulip client not initialised'));

        await syncEmotes(interaction);

        expect(zulipMock.getEmojiCodes).not.toHaveBeenCalled();
        expect(zulipMock.createEmote).not.toHaveBeenCalled();
        expect(mattermostMock.createEmote.mock.calls).toEqual(mattermostUploads);
        expect(Logger.prototype.error).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'Could not list the Zulip emoji, skipping the Zulip side of the sync',
          expect.any(Error),
        );
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 3 emotes, 0 uploaded to Zulip (skipped: its emoji could not be listed), 3 uploaded to Mattermost',
        );
      });

      it('should skip Mattermost and say so when it is not configured, and still sync Zulip', async () => {
        const { interaction, reply } = newInteraction();
        mattermostMock.isInitialised.mockReturnValue(false);

        await syncEmotes(interaction);

        expect(mattermostMock.listEmoji).not.toHaveBeenCalled();
        expect(mattermostMock.createEmote).not.toHaveBeenCalled();
        expect(zulipMock.createEmote).toHaveBeenCalledTimes(3);
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 3 emotes, 3 uploaded to Zulip, 0 uploaded to Mattermost (skipped: not configured), 1 renamed: nameless:3 → nameless_3',
        );
      });

      it('should still report a Mattermost failure when Zulip was skipped', async () => {
        const { interaction, reply } = newInteraction();
        zulipMock.listEmoji.mockRejectedValue(new Error('Zulip client not initialised'));
        mattermostMock.createEmote.mockResolvedValueOnce().mockRejectedValueOnce(new Error('boom'));

        await syncEmotes(interaction);

        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 3 emotes, 0 uploaded to Zulip (skipped: its emoji could not be listed), 2 uploaded to Mattermost, 1 failed: pepeD',
        );
      });

      it('should skip Zulip and say so when the built-in emoji names cannot be read, and still sync Mattermost', async () => {
        const { interaction, reply } = newInteraction();
        zulipMock.getEmojiCodes.mockRejectedValue(new Error('Could not fetch the Zulip emoji codes: 502'));

        await syncEmotes(interaction);

        expect(zulipMock.createEmote).not.toHaveBeenCalled();
        expect(mattermostMock.createEmote.mock.calls).toEqual(mattermostUploads);
        expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
          'Could not fetch the Zulip built-in emoji names, skipping the Zulip side of the sync',
          expect.any(Error),
        );
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 3 emotes, 0 uploaded to Zulip (skipped: its built-in emoji names could not be read), 3 uploaded to Mattermost',
        );
      });

      describe('Zulip refusing the user account', () => {
        const unauthorized = () =>
          new ZulipApiError(401, 'UNAUTHORIZED', 'Malformed API key', 'POST /api/v1/realm/emoji/peped');
        const REFUSED =
          'Zulip refused the credentials of the user account that uploads emoji (Malformed API key), so no more emotes are uploaded to Zulip in this sync; check ZULIP_USER_USERNAME and ZULIP_USER_API_KEY';

        it('should stop uploading to Zulip, log it once without the key, blame no emote, and keep syncing Mattermost', async () => {
          const { interaction, reply } = newInteraction();
          zulipMock.createEmote.mockRejectedValue(unauthorized());

          await syncEmotes(interaction);

          expect(zulipMock.createEmote).toHaveBeenCalledOnce();
          expect(mattermostMock.createEmote.mock.calls).toEqual(mattermostUploads);
          expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(REFUSED);
          expect(reply.edit).toHaveBeenCalledWith(
            'Done syncing: 3 emotes, 0 uploaded to Zulip (skipped: Zulip refused the credentials of the user account that uploads emoji), 3 uploaded to Mattermost',
          );
        });

        it('should count what Zulip took before it refused, and report no rename it did not make', async () => {
          const { interaction, reply } = newInteraction();
          zulipMock.createEmote.mockResolvedValueOnce().mockRejectedValue(unauthorized());

          await syncEmotes(interaction);

          expect(zulipMock.createEmote.mock.calls).toEqual(zulipUploads.slice(0, 2));
          expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(REFUSED);
          expect(reply.edit).toHaveBeenCalledWith(
            'Done syncing: 3 emotes, 1 uploaded to Zulip (skipped: Zulip refused the credentials of the user account that uploads emoji), 3 uploaded to Mattermost',
          );
        });

        it('should still fail an emote on another Zulip error', async () => {
          const { interaction, reply } = newInteraction();
          zulipMock.createEmote.mockRejectedValueOnce(
            new ZulipApiError(
              400,
              'BAD_REQUEST',
              'Invalid characters in emoji name',
              'POST /api/v1/realm/emoji/catjam',
            ),
          );

          await syncEmotes(interaction);

          expect(zulipMock.createEmote).toHaveBeenCalledTimes(3);
          expect(reply.edit).toHaveBeenCalledWith(
            `Done syncing: 3 emotes, 2 uploaded to Zulip, 3 uploaded to Mattermost, 1 failed: catJAM, ${renamed}`,
          );
        });
      });

      it("should keep the report within Discord's message limit when every emote fails", async () => {
        const { interaction, reply } = newInteraction();
        discordMock.getEmotes.mockResolvedValue(
          Array.from({ length: 300 }, (_, index) => ({
            id: String(index),
            identifier: `emote_number_${index}:${index}`,
            name: `emote_number_${index}`,
            url: `https://cdn.discordapp.com/emojis/${index}.webp`,
            animated: false,
          })),
        );
        zulipMock.createEmote.mockRejectedValue(new Error('This endpoint does not accept bot requests'));

        await syncEmotes(interaction);

        expect(zulipMock.createEmote).toHaveBeenCalledTimes(300);
        expect(mattermostMock.createEmote).toHaveBeenCalledTimes(300);
        expect(reply.edit).toHaveBeenCalledOnce();
        const [report] = reply.edit.mock.calls[0] as [string];
        expect(report).toMatch(
          /^Done syncing: 300 emotes, 0 uploaded to Zulip, 300 uploaded to Mattermost, 300 failed: emote_number_0, /,
        );
        expect(report).toMatch(/\.\.\.$/);
        expect(report).toHaveLength(2000);
      });
    });
  });

  describe('hasBlacklistedUrl', () => {
    it('should flag GitHub, my.immich.app and docs links, whose previews are suppressed', () => {
      expect(hasBlacklistedUrl(['https://example.com', 'https://github.com/immich-app/immich/pull/1'])).toBe(true);
      expect(hasBlacklistedUrl(['https://my.immich.app/photos'])).toBe(true);
      expect(hasBlacklistedUrl(['https://docs.immich.app/install'])).toBe(true);
    });

    it('should let other links keep their previews', () => {
      expect(hasBlacklistedUrl([])).toBe(false);
      expect(hasBlacklistedUrl(['https://example.com/https://github.com'])).toBe(false);
      expect(sut.hasBlacklistUrl(['https://immich.app'])).toBe(false);
    });
  });

  describe('toZulipEmojiName', () => {
    it.each([
      { name: 'catJam', expected: 'catjam' },
      { name: 'party.parrot', expected: 'party_parrot' },
      { name: 'wave_-', expected: 'wave' },
      { name: '__', expected: 'emote' },
    ])('should turn $name into $expected', ({ name, expected }) => {
      expect(toZulipEmojiName(name)).toBe(expected);
    });
  });

  describe('formatEmoteSyncReport', () => {
    const report = {
      total: 3,
      zulipUploaded: 1,
      mattermostUploaded: 2,
      failed: ['pepeD'],
      renamed: [],
      alreadyOnZulip: ['catJAM'],
      alreadyOnMattermost: ['kekw'],
    };

    it('should start with "Done syncing" and say how many were uploaded where when no subject is given, as Discord posts it', () => {
      expect(formatEmoteSyncReport(report)).toBe(
        'Done syncing: 3 emotes, 1 uploaded to Zulip, 2 uploaded to Mattermost, 1 failed: pepeD, 1 already on Zulip: catJAM, 1 already on Mattermost: kekw',
      );
    });

    it('should name the subject when one is given, as the Zulip command does, since its target is not where it is run', () => {
      expect(formatEmoteSyncReport(report, 'the emotes of the Immich Discord server (979116623879368755)')).toBe(
        'Done syncing the emotes of the Immich Discord server (979116623879368755): 3 emotes, 1 uploaded to Zulip, 2 uploaded to Mattermost, 1 failed: pepeD, 1 already on Zulip: catJAM, 1 already on Mattermost: kekw',
      );
    });

    it('should say so plainly when the server has no emotes', () => {
      const empty = {
        ...report,
        total: 0,
        zulipUploaded: 0,
        mattermostUploaded: 0,
        failed: [],
        alreadyOnZulip: [],
        alreadyOnMattermost: [],
      };

      expect(formatEmoteSyncReport(empty)).toBe(
        'Done syncing: the Discord server has no emotes, so nothing was uploaded',
      );
    });
  });

  describe('updateFourthwallOrders', () => {
    const price = (value: number) => ({ value, currency: 'USD' });
    const order = {
      status: 'SHIPPED',
      discount: null,
      totalPrice: price(30),
      profit: price(10),
      currentAmounts: { shipping: price(5), tax: price(2) },
    };

    it('should fetch the order again and update its row', async () => {
      fourthwallMock.getOrder.mockResolvedValue(order as never);

      await sut.updateFourthwallOrders('ORD-1');

      expect(fourthwallMock.getOrder).toHaveBeenCalledExactlyOnceWith({
        id: 'ORD-1',
        user: 'fw-user',
        password: 'fw-password',
      });
      expect(databaseMock.updateFourthwallOrder).toHaveBeenCalledExactlyOnceWith({
        id: 'ORD-1',
        discount: undefined,
        status: 'SHIPPED',
        total: 30,
        profit: 10,
        shipping: 5,
        tax: 2,
      });
    });

    it.each([
      { what: 'an error body', answer: { status: 401, message: 'Unauthorized' } },
      { what: 'an order without its prices', answer: { ...order, totalPrice: undefined } },
      { what: 'nothing', answer: null },
    ])('should fail saying which order, and write nothing, when Fourthwall answers $what', async ({ answer }) => {
      fourthwallMock.getOrder.mockResolvedValue(answer as never);

      await expect(sut.updateFourthwallOrders('ORD-404')).rejects.toThrow(
        'Fourthwall did not return order ORD-404: the ID may be wrong, or Fourthwall refused the request or is down',
      );
      expect(databaseMock.updateFourthwallOrder).not.toHaveBeenCalled();
    });
  });

  describe('handleFindSimilarIssuesOrDiscussions', () => {
    const hits = [
      {
        similarity: 0.912,
        number: 1,
        item_type: 'issue' as const,
        title: 'Thumbnails crash](https://evil.example) [',
        state: 'open' as const,
        state_reason: null,
      },
      {
        similarity: 0.8,
        number: 2,
        item_type: 'discussion' as const,
        title: 'Ping @**all**',
        state: 'open' as const,
        state_reason: null,
      },
    ];

    it('should list each hit with its title as it is and a link of its own, as Discord posts it', async () => {
      loopDedupeMock.getForText.mockResolvedValue(hits);

      await expect(sut.handleFindSimilarIssuesOrDiscussions('the thumbnails crash')).resolves.toBe(
        [
          '[Issue] Thumbnails crash](https://evil.example) [ ([immich-app/immich#1](https://github.com/immich-app/immich/issues/1)), Similarity: 0.912',
          '[Discussion] Ping @**all** ([immich-app/immich#2](https://github.com/immich-app/immich/discussions/2)), Similarity: 0.800',
        ].join('\n'),
      );
      expect(loopDedupeMock.getForText).toHaveBeenCalledExactlyOnceWith('the thumbnails crash');
    });

    it('should run the title, and only the title, through the neutraliser given', async () => {
      loopDedupeMock.getForText.mockResolvedValue(hits);

      await expect(
        sut.handleFindSimilarIssuesOrDiscussions(
          'the thumbnails crash',
          (title) => `<${title.replaceAll('](', ']|(')}>`,
        ),
      ).resolves.toBe(
        [
          '[Issue] <Thumbnails crash]|(https://evil.example) [> ([immich-app/immich#1](https://github.com/immich-app/immich/issues/1)), Similarity: 0.912',
          '[Discussion] <Ping @**all**> ([immich-app/immich#2](https://github.com/immich-app/immich/discussions/2)), Similarity: 0.800',
        ].join('\n'),
      );
    });

    it("should leave only the bot's own link in a line when given the Zulip label neutraliser", async () => {
      loopDedupeMock.getForText.mockResolvedValue([
        { ...hits[0], title: '[x](https://evil.example) lone [ and ] brackets' },
      ]);

      await expect(sut.handleFindSimilarIssuesOrDiscussions('crash', neutraliseZulipLabel)).resolves.toBe(
        '[Issue] &#91;x&#93;(https://evil.example) lone &#91; and &#93; brackets ([immich-app/immich#1](https://github.com/immich-app/immich/issues/1)), Similarity: 0.912',
      );
    });

    it('should answer nothing when there is no hit', async () => {
      loopDedupeMock.getForText.mockResolvedValue([]);

      await expect(sut.handleFindSimilarIssuesOrDiscussions('anything')).resolves.toBe('');
    });
  });

  describe('bot-spam', () => {
    let errorMock: MockInstance;
    let fatalMock: MockInstance;

    beforeEach(() => {
      zulipMock.isInitialised.mockReturnValue(true);
      zulipMock.sendMessage.mockResolvedValue({ id: 1 });
      for (const level of ['log', 'verbose'] as const) {
        vitest.spyOn(Logger.prototype, level).mockImplementation(() => {});
      }
      errorMock = vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      fatalMock = vitest.spyOn(Logger.prototype, 'fatal').mockImplementation(() => {});
    });

    afterEach(() => {
      config.botToken = 'dev';
      vitest.useRealTimers();
      vitest.restoreAllMocks();
    });

    // The announcement reads package.json from disk, which can outlast waitFor's 1s default on a loaded machine.
    const ANNOUNCE_WAIT_MS = 10_000;
    const alive =
      "I'm alive, running 1.0.0@[01234567](https://github.com/immich-app/discord-bot/commit/0123456789abcdef)!";
    const announced = { stream: 113, topic: 'bot', content: alive };

    it('should log in to Discord, then announce the running version on Discord bot-spam and the Zulip bot topic', async () => {
      config.botToken = 'token';
      let ready = () => {};
      discordMock.login.mockReturnValue(new Promise<void>((resolve) => (ready = resolve)));
      const version = vitest.spyOn(sut, 'getVersionMessage' as never);

      const loggingIn = sut.loginToDiscord();
      await new Promise((resolve) => setImmediate(resolve));
      expect(version).not.toHaveBeenCalled();
      ready();
      await loggingIn;

      expect(discordMock.login).toHaveBeenCalledExactlyOnceWith('token');
      await vitest.waitFor(() => expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith(announced), {
        timeout: ANNOUNCE_WAIT_MS,
      });
      expect(discordMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        channelId: DiscordChannel.BotSpam,
        message: alive,
      });
    });

    it('should announce on Zulip alone, logging no failure, with the dev token', async () => {
      discordMock.isReady.mockReturnValue(false);

      await sut.loginToDiscord();

      await vitest.waitFor(() => expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith(announced), {
        timeout: ANNOUNCE_WAIT_MS,
      });
      expect(discordMock.login).not.toHaveBeenCalled();
      expect(discordMock.sendMessage).not.toHaveBeenCalled();
      expect(errorMock).not.toHaveBeenCalled();
      expect(fatalMock).not.toHaveBeenCalled();
    });

    it('should report a failed Discord login on Zulip instead of announcing, and fail the boot', async () => {
      config.botToken = 'revoked';
      discordMock.isReady.mockReturnValue(false);
      discordMock.login.mockRejectedValue(new Error('An invalid token was provided.'));
      const version = vitest.spyOn(sut, 'getVersionMessage' as never);

      await expect(sut.loginToDiscord()).rejects.toThrow('An invalid token was provided.');

      expect(version).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        stream: 113,
        topic: 'bot',
        content: 'Discord login failed:\n~~~ quote\nError: An invalid token was provided.\n~~~',
      });
      expect(discordMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should announce on Zulip alone once Discord has not turned ready for a minute', async () => {
      vitest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      config.botToken = 'token';
      discordMock.isReady.mockReturnValue(false);
      discordMock.login.mockReturnValue(new Promise(() => {}));
      const version = vitest.spyOn(sut, 'getVersionMessage' as never);

      void sut.loginToDiscord();
      await vitest.advanceTimersByTimeAsync(59_999);
      expect(version).not.toHaveBeenCalled();
      await vitest.advanceTimersByTimeAsync(1);

      await vitest.waitFor(() => expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith(announced), {
        timeout: ANNOUNCE_WAIT_MS,
      });
      expect(discordMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should post nothing when Discord turns ready: the start is announced once per process', () => {
      sut.onReady();

      expect(discordMock.sendMessage).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should report a Discord client error on Discord bot-spam and the Zulip bot topic', async () => {
      await sut.onError(new Error('gateway closed by @**all**'));

      expect(discordMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        channelId: DiscordChannel.BotSpam,
        message: 'Discord bot error: Error: gateway closed by @**all**',
      });
      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        stream: 113,
        topic: 'bot',
        content: 'Discord bot error:\n~~~ quote\nError: gateway closed by @\u200B**all**\n~~~',
      });
    });

    it('should report once and resolve when neither platform takes the report', async () => {
      discordMock.sendMessage.mockRejectedValue(new Error('discord down'));
      zulipMock.sendMessage.mockRejectedValue(new Error('zulip down'));

      await expect(sut.onError(new Error('boom'))).resolves.toBeUndefined();

      expect(discordMock.sendMessage).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
      expect(errorMock.mock.calls.map(([message]) => message)).toEqual([
        'Discord bot error',
        'Could not notify team.bot on discord: Error: discord down',
        'Could not notify team.bot on zulip: Error: zulip down',
      ]);
      expect(fatalMock).toHaveBeenCalledExactlyOnceWith(
        'Could not notify team.bot on any platform: notification dropped',
      );
    });

    it('should ignore a send to a thread Discord has not finished creating', async () => {
      const error = new Error('Unknown Message');
      error.name = 'DiscordAPIError[10008]';

      await sut.onError(error);

      expect(discordMock.sendMessage).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('init', () => {
    afterEach(() => {
      vitest.restoreAllMocks();
    });

    it('should leave Zulip initialisation to ZulipService', async () => {
      await sut.init();

      expect(zulipMock.init).not.toHaveBeenCalled();
      expect(mattermostMock.init).toHaveBeenCalledOnce();
    });

    it('should subscribe the Zulip expanders to the event loop', async () => {
      databaseMock.getZulipExpanders.mockResolvedValue([
        { streamId: 107, expander: 'github', createdBy: 'migration', createdAt: new Date(0) },
      ]);
      await zulipExpanders.init();
      await sut.init();

      expect(zulipServiceMock.onMessage).toHaveBeenCalledOnce();
      const [handler] = zulipServiceMock.onMessage.mock.calls[0];
      await handler(zulipMessage({ content: 'see #4242' }));
      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
    });

    it('should report what a Discord handler throws as a Discord bot error', async () => {
      vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      await sut.init();

      expect(discordMock.onHandlerError).toHaveBeenCalledOnce();
      const [handler] = discordMock.onHandlerError.mock.calls[0];
      await handler(new Error('handler failed'));
      expect(discordMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        channelId: DiscordChannel.BotSpam,
        message: 'Discord bot error: Error: handler failed',
      });
    });
  });

  const zulipMessage = (overrides: Partial<ZulipReceivedMessage> = {}): ZulipReceivedMessage => ({
    id: 900,
    senderId: 12,
    senderEmail: 'alice@example.com',
    senderFullName: 'Alice',
    type: 'stream',
    streamId: Constants.Zulip.TeamStreams.ImmichGeneral,
    topic: 'thumbnails',
    content: 'hello',
    timestamp: 1_700_000_000,
    ...overrides,
  });

  describe('onZulipMessage', () => {
    const expanderRow = (streamId: number, expander: ZulipExpanderKind): ZulipExpander => ({
      streamId,
      expander,
      createdBy: 'migration',
      createdAt: new Date(0),
    });
    const SEEDED = [54, 107, 108, 109, 110, 111, 112, 113].flatMap((streamId) => [
      expanderRow(streamId, 'github'),
      expanderRow(streamId, 'twitter'),
    ]);

    beforeEach(async () => {
      zulipMock.sendMessage.mockResolvedValue({ id: 901 });
      databaseMock.getZulipExpanders.mockResolvedValue([
        ...SEEDED,
        expanderRow(120, 'github'),
        expanderRow(121, 'twitter'),
      ]);
      await zulipExpanders.init();
    });

    it('should expand GitHub references alone in a stream with only the GitHub expander on', async () => {
      await sut.onZulipMessage(zulipMessage({ streamId: 120, content: 'https://x.com/immich/status/1 fixes #4242' }));

      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        stream: 120,
        topic: 'thumbnails',
        content: 'https://github.com/immich-app/immich/pull/4242',
      });
    });

    it('should mirror x.com links alone in a stream with only the Twitter expander on, without a GitHub call', async () => {
      await sut.onZulipMessage(zulipMessage({ streamId: 121, content: 'https://x.com/immich/status/1 fixes #4242' }));

      expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        stream: 121,
        topic: 'thumbnails',
        content: 'https://nitter.net/immich/status/1',
      });
    });

    it('should follow a change to the expanders at once, with no query per message', async () => {
      databaseMock.removeZulipExpanders.mockResolvedValue([expanderRow(107, 'github')]);
      const remaining = (await databaseMock.getZulipExpanders()).filter(
        ({ streamId, expander }) => !(streamId === 107 && expander === 'github'),
      );
      databaseMock.getZulipExpanders.mockResolvedValue(remaining);
      await zulipExpanders.disable(107, ['github']);
      const reads = databaseMock.getZulipExpanders.mock.calls.length;

      await sut.onZulipMessage(zulipMessage({ content: 'https://x.com/immich/status/1 fixes #4242' }));

      expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        stream: 107,
        topic: 'thumbnails',
        content: 'https://nitter.net/immich/status/1',
      });
      expect(databaseMock.getZulipExpanders).toHaveBeenCalledTimes(reads);
    });

    it('should reply with the expanded GitHub references in the same stream and topic', async () => {
      await sut.onZulipMessage(zulipMessage({ content: 'see #4242 and #6969' }));

      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage).toHaveBeenCalledWith({
        stream: 107,
        topic: 'thumbnails',
        content: 'https://github.com/immich-app/immich/pull/4242\nhttps://github.com/immich-app/immich/issues/6969',
      });
    });

    it('should ask GitHub as a privileged caller, since every allowlisted stream is a private team channel (checked below)', async () => {
      await sut.onZulipMessage(zulipMessage({ content: '#4242' }));

      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledOnce();
      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledWith('immich-app', 'immich', 4242, undefined, true);
    });

    it('should reply with a code snippet for a GitHub file permalink', async () => {
      githubMock.getRepositoryFileContent.mockResolvedValueOnce(['line 1', 'line 2']);

      await sut.onZulipMessage(
        zulipMessage({ content: 'https://github.com/immich-app/immich/blob/main/src/test.js#L1-L2' }),
      );

      expect(githubMock.getRepositoryFileContent).toHaveBeenCalledWith(
        'immich-app',
        'immich',
        'main',
        'src/test.js',
        true,
      );
      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage).toHaveBeenCalledWith({
        stream: 107,
        topic: 'thumbnails',
        content: '```js\nline 1\nline 2\n```',
      });
    });

    it('should reply with a nitter mirror for an x.com link', async () => {
      await sut.onZulipMessage(zulipMessage({ content: 'look https://x.com/immich/status/1' }));

      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage).toHaveBeenCalledWith({
        stream: 107,
        topic: 'thumbnails',
        content: 'https://nitter.net/immich/status/1',
      });
    });

    it('should put every expansion of one message in one reply, GitHub first', async () => {
      await sut.onZulipMessage(zulipMessage({ content: 'https://x.com/immich/status/1 fixes #4242' }));

      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage.mock.calls[0][0].content).toBe(
        'https://github.com/immich-app/immich/pull/4242\nhttps://nitter.net/immich/status/1',
      );
    });

    it('should neutralise mentions in what GitHub returned, so a title cannot ping the stream', async () => {
      githubMock.getIssueOrPrMessage.mockResolvedValueOnce('[Issue] please @**all** look (immich-app/immich#4242)');

      await sut.onZulipMessage(zulipMessage({ content: '#4242' }));

      expect(zulipMock.sendMessage.mock.calls[0][0].content).toBe(
        '[Issue] please @\u200B**all** look (immich-app/immich#4242)',
      );
    });

    it('should leave a code snippet as GitHub has it, since a neutralised sigil inside the fence would corrupt the code', async () => {
      githubMock.getRepositoryFileContent.mockResolvedValueOnce(['name="${path#*/}"', 'echo "@**${name}**"']);
      githubMock.getIssueOrPrMessage.mockResolvedValueOnce('[Issue] please @**all** look (immich-app/immich#4242)');

      await sut.onZulipMessage(
        zulipMessage({ content: 'https://github.com/immich-app/immich/blob/main/build.sh#L1-L2 for #4242' }),
      );

      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage.mock.calls[0][0].content).toBe(
        '```sh\nname="${path#*/}"\necho "@**${name}**"\n```\n[Issue] please @\u200B**all** look (immich-app/immich#4242)',
      );
    });

    it('should neutralise mentions in a nitter mirror, which is built from whatever the sender typed', async () => {
      await sut.onZulipMessage(zulipMessage({ content: 'https://x.com/@**all**/status/1' }));

      expect(zulipMock.sendMessage.mock.calls[0][0].content).toBe('https://nitter.net/@\u200B**all**/status/1');
    });

    it('should expand GitHub references, privileged, and mirror x.com links in the Immich stream', async () => {
      await sut.onZulipMessage(
        zulipMessage({
          streamId: Constants.Zulip.Streams.Immich,
          content: 'https://x.com/immich/status/1 fixes #4242',
        }),
      );

      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledWith('immich-app', 'immich', 4242, undefined, true);
      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        stream: 54,
        topic: 'thumbnails',
        content: 'https://github.com/immich-app/immich/pull/4242\nhttps://nitter.net/immich/status/1',
      });
    });

    it('should reply in whichever allowlisted stream and topic the message was in', async () => {
      await sut.onZulipMessage(
        zulipMessage({
          streamId: Constants.Zulip.TeamStreams.ImmichPullRequests,
          topic: '#4242: feat',
          content: '#6969',
        }),
      );

      expect(zulipMock.sendMessage).toHaveBeenCalledWith({
        stream: 112,
        topic: '#4242: feat',
        content: 'https://github.com/immich-app/immich/issues/6969',
      });
    });

    it.each([
      { name: 'FUTO staff', streamId: Constants.Zulip.Streams.FUTOStaff },
      { name: 'an unknown stream', streamId: 999 },
    ])('should do nothing in $name', async ({ streamId }) => {
      await sut.onZulipMessage(zulipMessage({ streamId, content: '#4242 https://x.com/immich/status/1' }));

      expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should do nothing for a direct message', async () => {
      await sut.onZulipMessage(
        zulipMessage({ type: 'private', streamId: undefined, content: '#4242 https://x.com/immich/status/1' }),
      );

      expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should send nothing when there is nothing to expand', async () => {
      await sut.onZulipMessage(zulipMessage({ content: 'just chatting about #123' }));

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should send nothing when the reference is only in a code block', async () => {
      await sut.onZulipMessage(zulipMessage({ content: '```\n#4242\n```' }));

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });
  });
});
