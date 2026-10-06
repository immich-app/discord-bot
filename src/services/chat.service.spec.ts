import { Logger } from '@nestjs/common';
import { CommandInteraction, GuildEmoji } from 'discord.js';
import { Constants } from 'src/constants';
import { DiscordCommands } from 'src/discord/commands';
import { neutraliseZulipLabel } from 'src/format';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';
import { IFourthwallRepository } from 'src/interfaces/fourthwall.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { GitlabItem, GitlabItemKind, IGitlabInterface } from 'src/interfaces/gitlab.interface';
import { ILoopDedupeInterface } from 'src/interfaces/loop-dedupe.interface';
import { IOutlineInterface } from 'src/interfaces/outline.interface';
import { IZulipInterface, ZulipReceivedMessage } from 'src/interfaces/zulip.interface';
import { ZulipApiError } from 'src/repositories/zulip.client';
import { PullRequest, ZulipExpander, ZulipExpanderDefault, ZulipExpanderGroup } from 'src/schema';
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
  getRepositoryName: vitest.fn(),
  getOwnerRepositories: vitest.fn(),
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
  getPullRequestsByNumber: vitest.fn().mockResolvedValue([]),
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
  getZulipExpanderGroups: vitest.fn().mockResolvedValue([]),
  getZulipExpanders: vitest.fn(),
  getZulipExpanderDefaults: vitest.fn().mockResolvedValue([]),
  createZulipExpanderGroup: vitest.fn(),
  updateZulipExpanderGroup: vitest.fn(),
  removeZulipExpanderGroup: vitest.fn(),
  addZulipExpander: vitest.fn(),
  removeZulipExpander: vitest.fn(),
  setZulipExpanderDefault: vitest.fn(),
  getZulipDmExpanders: vitest.fn().mockResolvedValue([]),
  getZulipDmExpanderDefaults: vitest.fn().mockResolvedValue([]),
  addZulipDmExpander: vitest.fn(),
  removeZulipDmExpander: vitest.fn(),
  setZulipDmExpanderDefault: vitest.fn(),
  getZulipEmotes: vitest.fn().mockResolvedValue([]),
  addZulipEmote: vitest.fn(),
});

const newFourthwallMockRepository = (): Mocked<IFourthwallRepository> => ({
  getOrder: vitest.fn(),
});

const BOT_USER_ID = 99;

const newZulipServiceMock = () => ({
  onMessage: vitest.fn<(handler: ZulipMessageHandler) => void>(),
  ownUser: { userId: BOT_USER_ID, fullName: 'FUBot' },
  isGuest: vitest.fn<(userId: number) => Promise<boolean>>().mockResolvedValue(false),
});

const newZulipMockRepository = (): Mocked<IZulipInterface> => ({
  init: vitest.fn(),
  isInitialised: vitest.fn(),
  createEmote: vitest.fn(),
  replaceCroppedEmote: vitest.fn(),
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

const newGitlabMockRepository = (): Mocked<IGitlabInterface> => ({
  getProjectPath: vitest.fn(),
  getItem: vitest.fn().mockResolvedValue(undefined),
  getFileContent: vitest.fn().mockResolvedValue(undefined),
  getGroupProjects: vitest.fn(),
});

const newLoopDedupeMockRepository = (): Mocked<ILoopDedupeInterface> => ({
  getForText: vitest.fn(),
});

describe('Bot test', () => {
  let sut: ChatService;

  let discordMock: Mocked<IDiscordInterface>;
  let fourthwallMock: Mocked<IFourthwallRepository>;
  let githubMock: Mocked<IGithubInterface>;
  let gitlabMock: Mocked<IGitlabInterface>;
  let loopDedupeMock: Mocked<ILoopDedupeInterface>;
  let outlineMock: Mocked<IOutlineInterface>;
  let databaseMock: Mocked<IDatabaseRepository>;
  let zulipMock: Mocked<IZulipInterface>;
  let zulipServiceMock: ReturnType<typeof newZulipServiceMock>;
  let zulipExpanders: ZulipExpanderService;
  let fetchMock: ReturnType<typeof vitest.fn>;

  beforeEach(() => {
    discordMock = newDiscordMockRepository();
    fourthwallMock = newFourthwallMockRepository();
    githubMock = newGithubMockRepository();
    gitlabMock = newGitlabMockRepository();
    loopDedupeMock = newLoopDedupeMockRepository();
    outlineMock = newOutlineMockRepository();
    databaseMock = newDatabaseMockRepository();
    zulipMock = newZulipMockRepository();
    zulipServiceMock = newZulipServiceMock();
    zulipExpanders = new ZulipExpanderService(databaseMock, githubMock, gitlabMock);
    // 7TV and BTTV lookups go through the global fetch.
    fetchMock = vitest.fn();
    vitest.stubGlobal('fetch', fetchMock);

    sut = new ChatService(
      databaseMock,
      discordMock,
      fourthwallMock,
      githubMock,
      gitlabMock,
      loopDedupeMock,
      outlineMock,
      zulipMock,
      zulipServiceMock as unknown as ZulipService,
      new NotificationService(discordMock, zulipMock),
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

    it('should resolve a bare reference with the latest pull request of that number when no scope is given, as Discord does', async () => {
      await expect(sut.handleGithubThreadReferences({ content: '#4242' }, false)).resolves.toEqual([
        'https://github.com/immich-app/immich/pull/4242',
      ]);
      expect(databaseMock.getLatestPullRequestByNumber).toHaveBeenCalledWith(4242, 'immich-app');
      expect(databaseMock.getPullRequestsByNumber).not.toHaveBeenCalled();
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
    });

    const record = (discordEmoteId: string, zulipName: string, padded: boolean) => ({
      discordEmoteId,
      zulipName,
      padded,
      createdAt: new Date('2026-10-01'),
    });

    describe('wide emotes Zulip cropped', () => {
      const wide = {
        id: '1',
        identifier: 'peepoWideHappy:1',
        name: 'peepoWideHappy',
        url: 'https://cdn.discordapp.com/emojis/1.webp',
        animated: false,
      };

      beforeEach(() => {
        discordMock.getEmotes.mockResolvedValue([wide]);
        zulipMock.listEmoji.mockResolvedValue([{ id: '9', name: 'peepowidehappy', deactivated: false }]);
      });

      it('should replace an emote Zulip has but no sync checked, whoever uploaded it, record it, and say so', async () => {
        zulipMock.replaceCroppedEmote.mockResolvedValue('replaced');

        const report = await sut.syncEmotes('guild-1');

        expect(zulipMock.replaceCroppedEmote).toHaveBeenCalledExactlyOnceWith('peepowidehappy', wide.url);
        expect(zulipMock.createEmote).not.toHaveBeenCalled();
        expect(databaseMock.addZulipEmote).toHaveBeenCalledExactlyOnceWith('1', 'peepowidehappy');
        expect(report).toMatchObject({ replaced: ['peepoWideHappy'], alreadyOnZulip: [], failed: [] });
        expect(formatEmoteSyncReport(report)).toBe(
          'Done syncing: 1 emote, 0 uploaded to Zulip, 1 padded and replaced: peepoWideHappy',
        );
      });

      it('should keep an unchecked emote whose image is square, and record it', async () => {
        zulipMock.replaceCroppedEmote.mockResolvedValue('kept');

        const report = await sut.syncEmotes('guild-1');

        expect(databaseMock.addZulipEmote).toHaveBeenCalledExactlyOnceWith('1', 'peepowidehappy');
        expect(report).toMatchObject({ replaced: [], alreadyOnZulip: ['peepoWideHappy'] });
      });

      it('should never look at an emote a sync padded again', async () => {
        databaseMock.getZulipEmotes.mockResolvedValue([record('1', 'peepowidehappy', true)]);

        const report = await sut.syncEmotes('guild-1');

        expect(zulipMock.replaceCroppedEmote).not.toHaveBeenCalled();
        expect(databaseMock.addZulipEmote).not.toHaveBeenCalled();
        expect(report).toMatchObject({ replaced: [], alreadyOnZulip: ['peepoWideHappy'] });
      });

      it('should pad again an emote a sync recorded before emotes were padded, and record it', async () => {
        databaseMock.getZulipEmotes.mockResolvedValue([record('1', 'peepowidehappy', false)]);
        zulipMock.replaceCroppedEmote.mockResolvedValue('replaced');

        const report = await sut.syncEmotes('guild-1');

        expect(zulipMock.replaceCroppedEmote).toHaveBeenCalledExactlyOnceWith('peepowidehappy', wide.url);
        expect(databaseMock.addZulipEmote).toHaveBeenCalledExactlyOnceWith('1', 'peepowidehappy');
        expect(report).toMatchObject({ replaced: ['peepoWideHappy'] });
      });

      it('should replace each recorded emote under its own name when Discord lists them in another order', async () => {
        const other = {
          ...wide,
          id: '2',
          identifier: 'PeepoWideHappy:2',
          name: 'PeepoWideHappy',
          url: 'https://cdn.discordapp.com/emojis/2.webp',
        };
        discordMock.getEmotes.mockResolvedValue([other, wide]);
        zulipMock.listEmoji.mockResolvedValue([
          { id: '9', name: 'peepowidehappy', deactivated: false },
          { id: '10', name: 'peepowidehappy2', deactivated: false },
        ]);
        databaseMock.getZulipEmotes.mockResolvedValue([
          record('1', 'peepowidehappy', false),
          record('2', 'peepowidehappy2', false),
        ]);
        zulipMock.replaceCroppedEmote.mockResolvedValue('replaced');

        await sut.syncEmotes('guild-1');

        expect(zulipMock.replaceCroppedEmote).toHaveBeenCalledTimes(2);
        expect(zulipMock.replaceCroppedEmote).toHaveBeenCalledWith('peepowidehappy2', other.url);
        expect(zulipMock.replaceCroppedEmote).toHaveBeenCalledWith('peepowidehappy', wide.url);
      });

      it('should upload a new emote under a name of its own rather than one recorded for another emote', async () => {
        const added = {
          ...wide,
          id: '2',
          identifier: 'PeepoWideHappy:2',
          name: 'PeepoWideHappy',
          url: 'https://cdn.discordapp.com/emojis/2.webp',
        };
        discordMock.getEmotes.mockResolvedValue([added, wide]);
        databaseMock.getZulipEmotes.mockResolvedValue([record('1', 'peepowidehappy', true)]);

        await sut.syncEmotes('guild-1');

        expect(zulipMock.replaceCroppedEmote).not.toHaveBeenCalled();
        expect(zulipMock.createEmote).toHaveBeenCalledExactlyOnceWith('peepowidehappy2', added.url);
        expect(databaseMock.addZulipEmote).toHaveBeenCalledExactlyOnceWith('2', 'peepowidehappy2');
      });

      it('should count a replacement that fails as failed, unrecorded, so the next sync tries again', async () => {
        vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        zulipMock.replaceCroppedEmote.mockRejectedValue(
          new Error('Must be an organization administrator or emoji author'),
        );

        const report = await sut.syncEmotes('guild-1');

        expect(databaseMock.addZulipEmote).not.toHaveBeenCalled();
        expect(report).toMatchObject({ failed: ['peepoWideHappy'], replaced: [] });
      });

      it('should stop the Zulip side when Zulip refuses the credentials during a replacement', async () => {
        vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        zulipMock.replaceCroppedEmote.mockRejectedValue(
          new ZulipApiError(401, 'UNAUTHORIZED', 'Invalid API key', 'DELETE /api/v1/realm/emoji/peepowidehappy'),
        );

        const report = await sut.syncEmotes('guild-1');

        expect(report.zulipSkipped).toBe('refused');
        expect(databaseMock.addZulipEmote).not.toHaveBeenCalled();
      });

      it('should record a new emote it uploads', async () => {
        zulipMock.listEmoji.mockResolvedValue([]);

        await sut.syncEmotes('guild-1');

        expect(zulipMock.createEmote).toHaveBeenCalledExactlyOnceWith('peepowidehappy', wide.url);
        expect(databaseMock.addZulipEmote).toHaveBeenCalledExactlyOnceWith('1', 'peepowidehappy');
      });
    });

    it('should upload every Discord emote to Zulip, then report done', async () => {
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
      expect(discordMock.createEmote).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      expect(deferReply).toHaveBeenCalledOnce();
      expect(reply.edit).toHaveBeenCalledOnce();
      expect(reply.edit).toHaveBeenCalledWith(
        'Done syncing: 3 emotes, 3 uploaded to Zulip, 1 renamed: nameless:3 → nameless_3',
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
    });

    it('should defer the reply, upload each emote to Zulip one at a time, then edit the reply', async () => {
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
      const [edit] = reply.edit.mock.invocationCallOrder;
      expect(defer).toBeLessThan(getEmotes);
      expect(getEmotes).toBeLessThan(zulipFirst);
      expect(getEmotes).toBeLessThan(listEmoji);
      expect(listEmoji).toBeLessThan(zulipFirst);
      expect(zulipFirst).toBeLessThan(zulipSecond);
      expect(zulipSecond).toBeLessThan(edit);
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
      });

      it('should not report a name that only changed case', async () => {
        const { interaction, reply } = newInteraction();
        discordMock.getEmotes.mockResolvedValue([emote('catJAM', 1)]);

        await syncEmotes(interaction);

        expect(reply.edit).toHaveBeenCalledWith('Done syncing: 1 emote, 1 uploaded to Zulip');
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
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 3 emotes, 3 uploaded to Zulip, 2 renamed: CatJam → catjam2, CATJAM → catjam3',
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
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 3 emotes, 3 uploaded to Zulip, 2 renamed: fire → fire2, Tada → tada2',
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
          'Done syncing: 2 emotes, 2 uploaded to Zulip, 2 renamed: Zulip → zulip2, zulip → zulip3',
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
          'Done syncing: 3 emotes, 3 uploaded to Zulip, 2 renamed: fire → fire4, FIRE → fire5',
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
          'Done syncing: 3 emotes, 2 uploaded to Zulip, 2 renamed: Fire → fire2, tada → tada2, 1 already on Zulip: fire',
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

      it('should give up a recorded name Zulip has since made a built-in one, once no realm emoji holds it', async () => {
        const { interaction } = newInteraction();
        discordMock.getEmotes.mockResolvedValue([emote('fire', 1)]);
        databaseMock.getZulipEmotes.mockResolvedValue([record('1', 'fire', true)]);

        await syncEmotes(interaction);

        expect(zulipMock.createEmote).toHaveBeenCalledExactlyOnceWith(
          'fire2',
          'https://cdn.discordapp.com/emojis/1.webp',
        );
        expect(databaseMock.addZulipEmote).toHaveBeenCalledExactlyOnceWith('1', 'fire2');
      });

      it('should check the emoji under the new name rather than take it for synced when a recorded name is given up', async () => {
        const { interaction } = newInteraction();
        discordMock.getEmotes.mockResolvedValue([emote('fire', 1)]);
        databaseMock.getZulipEmotes.mockResolvedValue([record('1', 'fire', true)]);
        zulipMock.listEmoji.mockResolvedValue([{ id: '5', name: 'fire2', deactivated: false }]);
        zulipMock.replaceCroppedEmote.mockResolvedValue('kept');

        await syncEmotes(interaction);

        expect(zulipMock.replaceCroppedEmote).toHaveBeenCalledExactlyOnceWith(
          'fire2',
          'https://cdn.discordapp.com/emojis/1.webp',
        );
        expect(databaseMock.addZulipEmote).toHaveBeenCalledExactlyOnceWith('1', 'fire2');
      });

      it('should skip an emote whose name is already on Zulip instead of uploading it again', async () => {
        const { interaction, reply } = newInteraction();
        discordMock.getEmotes.mockResolvedValue([emote('catJAM', 1), emote('pepeD', 2)]);
        zulipMock.listEmoji.mockResolvedValue([{ id: '1', name: 'catjam', deactivated: false }]);

        await syncEmotes(interaction);

        expect(zulipMock.createEmote).toHaveBeenCalledOnce();
        expect(zulipMock.createEmote).toHaveBeenCalledWith('peped', 'https://cdn.discordapp.com/emojis/2.webp');
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 2 emotes, 1 uploaded to Zulip, 1 already on Zulip: catJAM',
        );
      });

      it('should treat a deactivated Zulip emoji as absent', async () => {
        const { interaction, reply } = newInteraction();
        discordMock.getEmotes.mockResolvedValue([emote('catJAM', 1)]);
        zulipMock.listEmoji.mockResolvedValue([{ id: '1', name: 'catjam', deactivated: true }]);

        await syncEmotes(interaction);

        expect(zulipMock.createEmote).toHaveBeenCalledOnce();
        expect(zulipMock.createEmote).toHaveBeenCalledWith('catjam', 'https://cdn.discordapp.com/emojis/1.webp');
        expect(reply.edit).toHaveBeenCalledWith('Done syncing: 1 emote, 1 uploaded to Zulip');
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
          'Done syncing: 4 emotes, 0 uploaded to Zulip, 4 already on Zulip: catJAM, CatJam → catjam2, nameless:3 → nameless_3, wave → wave2',
        );
      });
    });

    it('should report a server with no emotes as such, uploading nothing', async () => {
      const { interaction, reply } = newInteraction();
      discordMock.getEmotes.mockResolvedValue([]);

      await syncEmotes(interaction);

      expect(zulipMock.createEmote).not.toHaveBeenCalled();
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
        expect(Logger.prototype.error).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'Could not sync emote catJAM - https://cdn.discordapp.com/emojis/1.webp to Zulip',
          expect.any(Error),
        );
        expect(reply.edit).toHaveBeenCalledOnce();
        expect(reply.edit).toHaveBeenCalledWith(
          `Done syncing: 3 emotes, 2 uploaded to Zulip, 1 failed: catJAM, ${renamed}`,
        );
      });

      it('should report every emote Zulip failed to take', async () => {
        const { interaction, reply } = newInteraction();
        zulipMock.createEmote.mockRejectedValueOnce(new Error('zulip')).mockRejectedValueOnce(new Error('zulip'));

        await syncEmotes(interaction);

        expect(zulipMock.createEmote.mock.calls).toEqual(zulipUploads);
        expect(Logger.prototype.error).toHaveBeenCalledTimes(2);
        expect(reply.edit).toHaveBeenCalledWith(
          `Done syncing: 3 emotes, 1 uploaded to Zulip, 2 failed: catJAM, pepeD, ${renamed}`,
        );
      });

      it('should skip Zulip and say so, blaming no emote, when the realm emoji cannot be listed', async () => {
        const { interaction, reply } = newInteraction();
        zulipMock.listEmoji.mockRejectedValue(new Error('Zulip client not initialised'));

        await syncEmotes(interaction);

        expect(zulipMock.getEmojiCodes).not.toHaveBeenCalled();
        expect(zulipMock.createEmote).not.toHaveBeenCalled();
        expect(Logger.prototype.error).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'Could not list the Zulip emoji, skipping the Zulip side of the sync',
          expect.any(Error),
        );
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 3 emotes, 0 uploaded to Zulip (skipped: its emoji could not be listed)',
        );
      });

      it('should skip Zulip and say so when the built-in emoji names cannot be read', async () => {
        const { interaction, reply } = newInteraction();
        zulipMock.getEmojiCodes.mockRejectedValue(new Error('Could not fetch the Zulip emoji codes: 502'));

        await syncEmotes(interaction);

        expect(zulipMock.createEmote).not.toHaveBeenCalled();
        expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
          'Could not fetch the Zulip built-in emoji names, skipping the Zulip side of the sync',
          expect.any(Error),
        );
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 3 emotes, 0 uploaded to Zulip (skipped: its built-in emoji names could not be read)',
        );
      });

      describe('Zulip refusing the user account', () => {
        const unauthorized = () =>
          new ZulipApiError(401, 'UNAUTHORIZED', 'Malformed API key', 'POST /api/v1/realm/emoji/peped');
        const REFUSED =
          'Zulip refused the credentials of the user account that uploads emoji (Malformed API key), so no more emotes are uploaded to Zulip in this sync; check ZULIP_USER_USERNAME and ZULIP_USER_API_KEY';

        it('should stop uploading to Zulip, log it once without the key, and blame no emote', async () => {
          const { interaction, reply } = newInteraction();
          zulipMock.createEmote.mockRejectedValue(unauthorized());

          await syncEmotes(interaction);

          expect(zulipMock.createEmote).toHaveBeenCalledOnce();
          expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(REFUSED);
          expect(reply.edit).toHaveBeenCalledWith(
            'Done syncing: 3 emotes, 0 uploaded to Zulip (skipped: Zulip refused the credentials of the user account that uploads emoji)',
          );
        });

        it('should count what Zulip took before it refused, and report no rename it did not make', async () => {
          const { interaction, reply } = newInteraction();
          zulipMock.createEmote.mockResolvedValueOnce().mockRejectedValue(unauthorized());

          await syncEmotes(interaction);

          expect(zulipMock.createEmote.mock.calls).toEqual(zulipUploads.slice(0, 2));
          expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(REFUSED);
          expect(reply.edit).toHaveBeenCalledWith(
            'Done syncing: 3 emotes, 1 uploaded to Zulip (skipped: Zulip refused the credentials of the user account that uploads emoji)',
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
            `Done syncing: 3 emotes, 2 uploaded to Zulip, 1 failed: catJAM, ${renamed}`,
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
        expect(reply.edit).toHaveBeenCalledOnce();
        const [report] = reply.edit.mock.calls[0] as [string];
        expect(report).toMatch(/^Done syncing: 300 emotes, 0 uploaded to Zulip, 300 failed: emote_number_0, /);
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
      failed: ['pepeD'],
      renamed: [],
      replaced: [],
      alreadyOnZulip: ['catJAM'],
    };

    it('should start with "Done syncing" and say how many were uploaded where when no subject is given, as Discord posts it', () => {
      expect(formatEmoteSyncReport(report)).toBe(
        'Done syncing: 3 emotes, 1 uploaded to Zulip, 1 failed: pepeD, 1 already on Zulip: catJAM',
      );
    });

    it('should name the subject when one is given, as the Zulip command does, since its target is not where it is run', () => {
      expect(formatEmoteSyncReport(report, 'the emotes of the Immich Discord server (979116623879368755)')).toBe(
        'Done syncing the emotes of the Immich Discord server (979116623879368755): 3 emotes, 1 uploaded to Zulip, 1 failed: pepeD, 1 already on Zulip: catJAM',
      );
    });

    it('should say so plainly when the server has no emotes', () => {
      const empty = {
        ...report,
        total: 0,
        zulipUploaded: 0,
        failed: [],
        replaced: [],
        alreadyOnZulip: [],
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
    });

    it("should subscribe the Zulip expanders to the event loop, without other bots' messages", async () => {
      databaseMock.getZulipExpanderGroups.mockResolvedValue([
        {
          name: 'immich',
          repositories: ['immich-app/immich'],
          threshold: 1000,
          createdBy: 'migration',
          createdAt: new Date(0),
        },
      ]);
      databaseMock.getZulipExpanders.mockResolvedValue([
        { streamId: 107, groupName: 'immich', createdBy: 'migration', createdAt: new Date(0) },
      ]);
      await zulipExpanders.init();
      await sut.init();

      expect(zulipServiceMock.onMessage).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
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

  const expanderRow = (streamId: number, groupName = 'immich'): ZulipExpander => ({
    streamId,
    groupName,
    createdBy: 'migration',
    createdAt: new Date(0),
  });

  const expanderGroup = (name: string, repositories: string[], threshold = 0): ZulipExpanderGroup => ({
    name,
    repositories,
    threshold,
    createdBy: 'migration',
    createdAt: new Date(0),
  });

  describe('onZulipMessage', () => {
    beforeEach(async () => {
      zulipMock.sendMessage.mockResolvedValue({ id: 901 });
      databaseMock.getZulipExpanderGroups.mockResolvedValue([expanderGroup('immich', ['immich-app/immich'], 1000)]);
      databaseMock.getZulipExpanders.mockResolvedValue(
        [54, 107, 108, 109, 110, 111, 112, 113, 120].map((streamId) => expanderRow(streamId)),
      );
      await zulipExpanders.init();
    });

    describe('direct messages', () => {
      const LINK = 'https://github.com/futo-org/fhs-core/pull/7';
      const direct = (recipientIds: number[], content: string) =>
        sut.onZulipMessage(zulipMessage({ type: 'private', streamId: undefined, topic: '', recipientIds, content }));

      beforeEach(() => {
        zulipMock.sendDirectMessage.mockResolvedValue({ id: 902 });
        githubMock.getIssueOrPrMessage.mockResolvedValue('[Pull Request] Fix (futo-org/fhs-core#7)');
      });

      it('should expand a link in a direct message, answering the sender', async () => {
        await direct([BOT_USER_ID, 12], LINK);

        expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
          'futo-org',
          'fhs-core',
          7,
          undefined,
          true,
        );
        expect(zulipMock.sendDirectMessage).toHaveBeenCalledExactlyOnceWith(
          [12],
          '[Pull Request] Fix (futo-org/fhs-core#7)',
        );
        expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      });

      it('should answer everyone in a group direct message', async () => {
        await direct([12, BOT_USER_ID, 13], `${LINK} :we-are-checking:`);

        expect(zulipServiceMock.isGuest.mock.calls).toEqual([[12], [13]]);
        expect(zulipMock.sendDirectMessage).toHaveBeenCalledExactlyOnceWith(
          [12, 13],
          '[Pull Request] Fix (futo-org/fhs-core#7)\nhttps://i.ytimg.com/vi/QY4KKG4TBFo/maxresdefault.jpg',
        );
      });

      it('should expand nothing in a conversation with a guest', async () => {
        zulipServiceMock.isGuest.mockImplementation((userId) => Promise.resolve(userId === 13));

        await direct([12, BOT_USER_ID, 13], `${LINK} :we-are-checking:`);

        expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
        expect(zulipMock.sendDirectMessage).not.toHaveBeenCalled();
      });

      it('should expand nothing when a role cannot be read', async () => {
        zulipServiceMock.isGuest.mockRejectedValue(new Error('Zulip is down'));

        await expect(direct([12, BOT_USER_ID], LINK)).rejects.toThrow('Zulip is down');

        expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
        expect(zulipMock.sendDirectMessage).not.toHaveBeenCalled();
      });

      it('should give shorthand the meaning of the groups turned on in the conversation', async () => {
        databaseMock.getZulipDmExpanders.mockResolvedValue([
          { conversation: `12,${BOT_USER_ID}`, groupName: 'immich', createdBy: 'Alice', createdAt: new Date(0) },
        ]);
        await zulipExpanders.init();
        githubMock.getIssueOrPrMessage.mockResolvedValue('[Issue] Bug (immich-app/immich#4242)');

        await direct([BOT_USER_ID, 12], '#4242');

        expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
          'immich-app',
          'immich',
          4242,
          undefined,
          true,
        );
        expect(zulipMock.sendDirectMessage).toHaveBeenCalledExactlyOnceWith(
          [12],
          '[Issue] Bug (immich-app/immich#4242)',
        );
      });

      it('should give no shorthand a meaning in a conversation without a group', async () => {
        await direct([BOT_USER_ID, 12], '#4242 immich#12');

        expect(databaseMock.getPullRequestsByNumber).not.toHaveBeenCalled();
        expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
        expect(zulipMock.sendDirectMessage).not.toHaveBeenCalled();
      });
    });

    describe('emoji images', () => {
      const IMAGE = 'https://i.ytimg.com/vi/QY4KKG4TBFo/maxresdefault.jpg';

      it.each([
        ':we-are-checking:',
        'hold on :we-are-checking:',
        ':WE-ARE-CHECKING: :we-are-checking::we-are-checking:',
      ])('should answer %j with the image, once, in any stream', async (content) => {
        await sut.onZulipMessage(zulipMessage({ streamId: 121, content }));

        expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
          stream: 121,
          topic: 'thumbnails',
          content: IMAGE,
        });
      });

      it.each([
        '`:we-are-checking:`',
        '```\n:we-are-checking:\n```',
        '```\n:we-are-checking:',
        '~~~ python\nprint(1)\n:we-are-checking:',
        '    :we-are-checking:',
        'look:\n\n    code\n    :we-are-checking:',
        '\t:we-are-checking:',
        'we-are-checking',
        ':we-are-checking',
        ':smile:',
      ])('should not answer %j', async (content) => {
        await sut.onZulipMessage(zulipMessage({ streamId: 121, content }));

        expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      });

      it.each([
        '- a list item\n    :we-are-checking:',
        '```quote\n:we-are-checking:\n```',
        'text\n    :we-are-checking:',
      ])('should answer %j, which Zulip renders as text', async (content) => {
        await sut.onZulipMessage(zulipMessage({ streamId: 121, content }));

        expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: IMAGE }));
      });

      it('should still post the image when a reference in the same message fails, and report the failure', async () => {
        githubMock.getIssueOrPrMessage.mockRejectedValue(new Error('GitHub is down'));

        await expect(
          sut.onZulipMessage(zulipMessage({ streamId: 120, content: 'fixes #4242 :we-are-checking:' })),
        ).rejects.toThrow('GitHub is down');

        expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
          stream: 120,
          topic: 'thumbnails',
          content: IMAGE,
        });
      });

      it('should not answer a direct message', async () => {
        await sut.onZulipMessage(zulipMessage({ type: 'private', streamId: undefined, content: ':we-are-checking:' }));

        expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      });

      it('should post the image after the expansions of the same message, in one reply', async () => {
        await sut.onZulipMessage(
          zulipMessage({ streamId: 121, content: 'https://x.com/immich/status/1 :we-are-checking:' }),
        );

        expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
          stream: 121,
          topic: 'thumbnails',
          content: `https://nitter.net/immich/status/1\n${IMAGE}`,
        });
      });
    });

    it('should mirror x.com links but ask GitHub nothing in a stream without GitHub expansion', async () => {
      await sut.onZulipMessage(zulipMessage({ streamId: 121, content: 'https://x.com/immich/status/1 fixes #4242' }));

      expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
      expect(githubMock.getRepositoryFileContent).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        stream: 121,
        topic: 'thumbnails',
        content: 'https://nitter.net/immich/status/1',
      });
    });

    it('should expand GitHub references in a stream turned on after the seed', async () => {
      await sut.onZulipMessage(zulipMessage({ streamId: 120, content: 'https://x.com/immich/status/1 fixes #4242' }));

      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        stream: 120,
        topic: 'thumbnails',
        content: 'https://github.com/immich-app/immich/pull/4242\nhttps://nitter.net/immich/status/1',
      });
    });

    it('should follow a change to GitHub expansion at once, with no query per message', async () => {
      databaseMock.removeZulipExpander.mockResolvedValue(['immich']);
      const remaining = (await databaseMock.getZulipExpanders()).filter(({ streamId }) => streamId !== 107);
      databaseMock.getZulipExpanders.mockResolvedValue(remaining);
      await zulipExpanders.disable(107);
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
    ])('should expand nothing from GitHub in $name, and still mirror x.com links there', async ({ streamId }) => {
      await sut.onZulipMessage(zulipMessage({ streamId, content: '#4242 https://x.com/immich/status/1' }));

      expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        stream: streamId,
        topic: 'thumbnails',
        content: 'https://nitter.net/immich/status/1',
      });
    });

    it('should send nothing in a stream without GitHub expansion when there is no x.com link', async () => {
      await sut.onZulipMessage(zulipMessage({ streamId: 999, content: 'see #4242' }));

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

  describe('onZulipMessage with expander groups', () => {
    const STREAM = 130;
    const weeksAgo = (weeks: number) => new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000);
    const pullRequest = (organization: string, repository: string, number: number, updatedAt: Date): PullRequest => ({
      nodeId: `${organization}/${repository}#${number}`,
      organization,
      repository,
      number,
      discordThreadId: null,
      zulipMessageId: null,
      updatedAt,
      closedAt: null,
    });
    const defaultRow = (streamId: number, repository: string): ZulipExpanderDefault => ({
      streamId,
      repository,
      createdBy: 'migration',
      createdAt: new Date(0),
    });

    const setUp = async ({
      groups,
      streamGroups,
      defaults = [],
    }: {
      groups: ZulipExpanderGroup[];
      streamGroups: string[];
      defaults?: ZulipExpanderDefault[];
    }) => {
      databaseMock.getZulipExpanderGroups.mockResolvedValue(groups);
      databaseMock.getZulipExpanders.mockResolvedValue(streamGroups.map((group) => expanderRow(STREAM, group)));
      databaseMock.getZulipExpanderDefaults.mockResolvedValue(defaults);
      await zulipExpanders.init();
    };

    const send = (content: string) => sut.onZulipMessage(zulipMessage({ streamId: STREAM, content }));

    const FHS = expanderGroup('fhs', ['futo-org/fhs-core', 'futo-org/fhs-web']);
    const IMMICH = expanderGroup('immich', ['immich-app/immich'], 1000);

    beforeEach(() => {
      zulipMock.sendMessage.mockResolvedValue({ id: 901 });
    });

    it('should expand links but no shorthand in a stream with no group on, and still mirror x.com links there', async () => {
      await setUp({ groups: [FHS], streamGroups: [] });
      githubMock.getIssueOrPrMessage.mockResolvedValueOnce('[Pull Request] Fix (futo-org/fhs-core#7)');
      githubMock.getIssueOrPrMessage.mockResolvedValueOnce('[Issue] Bug (immich-app/immich#8)');

      await send(
        '#4242 fhs-core#12 https://github.com/futo-org/fhs-core/pull/7 immich-app/immich#8 https://x.com/immich/status/1',
      );

      expect(githubMock.getIssueOrPrMessage.mock.calls).toEqual([
        ['futo-org', 'fhs-core', 7, undefined, true],
        ['immich-app', 'immich', 8, undefined, true],
      ]);
      expect(databaseMock.getPullRequestsByNumber.mock.calls).toEqual([[7], [8]]);
      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        stream: STREAM,
        topic: 'thumbnails',
        content: [
          '[Pull Request] Fix (futo-org/fhs-core#7)',
          '[Issue] Bug (immich-app/immich#8)',
          'https://nitter.net/immich/status/1',
        ].join('\n'),
      });
    });

    it('should expand nothing when the stream names only a group that no longer exists', async () => {
      await setUp({ groups: [], streamGroups: ['gone'] });

      await send('#4242');

      expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: 'an issue link',
        content: 'https://github.com/octokit/rest.js/issues/5',
        org: 'octokit',
        repo: 'rest.js',
      },
      { name: 'an owner/repo reference', content: 'octokit/rest.js#5', org: 'octokit', repo: 'rest.js' },
    ])('should expand $name to a repository outside the stream groups', async ({ content, org, repo }) => {
      await setUp({ groups: [FHS], streamGroups: ['fhs'] });

      await send(content);

      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(org, repo, 5, undefined, true);
    });

    it('should resolve name#N to the repository of that name in the stream groups, ignoring case', async () => {
      await setUp({ groups: [FHS], streamGroups: ['fhs'] });

      await send('FHS-Web#12');

      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
        'futo-org',
        'fhs-web',
        12,
        undefined,
        true,
      );
    });

    it("should resolve name#N outside the stream groups to the default repository's owner", async () => {
      await setUp({ groups: [FHS], streamGroups: ['fhs'] });

      await send('grayjay#12');

      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
        'futo-org',
        'grayjay',
        12,
        undefined,
        true,
      );
    });

    it("should send a bare #N to the first group's first repository when the stream has no default", async () => {
      await setUp({ groups: [FHS, IMMICH], streamGroups: ['fhs', 'immich'] });

      await send('#12');

      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
        'futo-org',
        'fhs-core',
        12,
        undefined,
        true,
      );
    });

    it('should send a bare #N to the default chosen for the stream', async () => {
      await setUp({
        groups: [FHS, IMMICH],
        streamGroups: ['fhs', 'immich'],
        defaults: [defaultRow(STREAM, 'futo-org/fhs-web')],
      });

      await send('#12');

      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
        'futo-org',
        'fhs-web',
        12,
        undefined,
        true,
      );
    });

    it("should fall back to the first group's first repository when the chosen default is no longer in the stream groups", async () => {
      await setUp({
        groups: [FHS, IMMICH],
        streamGroups: ['fhs'],
        defaults: [defaultRow(STREAM, 'immich-app/immich')],
      });

      await send('#4242');

      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
        'futo-org',
        'fhs-core',
        4242,
        undefined,
        true,
      );
    });

    it('should prefer a pull request updated in the last two weeks in one of the stream repositories', async () => {
      await setUp({ groups: [FHS, IMMICH], streamGroups: ['fhs', 'immich'] });
      databaseMock.getPullRequestsByNumber.mockResolvedValue([
        pullRequest('futo-org', 'fhs-web', 12, weeksAgo(3)),
        pullRequest('Immich-App', 'Immich', 12, weeksAgo(1)),
        pullRequest('octokit', 'rest.js', 12, new Date()),
      ]);

      await send('#12');

      expect(databaseMock.getPullRequestsByNumber).toHaveBeenCalledWith(12);
      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
        'Immich-App',
        'Immich',
        12,
        undefined,
        true,
      );
    });

    it('should send a bare #N to the default when its only pull requests are stale or in other repositories', async () => {
      await setUp({ groups: [FHS, IMMICH], streamGroups: ['fhs', 'immich'] });
      databaseMock.getPullRequestsByNumber.mockResolvedValue([
        pullRequest('immich-app', 'immich', 1200, weeksAgo(3)),
        pullRequest('octokit', 'rest.js', 1200, new Date()),
      ]);

      await send('#1200');

      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
        'futo-org',
        'fhs-core',
        1200,
        undefined,
        true,
      );
    });

    it("should drop a bare #N below the default repository's threshold", async () => {
      await setUp({ groups: [IMMICH], streamGroups: ['immich'] });

      await send('see #123');

      expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
      expect(githubMock.getDiscussionMessage).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should expand a bare #N below the threshold when a recent pull request matches', async () => {
      await setUp({ groups: [IMMICH], streamGroups: ['immich'] });
      databaseMock.getPullRequestsByNumber.mockResolvedValue([pullRequest('immich-app', 'immich', 123, weeksAgo(1))]);

      await send('see #123');

      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
        'immich-app',
        'immich',
        123,
        undefined,
        true,
      );
    });

    it('should not apply the threshold to name#N', async () => {
      await setUp({ groups: [IMMICH], streamGroups: ['immich'] });

      await send('immich#123');

      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
        'immich-app',
        'immich',
        123,
        undefined,
        true,
      );
    });

    it('should apply the highest threshold of the groups that hold the default repository', async () => {
      await setUp({
        groups: [expanderGroup('low', ['immich-app/immich'], 10), expanderGroup('high', ['immich-app/immich'], 500)],
        streamGroups: ['low', 'high'],
      });

      await send('#200');
      expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();

      await send('#600');
      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
        'immich-app',
        'immich',
        600,
        undefined,
        true,
      );
    });

    it('should expand every bare #N in a group without a threshold', async () => {
      await setUp({ groups: [FHS], streamGroups: ['fhs'] });

      await send('#3');

      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
        'futo-org',
        'fhs-core',
        3,
        undefined,
        true,
      );
    });

    it('should treat the reference as a pull request only when a row matches the resolved repository', async () => {
      await setUp({ groups: [FHS], streamGroups: ['fhs'] });
      databaseMock.getPullRequestsByNumber.mockResolvedValue([pullRequest('octokit', 'rest.js', 3, weeksAgo(5))]);
      githubMock.getIssueOrPrMessage.mockResolvedValue(undefined);

      await send('#3');

      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
        'futo-org',
        'fhs-core',
        3,
        undefined,
        true,
      );
      expect(githubMock.getDiscussionMessage).toHaveBeenCalledExactlyOnceWith('futo-org', 'fhs-core', 3, true);
    });

    it('should not fall back to a discussion when a pull request row matches the resolved repository', async () => {
      await setUp({ groups: [FHS], streamGroups: ['fhs'] });
      databaseMock.getPullRequestsByNumber.mockResolvedValue([pullRequest('Futo-Org', 'FHS-Core', 3, weeksAgo(5))]);
      githubMock.getIssueOrPrMessage.mockResolvedValue(undefined);

      await send('#3');

      expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
        'futo-org',
        'fhs-core',
        3,
        undefined,
        true,
      );
      expect(githubMock.getDiscussionMessage).not.toHaveBeenCalled();
    });

    it('should look discussion links up as discussions', async () => {
      await setUp({ groups: [FHS], streamGroups: ['fhs'] });

      await send('https://github.com/futo-org/fhs-core/discussions/7');

      expect(githubMock.getDiscussionMessage).toHaveBeenCalledExactlyOnceWith('futo-org', 'fhs-core', 7, true);
      expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
    });

    it('should keep a discussion link a discussion when a pull request row has its number', async () => {
      await setUp({ groups: [FHS], streamGroups: ['fhs'] });
      databaseMock.getPullRequestsByNumber.mockResolvedValue([pullRequest('futo-org', 'fhs-core', 7, weeksAgo(0))]);

      await send('https://github.com/futo-org/fhs-core/discussions/7');

      expect(githubMock.getDiscussionMessage).toHaveBeenCalledExactlyOnceWith('futo-org', 'fhs-core', 7, true);
      expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
    });

    describe('patterns', () => {
      const ORGS = expanderGroup('orgs', ['immich-app/*']);

      beforeEach(async () => {
        githubMock.getOwnerRepositories.mockResolvedValue({
          owner: 'immich-app',
          repositories: ['immich-app/immich', 'immich-app/static-pages'],
        });
        await setUp({ groups: [ORGS], streamGroups: ['orgs'] });
        await zulipExpanders.refreshPatterns();
      });

      it('should resolve name#N to a repository a pattern stands for', async () => {
        await send('static-pages#12');

        expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
          'immich-app',
          'static-pages',
          12,
          undefined,
          true,
        );
      });

      it('should leave a name#N no repository has, and a bare #N with no recent pull request, without a default', async () => {
        await send('elsewhere#12 #4321');

        expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
        expect(githubMock.getDiscussionMessage).not.toHaveBeenCalled();
      });

      it('should still send a bare #N to a recent pull request of a repository a pattern stands for', async () => {
        databaseMock.getPullRequestsByNumber.mockResolvedValue([
          pullRequest('immich-app', 'static-pages', 4321, weeksAgo(0)),
        ]);

        await send('#4321');

        expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
          'immich-app',
          'static-pages',
          4321,
          undefined,
          true,
        );
      });
    });

    describe('GitLab', () => {
      const GRAYJAY = expanderGroup('grayjay', [
        'gitlab.futo.org/videostreaming/grayjay',
        'gitlab.futo.org/videostreaming/plugins/kick',
      ]);
      const item = (kind: GitlabItemKind, title: string, path: string, iid: number, updatedAt = new Date(0)) =>
        ({ kind, title, url: `https://gitlab.futo.org/${path}/-/${kind}/${iid}`, updatedAt }) satisfies GitlabItem;
      const withItems = (...items: (GitlabItem & { path: string; iid: number })[]) =>
        gitlabMock.getItem.mockImplementation(async (path, kind, iid) => {
          const found = items.find(
            (candidate) => candidate.path === path && candidate.kind === kind && candidate.iid === iid,
          );
          return found && { kind: found.kind, title: found.title, url: found.url, updatedAt: found.updatedAt };
        });
      const located = (kind: GitlabItemKind, title: string, path: string, iid: number, updatedAt?: Date) => ({
        ...item(kind, title, path, iid, updatedAt),
        path,
        iid,
      });
      const reply = () => zulipMock.sendMessage.mock.calls.map(([message]) => message.content);

      it('should expand issue and merge request links to any project in a stream with a group', async () => {
        await setUp({ groups: [FHS], streamGroups: ['fhs'] });
        withItems(
          located('issues', 'Quoted posts', 'harbor/harbor', 310),
          located('merge_requests', 'Fixed casting', 'videostreaming/grayjay', 194),
        );

        await send(
          'https://gitlab.futo.org/harbor/harbor/-/issues/310 and https://gitlab.futo.org/videostreaming/grayjay/-/merge_requests/194',
        );

        expect(gitlabMock.getItem.mock.calls).toEqual([
          ['harbor/harbor', 'issues', 310],
          ['videostreaming/grayjay', 'merge_requests', 194],
        ]);
        expect(reply()).toEqual([
          [
            '[Issue] Quoted posts ([harbor/harbor#310](https://gitlab.futo.org/harbor/harbor/-/issues/310))',
            '[Merge Request] Fixed casting ([videostreaming/grayjay#194](https://gitlab.futo.org/videostreaming/grayjay/-/merge_requests/194))',
          ].join('\n'),
        ]);
        expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
      });

      it('should expand a GitLab link in a stream without a group', async () => {
        await setUp({ groups: [FHS], streamGroups: [] });
        withItems(located('issues', 'Quoted posts', 'harbor/harbor', 310));

        await send('https://gitlab.futo.org/harbor/harbor/-/issues/310');

        expect(gitlabMock.getItem).toHaveBeenCalledExactlyOnceWith('harbor/harbor', 'issues', 310);
        expect(reply()).toEqual([
          '[Issue] Quoted posts ([harbor/harbor#310](https://gitlab.futo.org/harbor/harbor/-/issues/310))',
        ]);
      });

      it('should fetch a link repeated in another case once', async () => {
        await setUp({ groups: [FHS], streamGroups: ['fhs'] });

        await send(
          'https://gitlab.futo.org/harbor/harbor/-/issues/310 https://gitlab.futo.org/Harbor/Harbor/-/issues/310',
        );

        expect(gitlabMock.getItem).toHaveBeenCalledExactlyOnceWith('harbor/harbor', 'issues', 310);
      });

      it('should read a work item link as an issue, and fetch it once beside its issue link', async () => {
        await setUp({ groups: [FHS], streamGroups: ['fhs'] });

        await send(
          'https://gitlab.futo.org/videostreaming/grayjay/-/work_items/1 https://gitlab.futo.org/videostreaming/grayjay/-/issues/1',
        );

        expect(gitlabMock.getItem).toHaveBeenCalledExactlyOnceWith('videostreaming/grayjay', 'issues', 1);
      });

      it.each([
        { newer: 'merge_requests' as const, title: '[Merge Request] Fix the player' },
        { newer: 'issues' as const, title: '[Issue] The player crashes' },
      ])(
        'should show the more recently updated of the issue and merge request #N, $newer newer',
        async ({ newer, title }) => {
          await setUp({ groups: [GRAYJAY], streamGroups: ['grayjay'] });
          withItems(
            located('issues', 'The player crashes', 'videostreaming/grayjay', 7, weeksAgo(newer === 'issues' ? 0 : 3)),
            located(
              'merge_requests',
              'Fix the player',
              'videostreaming/grayjay',
              7,
              weeksAgo(newer === 'issues' ? 3 : 0),
            ),
          );

          await send('#7');

          expect(gitlabMock.getItem.mock.calls).toEqual([
            ['videostreaming/grayjay', 'issues', 7],
            ['videostreaming/grayjay', 'merge_requests', 7],
          ]);
          expect(reply()).toHaveLength(1);
          expect(reply()[0]).toMatch(
            new RegExp(`^${title.replaceAll(/[[\]]/g, '\\$&')} \\(\\[videostreaming/grayjay#7\\]`),
          );
        },
      );

      it('should show #N when only one kind has that number', async () => {
        await setUp({ groups: [GRAYJAY], streamGroups: ['grayjay'] });
        withItems(located('merge_requests', 'Fix the player', 'videostreaming/grayjay', 7));

        await send('#7');

        expect(reply()).toEqual([
          '[Merge Request] Fix the player ([videostreaming/grayjay#7](https://gitlab.futo.org/videostreaming/grayjay/-/merge_requests/7))',
        ]);
      });

      it('should post nothing when neither kind has that number', async () => {
        await setUp({ groups: [GRAYJAY], streamGroups: ['grayjay'] });

        await send('#7');

        expect(gitlabMock.getItem).toHaveBeenCalledTimes(2);
        expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      });

      it('should drop a bare #N below the threshold of a GitLab default', async () => {
        await setUp({ groups: [{ ...GRAYJAY, threshold: 100 }], streamGroups: ['grayjay'] });

        await send('#5');
        expect(gitlabMock.getItem).not.toHaveBeenCalled();

        await send('#150');
        expect(gitlabMock.getItem).toHaveBeenCalledWith('videostreaming/grayjay', 'issues', 150);
      });

      it.each([
        { content: 'grayjay#7', path: 'videostreaming/grayjay' },
        { content: 'GrayJay#7', path: 'videostreaming/grayjay' },
        { content: 'VideoStreaming/GrayJay#7', path: 'videostreaming/grayjay' },
        { content: 'plugins/kick#7', path: 'videostreaming/plugins/kick' },
        { content: 'kick#7', path: 'videostreaming/plugins/kick' },
      ])('should resolve $content to the GitLab project in the stream groups', async ({ content, path }) => {
        await setUp({ groups: [FHS, GRAYJAY], streamGroups: ['fhs', 'grayjay'] });

        await send(content);

        expect(gitlabMock.getItem.mock.calls).toEqual([
          [path, 'issues', 7],
          [path, 'merge_requests', 7],
        ]);
        expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
      });

      it('should keep owner/name#N that matches no GitLab project on GitHub', async () => {
        await setUp({ groups: [GRAYJAY], streamGroups: ['grayjay'] });

        await send('octokit/rest.js#5');

        expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
          'octokit',
          'rest.js',
          5,
          undefined,
          true,
        );
        expect(gitlabMock.getItem).not.toHaveBeenCalled();
      });

      it('should keep a github.com link on GitHub when its owner/name ends a GitLab project path', async () => {
        await setUp({ groups: [GRAYJAY], streamGroups: ['grayjay'] });

        await send('https://github.com/videostreaming/grayjay/issues/5');

        expect(githubMock.getIssueOrPrMessage).toHaveBeenCalledExactlyOnceWith(
          'videostreaming',
          'grayjay',
          5,
          undefined,
          true,
        );
        expect(gitlabMock.getItem).not.toHaveBeenCalled();
      });

      it('should send name#N that matches nothing to that name beside a GitLab default', async () => {
        await setUp({ groups: [GRAYJAY], streamGroups: ['grayjay'] });

        await send('other#5');

        expect(gitlabMock.getItem.mock.calls).toEqual([
          ['videostreaming/other', 'issues', 5],
          ['videostreaming/other', 'merge_requests', 5],
        ]);
        expect(githubMock.getIssueOrPrMessage).not.toHaveBeenCalled();
      });

      const fileAt = (ref: string, file: string, lines: string[]) =>
        gitlabMock.getFileContent.mockImplementation(async (_, givenRef, givenFile) =>
          givenRef === ref && givenFile === file ? lines : undefined,
        );

      it('should post the lines of GitHub and GitLab permalinks in a stream without a group, mentions as written', async () => {
        await setUp({ groups: [FHS], streamGroups: [] });
        githubMock.getRepositoryFileContent.mockResolvedValueOnce(['const who = "@**all**";', 'two']);
        fileAt('master', 'app/Main.kt', ['val who = "@**all**"', 'two']);

        await send(
          'https://github.com/immich-app/immich/blob/main/src/x.ts#L1 https://gitlab.futo.org/videostreaming/grayjay/-/blob/master/app/Main.kt#L1',
        );

        expect(githubMock.getRepositoryFileContent).toHaveBeenCalledExactlyOnceWith(
          'immich-app',
          'immich',
          'main',
          'src/x.ts',
          true,
        );
        expect(gitlabMock.getFileContent).toHaveBeenCalledWith('videostreaming/grayjay', 'master', 'app/Main.kt');
        const [content] = reply();
        expect(content).toContain('const who = "@**all**";');
        expect(content).toContain('```kt\nval who = "@**all**"\n```');
      });

      it.each(['#L2-4', '#L2-L4'])('should post the lines of a GitLab permalink ending %s', async (anchor) => {
        await setUp({ groups: [FHS], streamGroups: ['fhs'] });
        fileAt('master', 'app/src/Main File.kt', ['one', 'two', 'three', 'four', 'five']);

        await send(`https://gitlab.futo.org/videostreaming/grayjay/-/blob/master/app/src/Main%20File.kt${anchor}`);

        expect(gitlabMock.getFileContent.mock.calls).toEqual([
          ['videostreaming/grayjay', 'master', 'app/src/Main File.kt'],
          ['videostreaming/grayjay', 'master/app', 'src/Main File.kt'],
          ['videostreaming/grayjay', 'master/app/src', 'Main File.kt'],
        ]);
        expect(githubMock.getRepositoryFileContent).not.toHaveBeenCalled();
        expect(reply()).toEqual(['```kt\ntwo\nthree\nfour\n```']);
      });

      it('should find the file of a permalink whose ref holds a slash', async () => {
        await setUp({ groups: [FHS], streamGroups: ['fhs'] });
        fileAt('feature/player', 'src/Main.kt', ['one', 'two']);

        await send('https://gitlab.futo.org/videostreaming/grayjay/-/blob/feature/player/src/Main.kt#L2');

        expect(reply()).toEqual(['```kt\ntwo\n```']);
      });

      it('should take the longest ref that has the file, as GitLab does', async () => {
        await setUp({ groups: [FHS], streamGroups: ['fhs'] });
        gitlabMock.getFileContent.mockImplementation(async (_, ref) =>
          ref === 'feature' ? ['from feature'] : ref === 'feature/player' ? ['from feature/player'] : undefined,
        );

        await send('https://gitlab.futo.org/videostreaming/grayjay/-/blob/feature/player/src/Main.kt#L1');

        expect(reply()).toEqual(['```kt\nfrom feature/player\n```']);
      });

      it('should try no more than five leading segments as the ref', async () => {
        await setUp({ groups: [FHS], streamGroups: ['fhs'] });

        await send('https://gitlab.futo.org/videostreaming/grayjay/-/blob/a/b/c/d/e/f/g/Main.kt#L1');

        expect(gitlabMock.getFileContent.mock.calls.map(([, ref]) => ref)).toEqual([
          'a',
          'a/b',
          'a/b/c',
          'a/b/c/d',
          'a/b/c/d/e',
        ]);
      });

      it('should skip a GitLab permalink of more than 20 lines', async () => {
        await setUp({ groups: [FHS], streamGroups: ['fhs'] });
        fileAt(
          'master',
          'app/Main.kt',
          Array.from({ length: 30 }, (_, index) => `line ${index}`),
        );

        await send('https://gitlab.futo.org/videostreaming/grayjay/-/blob/master/app/Main.kt#L1-25');

        expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      });

      it('should skip a permalink with a malformed escape and still expand the rest of the message', async () => {
        await setUp({ groups: [FHS], streamGroups: ['fhs'] });
        fileAt('main', 'Main.kt', ['fine']);
        gitlabMock.getItem.mockResolvedValue({
          kind: 'issues',
          title: 'Broken',
          url: 'https://gitlab.futo.org/videostreaming/grayjay/-/issues/3',
          updatedAt: new Date(),
        });

        await send(
          [
            'https://gitlab.futo.org/videostreaming/grayjay/-/blob/main/file%.kt#L1',
            'https://github.com/immich-app/immich/blob/main/bad%zz.ts#L1',
            'https://gitlab.futo.org/videostreaming/grayjay/-/blob/main/Main.kt#L1',
            'https://gitlab.futo.org/videostreaming/grayjay/-/issues/3',
          ].join(' '),
        );

        expect(githubMock.getRepositoryFileContent).not.toHaveBeenCalled();
        expect(reply()).toEqual([
          '```kt\nfine\n```\n[Issue] Broken ([videostreaming/grayjay#3](https://gitlab.futo.org/videostreaming/grayjay/-/issues/3))',
        ]);
      });

      it('should fetch the snippets of a message at once, not one after another', async () => {
        await setUp({ groups: [FHS], streamGroups: ['fhs'] });
        const pending: (() => void)[] = [];
        gitlabMock.getFileContent.mockImplementation(
          () => new Promise((resolve) => pending.push(() => resolve(['line']))),
        );

        const sending = send(
          [
            'https://gitlab.futo.org/videostreaming/grayjay/-/blob/main/A.kt#L1',
            'https://gitlab.futo.org/videostreaming/grayjay/-/blob/main/B.kt#L1',
          ].join(' '),
        );
        await vitest.waitFor(() => expect(gitlabMock.getFileContent).toHaveBeenCalledTimes(2));
        for (const resolve of pending) {
          resolve();
        }
        await sending;

        expect(reply()).toEqual(['```kt\nline\n```\n```kt\nline\n```']);
      });

      it('should read the files of the first five permalinks of a message only', async () => {
        await setUp({ groups: [FHS], streamGroups: ['fhs'] });

        await send(
          Array.from(
            { length: 7 },
            (_, index) => `https://gitlab.futo.org/videostreaming/grayjay/-/blob/main/File${index}.kt#L1`,
          ).join(' '),
        );

        expect(gitlabMock.getFileContent.mock.calls.map(([, , file]) => file)).toEqual([
          'File0.kt',
          'File1.kt',
          'File2.kt',
          'File3.kt',
          'File4.kt',
        ]);
      });

      it('should read the first five permalinks of a message across GitHub and GitLab, in order', async () => {
        await setUp({ groups: [FHS], streamGroups: ['fhs'] });
        const github = (name: string) => `https://github.com/immich-app/immich/blob/main/${name}.ts#L1`;
        const gitlab = (name: string) => `https://gitlab.futo.org/videostreaming/grayjay/-/blob/main/${name}.kt#L1`;

        await send(
          [github('a'), gitlab('b'), gitlab('c'), github('d'), gitlab('e'), github('f'), gitlab('g')].join(' '),
        );

        expect(githubMock.getRepositoryFileContent.mock.calls.map(([, , , file]) => file)).toEqual(['a.ts', 'd.ts']);
        expect(gitlabMock.getFileContent.mock.calls.map(([, , file]) => file)).toEqual(['b.kt', 'c.kt', 'e.kt']);
      });

      it('should leave the permalinks of Discord uncapped, read five at a time, in order', async () => {
        let running = 0;
        let mostRunning = 0;
        githubMock.getRepositoryFileContent.mockImplementation(async (_org, _repo, _ref, path) => {
          running++;
          mostRunning = Math.max(mostRunning, running);
          await new Promise((resolve) => setTimeout(resolve, 1));
          running--;
          return [path];
        });

        const snippets = await sut.handleGithubFileReferences(
          Array.from({ length: 7 }, (_, index) => `https://github.com/immich-app/immich/blob/main/${index}.ts#L1`).join(
            ' ',
          ),
          false,
        );

        expect(githubMock.getRepositoryFileContent).toHaveBeenCalledTimes(7);
        expect(mostRunning).toBe(5);
        expect(snippets).toEqual(Array.from({ length: 7 }, (_, index) => `\`\`\`ts\n${index}.ts\n\`\`\``));
      });

      it('should post an item once when #N and its link both reach it', async () => {
        await setUp({ groups: [GRAYJAY], streamGroups: ['grayjay'] });
        gitlabMock.getItem.mockImplementation(async (_, kind) =>
          kind === 'issues'
            ? {
                kind,
                title: 'Seven',
                url: 'https://gitlab.futo.org/videostreaming/grayjay/-/issues/7',
                updatedAt: new Date(),
              }
            : undefined,
        );

        await send('#7 https://gitlab.futo.org/videostreaming/grayjay/-/issues/7');

        expect(reply()).toEqual([
          '[Issue] Seven ([videostreaming/grayjay#7](https://gitlab.futo.org/videostreaming/grayjay/-/issues/7))',
        ]);
      });

      it('should keep GitHub permalinks on GitHub', async () => {
        await setUp({ groups: [GRAYJAY], streamGroups: ['grayjay'] });

        await send('https://github.com/immich-app/immich/blob/main/server/src/main.ts#L1');

        expect(githubMock.getRepositoryFileContent).toHaveBeenCalledExactlyOnceWith(
          'immich-app',
          'immich',
          'main',
          'server/src/main.ts',
          true,
        );
        expect(gitlabMock.getFileContent).not.toHaveBeenCalled();
      });
    });
  });
});
