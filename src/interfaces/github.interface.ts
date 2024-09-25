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

export type GithubStarGazer = { starredAt: string };
export type GithubIssue = {
  createdAt: string;
  closedAt?: string;
  number: number;
  stateReason: 'COMPLETED' | 'NOT_PLANNED' | 'REOPENED';
};
export type GithubPullRequest = {
  createdAt: string;
  closedAt?: string;
  number: number;
  additions: number;
  deletions: number;
  state: 'CLOSED' | 'MERGED' | 'OPEN';
};

export interface IGithubInterface {
  getIssueOrPr(org: GithubOrg | string, repo: GithubRepo | string, id: number): Promise<string | undefined>;
  getDiscussion(org: GithubOrg | string, repo: GithubRepo | string, id: number): Promise<string | undefined>;
  getForkCount(org: GithubOrg | string, repo: GithubRepo | string): Promise<number>;
  getStarCount(org: GithubOrg | string, repo: GithubRepo | string): Promise<number>;
  getStargazers(org: GithubOrg | string, repo: GithubRepo | string): Promise<GithubStarGazer[]>;
  getIssues(org: GithubOrg | string, repo: GithubRepo | string): Promise<GithubIssue[]>;
  getPullRequests(org: GithubOrg | string, repo: GithubRepo | string): Promise<GithubPullRequest[]>;
  search(options: SearchOptions): Promise<SearchResult>;
}
