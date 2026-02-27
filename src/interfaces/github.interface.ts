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

export interface IGithubInterface {
  init(appId: string, privateKey: string, installationId: string): Promise<void>;
  getIssueOrPr(org: GithubOrg | string, repo: GithubRepo | string, id: number): Promise<string | undefined>;
  getDiscussion(org: GithubOrg | string, repo: GithubRepo | string, id: number): Promise<string | undefined>;
  getForkCount(org: GithubOrg | string, repo: GithubRepo | string): Promise<number>;
  getStarCount(org: GithubOrg | string, repo: GithubRepo | string): Promise<number>;
  search(options: SearchOptions): Promise<SearchResult>;
  getRepositoryFileContent(
    org: GithubOrg | string,
    repo: GithubRepo | string,
    ref: string,
    path: string,
  ): Promise<string[] | undefined>;
  getCheckSuiteTriggerCommit(
    org: GithubOrg | string,
    repo: GithubRepo | string,
    checkSuiteNodeId: string,
  ): Promise<string>;
  getLatestReleaseTag(org: GithubOrg | string, repo: GithubRepo | string): Promise<string>;
  isCollaborator(dto: { org: string; repo: string; userLogin: string }): Promise<boolean>;
}
