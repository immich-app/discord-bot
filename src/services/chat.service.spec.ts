import { ClientError } from '@mattermost/client';
import { Logger } from '@nestjs/common';
import { CommandInteraction, GuildEmoji } from 'discord.js';
import { Constants } from 'src/constants';
import { DiscordCommands } from 'src/discord/commands';
import { neutraliseZulipLabel } from 'src/format';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IFourthwallRepository } from 'src/interfaces/fourthwall.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { ILoopDedupeInterface } from 'src/interfaces/loop-dedupe.interface';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { IOutlineInterface } from 'src/interfaces/outline.interface';
import { IZulipInterface, ZulipReceivedMessage } from 'src/interfaces/zulip.interface';
import { ZulipApiError } from 'src/repositories/zulip.client';
import { ChatService, formatEmoteSyncReport } from 'src/services/chat.service';
import { ZulipMessageHandler, ZulipService } from 'src/services/zulip.service';
import { Mocked, afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

vitest.mock('src/config', () => ({
  getConfig: () => ({
    bot: { token: 'dev' },
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
});

const newMattermostMockRepository = (): Mocked<IMattermostInterface> => ({
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
  getMessage: vitest.fn(),
  updateMessage: vitest.fn(),
  listEmoji: vitest.fn(),
  getSubscriptions: vitest.fn(),
  getOwnUser: vitest.fn(),
  getMessages: vitest.fn(),
  registerQueue: vitest.fn(),
  getEvents: vitest.fn(),
  deleteQueue: vitest.fn(),
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
      mattermostMock.listEmoji.mockResolvedValue([]);
    });

    it('should upload every Discord emote to Zulip and Mattermost, then report done', async () => {
      const { interaction, deferReply, reply } = newInteraction();
      discordMock.getEmotes.mockResolvedValue([
        { identifier: 'catJAM:1', name: 'catJAM', url: 'https://cdn.discordapp.com/emojis/1.webp', animated: false },
        { identifier: 'a:pepeD:2', name: 'pepeD', url: 'https://cdn.discordapp.com/emojis/2.webp', animated: true },
        { identifier: 'nameless:3', name: null, url: 'https://cdn.discordapp.com/emojis/3.png', animated: false },
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
      discordMock.getEmotes.mockResolvedValue([{ identifier: 'catJAM:1', name: 'catJAM', url, animated }]);

      await syncEmotes(interaction);

      expect(zulipMock.createEmote).toHaveBeenCalledOnce();
      expect(zulipMock.createEmote).toHaveBeenCalledWith('catjam', expected);
      expect(mattermostMock.createEmote).toHaveBeenCalledOnce();
      expect(mattermostMock.createEmote).toHaveBeenCalledWith('catJAM', expected);
    });

    it('should defer the reply, upload each emote to Zulip then Mattermost one at a time, then edit the reply', async () => {
      const { interaction, deferReply, reply } = newInteraction();
      discordMock.getEmotes.mockResolvedValue([
        { identifier: 'catJAM:1', name: 'catJAM', url: 'https://cdn.discordapp.com/emojis/1.webp', animated: false },
        { identifier: 'pepeD:2', name: 'pepeD', url: 'https://cdn.discordapp.com/emojis/2.webp', animated: false },
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

      it('should skip an emote whose name is already on Zulip instead of uploading it again', async () => {
        const { interaction, reply } = newInteraction();
        discordMock.getEmotes.mockResolvedValue([emote('catJAM', 1), emote('pepeD', 2)]);
        zulipMock.listEmoji.mockResolvedValue([{ name: 'catjam', deactivated: false }]);

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
        zulipMock.listEmoji.mockResolvedValue([{ name: 'catjam', deactivated: true }]);

        await syncEmotes(interaction);

        expect(zulipMock.createEmote).toHaveBeenCalledOnce();
        expect(zulipMock.createEmote).toHaveBeenCalledWith('catjam', 'https://cdn.discordapp.com/emojis/1.webp');
        expect(reply.edit).toHaveBeenCalledWith('Done syncing: 1 emote, 1 uploaded to Zulip, 1 uploaded to Mattermost');
      });

      it('should be a no-op on Zulip when synced twice, suffixed names included', async () => {
        discordMock.getEmotes.mockResolvedValue([emote('catJAM', 1), emote('CatJam', 2), emote('nameless:3', 3)]);

        await syncEmotes(newInteraction().interaction);

        expect(zulipMock.createEmote.mock.calls).toEqual([
          ['catjam', 'https://cdn.discordapp.com/emojis/1.webp'],
          ['catjam2', 'https://cdn.discordapp.com/emojis/2.webp'],
          ['nameless_3', 'https://cdn.discordapp.com/emojis/3.webp'],
        ]);

        zulipMock.createEmote.mockClear();
        zulipMock.listEmoji.mockResolvedValue(
          ['catjam', 'catjam2', 'nameless_3'].map((name) => ({ name, deactivated: false })),
        );
        const { interaction, reply } = newInteraction();

        await syncEmotes(interaction);

        expect(zulipMock.createEmote).not.toHaveBeenCalled();
        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 3 emotes, 0 uploaded to Zulip, 3 uploaded to Mattermost, 3 already on Zulip: catJAM, CatJam → catjam2, nameless:3 → nameless_3',
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
        { identifier: 'catJAM:1', name: 'catJAM', url: 'https://cdn.discordapp.com/emojis/1.webp', animated: false },
        { identifier: 'pepeD:2', name: 'pepeD', url: 'https://cdn.discordapp.com/emojis/2.webp', animated: false },
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
        { identifier: 'catJAM:1', name: 'catJAM', url: 'https://cdn.discordapp.com/emojis/1.webp', animated: false },
        { identifier: 'pepeD:2', name: 'pepeD', url: 'https://cdn.discordapp.com/emojis/2.webp', animated: false },
        { identifier: 'nameless:3', name: null, url: 'https://cdn.discordapp.com/emojis/3.png', animated: false },
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

      it('should still report a Mattermost failure when Zulip was skipped', async () => {
        const { interaction, reply } = newInteraction();
        zulipMock.listEmoji.mockRejectedValue(new Error('Zulip client not initialised'));
        mattermostMock.createEmote.mockResolvedValueOnce().mockRejectedValueOnce(new Error('boom'));

        await syncEmotes(interaction);

        expect(reply.edit).toHaveBeenCalledWith(
          'Done syncing: 3 emotes, 0 uploaded to Zulip (skipped: its emoji could not be listed), 2 uploaded to Mattermost, 1 failed: pepeD',
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

  describe('init', () => {
    it('should leave Zulip initialisation to ZulipService', async () => {
      await sut.init();

      expect(zulipMock.init).not.toHaveBeenCalled();
      expect(mattermostMock.init).toHaveBeenCalledOnce();
    });

    it('should subscribe the Zulip expanders to the event loop', async () => {
      await sut.init();

      expect(zulipServiceMock.onMessage).toHaveBeenCalledOnce();
      const [handler] = zulipServiceMock.onMessage.mock.calls[0];
      await handler(zulipMessage({ content: 'see #4242' }));
      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
    });
  });

  const zulipMessage = (overrides: Partial<ZulipReceivedMessage> = {}): ZulipReceivedMessage => ({
    id: 900,
    senderId: 12,
    senderEmail: 'alice@example.com',
    type: 'stream',
    streamId: Constants.Zulip.TeamStreams.ImmichGeneral,
    topic: 'thumbnails',
    content: 'hello',
    ...overrides,
  });

  describe('onZulipMessage', () => {
    beforeEach(() => {
      zulipMock.sendMessage.mockResolvedValue({ id: 901 });
    });

    it('should run in the Immich stream and every immich team stream', () => {
      expect(Constants.Zulip.Expanders.GithubReferences).toEqual([54, 107, 108, 109, 110, 111, 112, 113]);
      expect(Constants.Zulip.Expanders.TwitterMirror).toEqual([54, 107, 108, 109, 110, 111, 112, 113]);
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
