/* eslint-disable @typescript-eslint/no-explicit-any */
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { DiscordService } from 'src/services/discord.service';
import { Mocked, describe, expect, it, vitest } from 'vitest';

const newGithubMockRepository = (): Mocked<IGithubInterface> => ({
  search: vitest.fn(),
  getDiscussion: vitest.fn(),
  getForkCount: vitest.fn(),
  getIssueOrPr: vitest.fn(),
  getStarCount: vitest.fn(),
});

const newDiscordMockRepository = (): Mocked<IDiscordInterface> => ({
  once: vitest.fn() as any,
  on: vitest.fn() as any,
  login: vitest.fn(),
  initApplicationCommands: vitest.fn(),
  sendMessage: vitest.fn(),
});

describe('Bot test', () => {
  let sut: DiscordService;

  let discordMock: Mocked<IDiscordInterface>;
  let githubMock: Mocked<IGithubInterface>;

  beforeEach(() => {
    discordMock = newDiscordMockRepository();
    discordMock.on.mockReturnValue(discordMock);
    discordMock.once.mockReturnValue(discordMock);

    githubMock = newGithubMockRepository();

    sut = new DiscordService(discordMock, githubMock);
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
      { name: 'find single reference', content: '#4242', referenceCount: 1 },
      { name: 'find multiple references', content: '#4242 #6969', referenceCount: 2 },
      {
        name: 'ignore unusual references if multiple references are present',
        content: '#123 #4242',
        referenceCount: 1,
      },
      { name: 'find single unusual reference', content: '#123', referenceCount: 1 },
      { name: 'ignore references in code blocks', content: '```#4242 #123``` #6969', referenceCount: 1 },
    ])('should $name for PRs', async ({ content, referenceCount }) => {
      githubMock.getIssueOrPr.mockResolvedValue('https://some-github-link/<id>');

      await expect(sut.handleGithubReferences(content)).resolves.toEqual(
        Array(referenceCount).fill('https://some-github-link/<id>'),
      );
    });

    it.each([
      { name: 'find single reference', content: '#4242', referenceCount: 1 },
      { name: 'find multiple references', content: '#4242 #6969', referenceCount: 2 },
      {
        name: 'ignore unusual references if multiple references are present',
        content: '#123 #4242',
        referenceCount: 1,
      },
      { name: 'find single unusual reference', content: '#123', referenceCount: 1 },
      { name: 'ignore references in code blocks', content: '```#4242 #123``` #6969', referenceCount: 1 },
    ])('should $name for discussions', async ({ content, referenceCount }) => {
      githubMock.getDiscussion.mockResolvedValue('https://some-github-link/<id>');

      await expect(sut.handleGithubReferences(content)).resolves.toEqual(
        Array(referenceCount).fill('https://some-github-link/<id>'),
      );
    });
  });
});
