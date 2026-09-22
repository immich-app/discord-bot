import { Logger } from '@nestjs/common';
import { CommandInteraction, GuildEmoji } from 'discord.js';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IFourthwallRepository } from 'src/interfaces/fourthwall.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { ILoopDedupeInterface } from 'src/interfaces/loop-dedupe.interface';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { IOutlineInterface } from 'src/interfaces/outline.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';
import { ChatService } from 'src/services/chat.service';
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

const newZulipMockRepository = (): Mocked<IZulipInterface> => ({
  init: vitest.fn(),
  createEmote: vitest.fn(),
  sendMessage: vitest.fn(),
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

    it('should upload every Discord emote to Zulip and Mattermost, then report done', async () => {
      const { interaction, deferReply, reply } = newInteraction();
      discordMock.getEmotes.mockResolvedValue([
        { identifier: 'catJAM:1', name: 'catJAM', url: 'https://cdn.discordapp.com/emojis/1.webp', animated: false },
        { identifier: 'a:pepeD:2', name: 'pepeD', url: 'https://cdn.discordapp.com/emojis/2.webp', animated: true },
        { identifier: 'nameless:3', name: null, url: 'https://cdn.discordapp.com/emojis/3.png', animated: false },
      ]);

      await sut.syncEmotes(interaction);

      expect(discordMock.getEmotes).toHaveBeenCalledOnce();
      expect(discordMock.getEmotes).toHaveBeenCalledWith('guild-1');

      const uploads = [
        ['catJAM', 'https://cdn.discordapp.com/emojis/1.webp'],
        ['pepeD', 'https://cdn.discordapp.com/emojis/2.gif'],
        ['nameless:3', 'https://cdn.discordapp.com/emojis/3.png'],
      ];
      expect(zulipMock.createEmote.mock.calls).toEqual(uploads);
      expect(mattermostMock.createEmote.mock.calls).toEqual(uploads);
      expect(discordMock.createEmote).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      expect(deferReply).toHaveBeenCalledOnce();
      expect(reply.edit).toHaveBeenCalledOnce();
      expect(reply.edit).toHaveBeenCalledWith('Done syncing');
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

      await sut.syncEmotes(interaction);

      expect(zulipMock.createEmote).toHaveBeenCalledOnce();
      expect(zulipMock.createEmote).toHaveBeenCalledWith('catJAM', expected);
      expect(mattermostMock.createEmote).toHaveBeenCalledOnce();
      expect(mattermostMock.createEmote).toHaveBeenCalledWith('catJAM', expected);
    });

    it('should defer the reply, upload each emote to Zulip then Mattermost one at a time, then edit the reply', async () => {
      const { interaction, deferReply, reply } = newInteraction();
      discordMock.getEmotes.mockResolvedValue([
        { identifier: 'catJAM:1', name: 'catJAM', url: 'https://cdn.discordapp.com/emojis/1.webp', animated: false },
        { identifier: 'pepeD:2', name: 'pepeD', url: 'https://cdn.discordapp.com/emojis/2.webp', animated: false },
      ]);

      await sut.syncEmotes(interaction);

      const [defer] = deferReply.mock.invocationCallOrder;
      const [getEmotes] = discordMock.getEmotes.mock.invocationCallOrder;
      const [zulipFirst, zulipSecond] = zulipMock.createEmote.mock.invocationCallOrder;
      const [mattermostFirst, mattermostSecond] = mattermostMock.createEmote.mock.invocationCallOrder;
      const [edit] = reply.edit.mock.invocationCallOrder;
      expect(defer).toBeLessThan(getEmotes);
      expect(getEmotes).toBeLessThan(zulipFirst);
      expect(zulipFirst).toBeLessThan(mattermostFirst);
      expect(mattermostFirst).toBeLessThan(zulipSecond);
      expect(zulipSecond).toBeLessThan(mattermostSecond);
      expect(mattermostSecond).toBeLessThan(edit);
    });

    describe('failures', () => {
      const emotes = [
        { identifier: 'catJAM:1', name: 'catJAM', url: 'https://cdn.discordapp.com/emojis/1.webp', animated: false },
        { identifier: 'pepeD:2', name: 'pepeD', url: 'https://cdn.discordapp.com/emojis/2.webp', animated: false },
        { identifier: 'nameless:3', name: null, url: 'https://cdn.discordapp.com/emojis/3.png', animated: false },
      ];
      const uploads = [
        ['catJAM', 'https://cdn.discordapp.com/emojis/1.webp'],
        ['pepeD', 'https://cdn.discordapp.com/emojis/2.webp'],
        ['nameless:3', 'https://cdn.discordapp.com/emojis/3.png'],
      ];

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

        await sut.syncEmotes(interaction);

        expect(zulipMock.createEmote.mock.calls).toEqual(uploads);
        expect(mattermostMock.createEmote.mock.calls).toEqual(uploads);
        expect(Logger.prototype.error).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'Could not sync emote catJAM - https://cdn.discordapp.com/emojis/1.webp to Zulip',
          expect.any(Error),
        );
        expect(reply.edit).toHaveBeenCalledOnce();
        expect(reply.edit).toHaveBeenCalledWith('Done syncing, 1 failed: catJAM');
      });

      it('should keep syncing when a Mattermost upload fails and report the emote', async () => {
        const { interaction, reply } = newInteraction();
        mattermostMock.createEmote.mockResolvedValueOnce().mockRejectedValueOnce(new Error('boom'));

        await sut.syncEmotes(interaction);

        expect(zulipMock.createEmote.mock.calls).toEqual(uploads);
        expect(mattermostMock.createEmote.mock.calls).toEqual(uploads);
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'Could not sync emote pepeD - https://cdn.discordapp.com/emojis/2.webp to Mattermost',
          expect.any(Error),
        );
        expect(reply.edit).toHaveBeenCalledWith('Done syncing, 1 failed: pepeD');
      });

      it('should report each failed emote once, whichever platforms failed', async () => {
        const { interaction, reply } = newInteraction();
        zulipMock.createEmote.mockRejectedValueOnce(new Error('zulip')).mockRejectedValueOnce(new Error('zulip'));
        mattermostMock.createEmote.mockRejectedValueOnce(new Error('mattermost'));

        await sut.syncEmotes(interaction);

        expect(zulipMock.createEmote.mock.calls).toEqual(uploads);
        expect(mattermostMock.createEmote.mock.calls).toEqual(uploads);
        expect(Logger.prototype.error).toHaveBeenCalledTimes(3);
        expect(reply.edit).toHaveBeenCalledWith('Done syncing, 2 failed: catJAM, pepeD');
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

        await sut.syncEmotes(interaction);

        expect(zulipMock.createEmote).toHaveBeenCalledTimes(300);
        expect(mattermostMock.createEmote).toHaveBeenCalledTimes(300);
        expect(reply.edit).toHaveBeenCalledOnce();
        const [report] = reply.edit.mock.calls[0] as [string];
        expect(report).toMatch(/^Done syncing, 300 failed: emote_number_0, emote_number_1, /);
        expect(report).toMatch(/\.\.\.$/);
        expect(report).toHaveLength(2000);
      });
    });
  });

  describe('init', () => {
    it('should leave Zulip initialisation to ZulipService', async () => {
      await sut.init();

      expect(zulipMock.init).not.toHaveBeenCalled();
      expect(mattermostMock.init).toHaveBeenCalledOnce();
    });
  });
});
