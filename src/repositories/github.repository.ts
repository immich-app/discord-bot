import { Logger } from '@nestjs/common';
import { graphql } from '@octokit/graphql';
import { RequestError } from '@octokit/request-error';
import { Octokit } from '@octokit/rest';
import { GithubOrg } from 'src/constants';
import { GithubIssue, GithubPullRequest, GithubStarGazer, IGithubInterface } from 'src/interfaces/github.interface';

type PageInfo = { endCursor: string; hasNextPage: boolean };
type Paginated<T> = T & { pageInfo: PageInfo };

const octokit = new Octokit();

const makeLink = (org: string, repo: string, id: number, url: string) => `[${org}/${repo}#${id}](${url})`;

export class GithubRepository implements IGithubInterface {
  private logger = new Logger(GithubRepository.name);

  async getIssueOrPr(org: string, repo: string, id: number) {
    try {
      const response = await octokit.rest.issues.get({ owner: org, repo, issue_number: id });
      const type = response.data.pull_request ? 'Pull Request' : 'Issue';
      return `[${type}] ${response.data.title} (${makeLink(org, repo, id, response.data.html_url)})`;
    } catch (error) {
      if (error instanceof RequestError && error.status !== 404) {
        this.logger.log(`Could not fetch #${id}`);
      }
    }
  }

  async getDiscussion(org: string, repo: string, id: number) {
    const url = `https://github.com/${org}/${repo}/discussions/${id}`;
    try {
      const { status } = await fetch(url);

      if (status === 200) {
        return `[Discussion] (${makeLink(org, repo, id, url)})`;
      }
    } catch {
      this.logger.log(`Could not fetch #${id}`);
    }
  }

  async getStarCount(org: string, repo: string) {
    return octokit.rest.repos.get({ owner: org, repo }).then((repo) => repo.data.stargazers_count);
  }

  async getForkCount(org: string, repo: string) {
    return octokit.rest.repos.get({ owner: org, repo }).then((repo) => repo.data.forks_count);
  }

  async search({
    query,
    per_page,
    page,
    sort,
    order,
  }: {
    query: string;
    per_page?: number;
    page?: number;
    sort?: 'updated';
    order?: 'desc' | 'asc';
  }) {
    return octokit.rest.search
      .issuesAndPullRequests({ q: query, per_page, page, sort, order })
      .then((response) => response.data) as any;
  }

  async getStargazers(org: GithubOrg | string, repo: GithubRepository | string) {
    const results: GithubStarGazer[] = [];
    let cursor: string | undefined;

    this.logger.log(`Fetching stargazers for ${org}/${repo}`);

    do {
      const { repository } = await graphql<{
        repository: {
          stargazers: Paginated<{ edges: GithubStarGazer[] }>;
        };
      }>(
        `
          query ($org: String!, $repo: String!, $take: Int!, $cursor: String) {
            repository(owner: $org, name: $repo) {
              stargazers(first: $take, after: $cursor, orderBy: { field: STARRED_AT, direction: ASC }) {
                edges {
                  starredAt
                }
                pageInfo {
                  endCursor
                  hasNextPage
                }
              }
            }
          }
        `,
        {
          org,
          repo,
          take: 100,
          cursor,
          headers: {
            authorization: `token ${process.env.GITHUB_PAT}`,
          },
        },
      );

      results.push(...repository.stargazers.edges);
      if (results.length % 1000 === 0) {
        this.logger.log(`Progress: ${results.length.toLocaleString()} stargazers`);
      }

      const { hasNextPage, endCursor } = repository.stargazers.pageInfo;
      cursor = hasNextPage ? endCursor : undefined;
    } while (cursor);

    return results;
  }

  async getIssues(org: GithubOrg | string, repo: GithubRepository | string) {
    const results: GithubIssue[] = [];
    let cursor: string | undefined;

    this.logger.log(`Fetching issues for ${org}/${repo}`);

    do {
      const { repository } = await graphql<{ repository: { issues: Paginated<{ nodes: GithubIssue[] }> } }>(
        `
          query ($org: String!, $repo: String!, $take: Int!, $cursor: String) {
            repository(owner: $org, name: $repo) {
              issues(first: $take, after: $cursor) {
                pageInfo {
                  endCursor
                  hasNextPage
                }
                nodes {
                  createdAt
                  closedAt
                  number
                  stateReason
                }
              }
            }
          }
        `,
        {
          org,
          repo,
          take: 100,
          cursor,
          headers: {
            authorization: `token ${process.env.GITHUB_PAT}`,
          },
        },
      );

      results.push(...repository.issues.nodes);
      if (results.length % 1000 === 0) {
        this.logger.log(`Progress: ${results.length.toLocaleString()} issues`);
      }

      const { hasNextPage, endCursor } = repository.issues.pageInfo;
      cursor = hasNextPage ? endCursor : undefined;
    } while (cursor);

    return results;
  }

  async getPullRequests(org: GithubOrg | string, repo: GithubRepository | string) {
    const results: GithubPullRequest[] = [];
    let cursor: string | undefined;

    this.logger.log(`Fetching pull requests for ${org}/${repo}`);

    do {
      const { repository } = await graphql<{ repository: { pullRequests: Paginated<{ nodes: GithubPullRequest[] }> } }>(
        `
          query ($org: String!, $repo: String!, $take: Int!, $cursor: String) {
            repository(owner: $org, name: $repo) {
              pullRequests(first: $take, after: $cursor) {
                pageInfo {
                  endCursor
                  hasNextPage
                }
                nodes {
                  createdAt
                  closedAt
                  number
                  additions
                  deletions
                  state
                }
              }
            }
          }
        `,
        {
          org,
          repo,
          take: 100,
          cursor,
          headers: {
            authorization: `token ${process.env.GITHUB_PAT}`,
          },
        },
      );

      results.push(...repository.pullRequests.nodes);
      if (results.length % 1000 === 0) {
        this.logger.log(`Progress: ${results.length.toLocaleString()} pull requests`);
      }

      const { hasNextPage, endCursor } = repository.pullRequests.pageInfo;
      cursor = hasNextPage ? endCursor : undefined;
    } while (cursor);

    return results;
  }
}
