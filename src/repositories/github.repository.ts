import { Logger } from '@nestjs/common';
// @ts-expect-error we have the experimental flag enabled so we can import esm packages
import { GraphqlResponseError } from '@octokit/graphql';
// @ts-expect-error we have the experimental flag enabled so we can import esm packages
import { App, Octokit } from 'octokit';
import { IGithubInterface } from 'src/interfaces/github.interface';

const makeLink = (org: string, repo: string, id: number, url: string) => `[${org}/${repo}#${id}](${url})`;

const handleGraphqlError = (error: unknown) => {
  if (!(error instanceof GraphqlResponseError)) {
    throw error;
  }

  if (error.errors?.[0].type !== 'NOT_FOUND') {
    throw error;
  }
};

export class GithubRepository implements IGithubInterface {
  private logger = new Logger(GithubRepository.name);
  private octokit: Octokit = new Octokit();

  async init(appId: string, privateKey: string, installationId: string) {
    const app = new App({ appId, privateKey });
    this.octokit = await app.getInstallationOctokit(Number(installationId));
  }

  async getIssueOrPr(org: string, repo: string, id: number) {
    try {
      const { repository } = await this.octokit.graphql<{
        repository: { issueOrPullRequest: { __typename: 'PullRequest' | 'Issue'; title: string; url: string } };
      }>(
        `
      query issueOrPr($org: String!, $repo: String!, $num: Int!) {
        repository(owner: $org, name: $repo) {
          issueOrPullRequest(number: $num) {
            __typename
            ...on Issue {
              title
              url
            }
            ...on PullRequest {
              title
              url
            }
          }
        }
      }
        `,
        { org, repo, num: id },
      );
      return `[${repository.issueOrPullRequest.__typename === 'Issue' ? 'Issue' : 'Pull Request'}] ${repository.issueOrPullRequest.title} (${makeLink(org, repo, id, repository.issueOrPullRequest.url)})`;
    } catch (error) {
      handleGraphqlError(error);
      this.logger.log(`Could not fetch issue or PR #${id}`);
    }
  }

  async getDiscussion(org: string, repo: string, id: number) {
    try {
      const { repository } = await this.octokit.graphql<{ repository: { discussion: { title: string; url: string } } }>(
        `
      query discussion($org: String!, $repo: String!, $num: Int!) {
        repository(owner: $org, name: $repo) {
          discussion(number: $num) {
            title
            url
          }
        }
      }
      `,
        { org, repo, num: id },
      );

      return `[Discussion] ${repository.discussion.title} (${makeLink(org, repo, id, repository.discussion.url)})`;
    } catch (error) {
      handleGraphqlError(error);
      this.logger.log(`Could not fetch discussion #${id}`);
    }
  }

  async getStarCount(org: string, repo: string) {
    const { repository } = await this.octokit.graphql<{ repository: { stargazerCount: number } }>(
      `
      query stars($org: String!, $repo: String!) {
        repository(owner: $org, name: $repo) {
          stargazerCount
        }
      }
      `,
      { org, repo },
    );
    return repository.stargazerCount;
  }

  async getForkCount(org: string, repo: string) {
    const { repository } = await this.octokit.graphql<{ repository: { forkCount: number } }>(
      `
      query stars($org: String!, $repo: String!) {
        repository(owner: $org, name: $repo) {
          forkCount
        }
      }
      `,
      { org, repo },
    );
    return repository.forkCount;
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
    return this.octokit.rest.search
      .issuesAndPullRequests({ q: query, per_page, page, sort, order })
      .then((response) => response.data) as any;
  }

  async getRepositoryFileContent(org: string, repo: string, ref: string, path: string) {
    const { repository } = await this.octokit.graphql<{ repository: { object: { text: string | undefined } } }>(
      `
      query getFile($org: String!, $repo: String!, $expression: String!) {
        repository(owner: $org, name: $repo) {
          object(expression: $expression) {
            ... on Blob {
              text
            }
          }
        }
      }
      `,
      {
        org,
        repo,
        expression: `${ref}:${path}`,
      },
    );

    return repository.object?.text?.split('\n');
  }

  async getCheckSuiteTriggerCommit(org: string, repo: string, checkSuiteNodeId: string) {
    const { node } = await this.octokit.graphql<{ node: { commit: { oid: string } } }>(
      `
      query getCheckSuite($checkSuiteNodeId: ID!) {
        node(id: $checkSuiteNodeId) {
          ... on CheckSuite {
            commit {
              oid
            }
          }
        }
      }
      `,
      {
        checkSuiteNodeId,
      },
    );
    return node.commit.oid;
  }

  async getLatestReleaseTag(org: string, repo: string) {
    const { repository } = await this.octokit.graphql<{
      repository: {
        latestRelease: {
          tagCommit: {
            oid: string;
          };
        };
      };
    }>(
      `
      query getLatestRelease($org: String!, $repo: String!) {
        repository(owner: $org, name: $repo) {
          latestRelease {
            tagCommit {
              oid
            }
          }
        }
      }
      `,
      { org, repo },
    );
    return repository.latestRelease.tagCommit.oid;
  }
}
