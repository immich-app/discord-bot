import { IGithubInterface, PullRequest } from 'src/interfaces/github.interface';
import { GithubService } from 'src/services/github.service';
import { Mocked, beforeEach, describe, expect, it, vitest } from 'vitest';

vitest.mock('src/config', () => ({
  getConfig: () => ({ github: { appId: 'dev', privateKey: '', installationId: '' } }),
}));

const newGithubMockRepository = (): Mocked<IGithubInterface> => ({
  search: vitest.fn(),
  getDiscussionMessage: vitest.fn(),
  getForkCount: vitest.fn(),
  getIssueOrPrMessage: vitest.fn(),
  getStarCount: vitest.fn(),
  init: vitest.fn(),
  getRepositoryFileContent: vitest.fn(),
  getCheckSuiteTriggerCommit: vitest.fn(),
  getLatestReleaseTag: vitest.fn(),
  isCollaborator: vitest.fn(),
  getPullRequests: vitest.fn(),
  getPullRequest: vitest.fn(),
});

const graphqlPullRequest = (number: number, overrides: Partial<PullRequest> = {}): PullRequest => ({
  id: `PR_node_${number}`,
  fullDatabaseId: `${1000 + number}`,
  number,
  title: `PR ${number}`,
  body: `Body ${number}`,
  url: `https://github.com/immich-app/immich/pull/${number}`,
  state: 'OPEN',
  repository: { nameWithOwner: 'immich-app/immich' },
  author: { __typename: 'User' },
  ...overrides,
});

const event = (number: number, sender: 'Bot' | 'User' | 'Organization' = 'User') => ({
  pull_request: {
    node_id: `PR_node_${number}`,
    id: 1000 + number,
    number,
    title: `PR ${number}`,
    body: `Body ${number}`,
    html_url: `https://github.com/immich-app/immich/pull/${number}`,
  },
  repository: { full_name: 'immich-app/immich' },
  sender: { type: sender },
});

async function* pages(...batches: PullRequest[][]) {
  for (const batch of batches) {
    yield batch;
  }
}

describe(GithubService.name, () => {
  let sut: GithubService;
  let githubMock: Mocked<IGithubInterface>;

  beforeEach(() => {
    githubMock = newGithubMockRepository();
    sut = new GithubService(githubMock);
  });

  describe('getOpenPullRequests', () => {
    it('should page the open pull requests of immich-app/immich into webhook-shaped events', async () => {
      githubMock.getPullRequests.mockReturnValue(
        pages([graphqlPullRequest(1), graphqlPullRequest(2)], [graphqlPullRequest(3)]),
      );

      await expect(sut.getOpenPullRequests()).resolves.toEqual([event(1), event(2), event(3)]);

      expect(githubMock.getPullRequests).toHaveBeenCalledExactlyOnceWith(
        { org: 'immich-app', repo: 'immich' },
        { states: ['OPEN'] },
      );
    });

    it('should carry the node ID as node_id, the key the pull_request table is looked up by, next to the numeric id', async () => {
      githubMock.getPullRequests.mockReturnValue(pages([graphqlPullRequest(1234)]));

      const [{ pull_request }] = await sut.getOpenPullRequests();

      expect(pull_request.node_id).toBe('PR_node_1234');
      expect(pull_request.id).toBe(2234);
      expect(pull_request).not.toHaveProperty('state');
      expect(pull_request).not.toHaveProperty('url');
    });

    it('should carry who opened it, so that the handlers can skip a bot', async () => {
      githubMock.getPullRequests.mockReturnValue(pages([graphqlPullRequest(1, { author: { __typename: 'Bot' } })]));

      await expect(sut.getOpenPullRequests()).resolves.toEqual([event(1, 'Bot')]);
    });

    it('should resolve to nothing when there is no open pull request', async () => {
      githubMock.getPullRequests.mockReturnValue(pages([]));

      await expect(sut.getOpenPullRequests()).resolves.toEqual([]);
    });
  });

  describe('getOpenPullRequest', () => {
    it('should fetch that one pull request directly and shape it the same way', async () => {
      githubMock.getPullRequest.mockResolvedValue(graphqlPullRequest(1234));

      await expect(sut.getOpenPullRequest(1234)).resolves.toEqual(event(1234));

      expect(githubMock.getPullRequest).toHaveBeenCalledExactlyOnceWith({
        org: 'immich-app',
        repo: 'immich',
        number: 1234,
      });
      expect(githubMock.getPullRequests).not.toHaveBeenCalled();
    });

    it.each(['CLOSED', 'MERGED'] as const)('should resolve to nothing for a %s pull request', async (state) => {
      githubMock.getPullRequest.mockResolvedValue(graphqlPullRequest(1234, { state }));

      await expect(sut.getOpenPullRequest(1234)).resolves.toBeUndefined();
    });

    it('should resolve to nothing when there is no pull request by that number', async () => {
      githubMock.getPullRequest.mockResolvedValue(undefined);

      await expect(sut.getOpenPullRequest(999_999)).resolves.toBeUndefined();
    });
  });
});
