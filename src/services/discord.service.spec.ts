import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { DiscordService } from 'src/services/discord.service';
import { Mocked, describe, expect, it, vitest } from 'vitest';

const newGithubMockRepository = (): Mocked<IGithubInterface> => ({
  search: vitest.fn(),
  getDiscussion: vitest
    .fn()
    .mockImplementation((org, repo, id) => Promise.resolve(`https://github.com/${org}/${repo}/discussion/${id}`)),
  getForkCount: vitest.fn(),
  getIssueOrPr: vitest
    .fn()
    .mockImplementation((org, repo, id) =>
      Promise.resolve(`https://github.com/${org}/${repo}/${id % 2 === 0 ? 'pull' : 'issue'}/${id}`),
    ),
  getStarCount: vitest.fn(),
});

const newDiscordMockRepository = (): Mocked<IDiscordInterface> => ({
  login: vitest.fn(),
  sendMessage: vitest.fn(),
  createEmote: vitest.fn(),
});

const newDatabaseMockRepository = (): Mocked<IDatabaseRepository> => ({
  addDiscordLink: vitest.fn(),
  createPayment: vitest.fn(),
  getDiscordLinks: vitest.fn(),
  getDiscordLink: vitest.fn(),
  removeDiscordLink: vitest.fn(),
  getSponsorLicenses: vitest.fn(),
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
  updateFourthwallOrder: vitest.fn(),
});

describe('Bot test', () => {
  let sut: DiscordService;

  let discordMock: Mocked<IDiscordInterface>;
  let githubMock: Mocked<IGithubInterface>;
  let databaseMock: Mocked<IDatabaseRepository>;

  beforeEach(() => {
    discordMock = newDiscordMockRepository();
    githubMock = newGithubMockRepository();
    databaseMock = newDatabaseMockRepository();

    sut = new DiscordService(discordMock, githubMock, databaseMock);
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

  describe('handleGithubReferences', () => {
    it.each([
      {
        name: 'should handle a number',
        message: '#4242',
        links: ['https://github.com/immich-app/immich/pull/4242'],
      },
      {
        name: 'should handle multiple numbers',
        message: '#4242 #6969',
        links: ['https://github.com/immich-app/immich/pull/4242', 'https://github.com/immich-app/immich/issue/6969'],
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
        links: ['https://github.com/immich-app/immich/issue/6969'],
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
        name: 'should return all the links',
        message: [
          '#1234',
          'immich#123',
          'static-pages#123',
          'immich-app/static-pages#123',
          'octokit/rest.js#123',
          'https://github.com/immich-app/immich/pull/1',
          'https://github.com/immich-app/immich/issue/2',
          'https://github.com/immich-app/immich/discussion/3',
        ].join('\n'),
        links: [
          'https://github.com/immich-app/immich/issue/1',
          'https://github.com/immich-app/immich/pull/2',
          'https://github.com/immich-app/immich/discussion/3',
          'https://github.com/immich-app/immich/pull/1234',
          'https://github.com/immich-app/immich/issue/123',
          'https://github.com/immich-app/static-pages/issue/123',
          'https://github.com/octokit/rest.js/issue/123',
        ],
      },
    ])('should $name', async ({ message: message, links }) => {
      await expect(sut.handleGithubReferences(message)).resolves.toEqual(links);
    });
  });
});
