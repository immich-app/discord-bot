import { Mocked, describe, expect, it, vitest } from 'vitest';
import { BotRepository } from './repositories/bot.repository.js';
import { getForksMessage, getStarsMessage, handleGithubReferences, handleSearchAutocompletion } from './service.js';

const newRepository: () => Mocked<BotRepository> = () => ({
  search: vitest.fn(),
  getDiscussion: vitest.fn(),
  getForkCount: vitest.fn(),
  getIssueOrPr: vitest.fn(),
  getStarCount: vitest.fn(),
});

describe('Bot test', () => {
  describe('handleSearchAutocompletion', () => {
    it('should return nothing if search fails', async () => {
      const repository = newRepository();
      repository.search.mockRejectedValue('some error');
      const result = await handleSearchAutocompletion(repository, 'test');

      expect(result).toEqual([]);
      expect(repository.search).toHaveBeenCalledWith(
        expect.objectContaining({ query: `repo:immich-app/immich in:title test` }),
      );
    });

    it('should return nothing if search string is empty', async () => {
      const repository = newRepository();
      const result = await handleSearchAutocompletion(repository, '');

      expect(result).toEqual([]);
      expect(repository.search).not.toHaveBeenCalled();
    });

    it('should correctly map responses', async () => {
      const repository = newRepository();
      repository.search.mockResolvedValue({
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

      const result = await handleSearchAutocompletion(repository, 'first');
      expect(result).toEqual([
        { name: '[PR] (123) my-first-pr', value: '123' },
        { name: '[Issue] (321) my-first-issue', value: '321' },
      ]);
      expect(repository.search).toHaveBeenCalledWith(
        expect.objectContaining({ query: `repo:immich-app/immich in:title first` }),
      );
    });
  });

  describe('getStarsMessage', () => {
    it('should return an error message if the api call was unsuccessful', async () => {
      const repository = newRepository();
      repository.getStarCount.mockRejectedValue('error');

      const result = await getStarsMessage(repository, '123');

      expect(result).toEqual('Could not fetch stars count from the GitHub API');
      expect(repository.getStarCount).toHaveBeenCalled();
    });

    it('should return current star count', async () => {
      const repository = newRepository();
      repository.getStarCount.mockResolvedValue(42);

      const result = await getStarsMessage(repository, '1');

      expect(result).toEqual('Stars ⭐: 42');
      expect(repository.getStarCount).toHaveBeenCalled();
    });

    it('should include delta for subsequent calls', async () => {
      const repository = newRepository();
      repository.getStarCount.mockResolvedValueOnce(42);
      repository.getStarCount.mockResolvedValueOnce(420);

      const result = await getStarsMessage(repository, '2');

      expect(result).toEqual('Stars ⭐: 42');
      expect(repository.getStarCount).toHaveBeenCalledOnce();

      const secondResult = await getStarsMessage(repository, '2');

      expect(secondResult).toEqual('Stars ⭐: 420 (+378 stars since the last call in this channel)');
      expect(repository.getStarCount).toHaveBeenCalledTimes(2);
    });

    it('should not include delta if in different channels', async () => {
      const repository = newRepository();
      repository.getStarCount.mockResolvedValueOnce(42);
      repository.getStarCount.mockResolvedValueOnce(420);

      const result = await getStarsMessage(repository, '3');

      expect(result).toEqual('Stars ⭐: 42');
      expect(repository.getStarCount).toHaveBeenCalledOnce();

      const secondResult = await getStarsMessage(repository, '4');

      expect(secondResult).toEqual('Stars ⭐: 420');
      expect(repository.getStarCount).toHaveBeenCalledTimes(2);
    });
  });

  describe('getForksMessage', () => {
    it('should return an error message if the api call was unsuccessful', async () => {
      const repository = newRepository();
      repository.getForkCount.mockRejectedValue('error');

      const result = await getForksMessage(repository, '1');

      expect(result).toEqual('Could not fetch forks count from the GitHub API');
      expect(repository.getForkCount).toHaveBeenCalled();
    });

    it('should return current star count', async () => {
      const repository = newRepository();
      repository.getForkCount.mockResolvedValue(42);

      const result = await getForksMessage(repository, '1');

      expect(result).toEqual('Forks: 42');
      expect(repository.getForkCount).toHaveBeenCalled();
    });

    it('should include delta for subsequent calls', async () => {
      const repository = newRepository();
      repository.getForkCount.mockResolvedValueOnce(42);
      repository.getForkCount.mockResolvedValueOnce(420);

      const result = await getForksMessage(repository, '2');

      expect(result).toEqual('Forks: 42');
      expect(repository.getForkCount).toHaveBeenCalledOnce();

      const secondResult = await getForksMessage(repository, '2');

      expect(secondResult).toEqual('Forks: 420 (+378 forks since the last call in this channel)');
      expect(repository.getForkCount).toHaveBeenCalledTimes(2);
    });

    it('should not include delta if in different channels', async () => {
      const repository = newRepository();
      repository.getForkCount.mockResolvedValueOnce(42);
      repository.getForkCount.mockResolvedValueOnce(420);

      const result = await getForksMessage(repository, '3');

      expect(result).toEqual('Forks: 42');
      expect(repository.getForkCount).toHaveBeenCalledOnce();

      const secondResult = await getForksMessage(repository, '4');

      expect(secondResult).toEqual('Forks: 420');
      expect(repository.getForkCount).toHaveBeenCalledTimes(2);
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
      const repository = newRepository();
      repository.getIssueOrPr.mockResolvedValue('https://some-github-link/<id>');

      await expect(handleGithubReferences(repository, content)).resolves.toEqual(
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
      const repository = newRepository();
      repository.getDiscussion.mockResolvedValue('https://some-github-link/<id>');

      await expect(handleGithubReferences(repository, content)).resolves.toEqual(
        Array(referenceCount).fill('https://some-github-link/<id>'),
      );
    });
  });
});
