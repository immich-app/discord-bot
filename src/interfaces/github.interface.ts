import { GithubOrg, GithubRepo } from 'src/constants';

export const IGithubInterface = 'IGithubRepository';

export interface SearchOptions {
  query: string;
  per_page?: number;
  page: number;
  sort: 'updated';
  order: 'desc' | 'asc';
}

export interface SearchResult {
  total_count: number;
  incomplete_results: boolean;
  items: Array<{
    number: number;
    title: string;
    pull_request: boolean;
  }>;
}

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';

export type PullRequest = {
  id: string;
  fullDatabaseId: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: PullRequestState;
  repository: { nameWithOwner: string };
  author: { __typename: 'Bot' | 'User' | 'Organization' };
};

export type PullRequestBaseEvent = {
  repository: { full_name: string };
  sender: { type: 'Bot' | 'User' | 'Organization' };
  pull_request: {
    number: number;
    id: number;
    node_id: string;
    title: string;
    body: string;
    html_url: string;
  };
};

export interface IGithubInterface {
  init(appId: string, privateKey: string, installationId: string): Promise<void>;
  getIssueOrPrMessage(
    org: GithubOrg | string,
    repo: GithubRepo | string,
    num: number,
    discordThreadId: string | undefined,
    isPrivileged: boolean,
  ): Promise<string | undefined>;
  getDiscussionMessage(
    org: GithubOrg | string,
    repo: GithubRepo | string,
    id: number,
    isPrivileged: boolean,
  ): Promise<string | undefined>;
  getForkCount(org: GithubOrg | string, repo: GithubRepo | string): Promise<number>;
  getStarCount(org: GithubOrg | string, repo: GithubRepo | string): Promise<number>;
  search(options: SearchOptions): Promise<SearchResult>;
  getRepositoryFileContent(
    org: GithubOrg | string,
    repo: GithubRepo | string,
    ref: string,
    path: string,
    isPrivileged: boolean,
  ): Promise<string[] | undefined>;
  getCheckSuiteTriggerCommit(
    org: GithubOrg | string,
    repo: GithubRepo | string,
    checkSuiteNodeId: string,
  ): Promise<string>;
  /** The commit the latest release is tagged on, `undefined` for a repository without a release. */
  getLatestReleaseTag(org: GithubOrg | string, repo: GithubRepo | string): Promise<string | undefined>;
  isCollaborator(dto: { org: string; repo: string; userLogin: string }): Promise<boolean>;
  getPullRequests(
    { org, repo }: { org: string; repo: string },
    { states }: { states?: PullRequestState[] },
  ): AsyncGenerator<PullRequest[]>;
  getPullRequest({
    org,
    repo,
    number,
  }: {
    org: string;
    repo: string;
    number: number;
  }): Promise<PullRequest | undefined>;
  /** `owner/name` as GitHub spells it, `undefined` when GitHub knows no such repository or the app cannot see it. */
  getRepositoryName({ org, repo }: { org: string; repo: string }): Promise<string | undefined>;
  /**
   * Whether the repository's visibility is public; `false` when GitHub knows no such repository or the app cannot see
   * it. Throws when GitHub cannot be read.
   */
  isRepositoryPublic({ org, repo }: { org: string; repo: string }): Promise<boolean>;
  /** Every repository of a user or organization, `owner/name`; `undefined` when GitHub knows no such owner. */
  getOwnerRepositories(owner: string): Promise<{ owner: string; repositories: string[] } | undefined>;
}
