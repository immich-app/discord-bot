import { Logger } from '@nestjs/common';
import { GraphqlResponseError } from '@octokit/graphql';
import { App, Octokit } from 'octokit';
import { Constants } from 'src/constants';
import { IGithubInterface, PullRequest, PullRequestState } from 'src/interfaces/github.interface';
import { makeIssueOrPRMessage, makeLink } from 'src/util';

const handleGraphqlError = (error: unknown) => {
  if (!(error instanceof GraphqlResponseError)) {
    throw error;
  }

  if (error.errors?.[0].type !== 'NOT_FOUND') {
    throw error;
  }
};

/** At 100 repositories a page, an owner with more than this many pages is read only that far. */
const MAX_OWNER_PAGES = 20;

/** How old the list of the app's installations may be before it is read again. */
const INSTALLATIONS_MAX_AGE_MS = 10 * 60 * 1000;

type OwnerRepositoriesPage = {
  repositoryOwner: {
    login: string;
    repositories: {
      nodes: { nameWithOwner: string }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
};

const PULL_REQUEST_FIELDS = `
  repository {
    nameWithOwner
  }
  id
  fullDatabaseId
  number
  title
  body
  url
  state
  author {
    __typename
  }
`;

export class GithubRepository implements IGithubInterface {
  private logger = new Logger(GithubRepository.name);
  private octokit: Octokit = new Octokit();
  private app?: App;
  /** The app's installation IDs by lowercased owner login. */
  private installations?: { ids: Promise<Map<string, number>>; readAt: number };
  private lastListed?: Map<string, number>;
  private ignoredInstallations = new Set<number>();
  private installationOctokits = new Map<number, Promise<Octokit>>();

  async init(appId: string, privateKey: string, installationId: string) {
    this.app = new App({ appId, privateKey });
    this.octokit = await this.app.getInstallationOctokit(Number(installationId));
    this.installations = undefined;
    this.lastListed = undefined;
    this.installationOctokits = new Map([[Number(installationId), Promise.resolve(this.octokit)]]);
  }

  /**
   * The app's installation on the owner, which reads its private repositories too; the configured installation for an
   * owner the app is not installed on, which reads public ones.
   */
  private async forOwner(owner: string) {
    const id = this.app && (await this.getInstallationId(owner));
    if (!this.app || id === undefined) {
      return this.octokit;
    }

    let octokit = this.installationOctokits.get(id);
    if (!octokit) {
      octokit = this.app.getInstallationOctokit(id);
      this.installationOctokits.set(id, octokit);
      octokit.catch(() => this.installationOctokits.delete(id));
    }
    return octokit;
  }

  /** The list is read again once it is old, so a new or reinstalled installation needs no restart. */
  private async getInstallationId(owner: string) {
    if (!this.installations || Date.now() - this.installations.readAt >= INSTALLATIONS_MAX_AGE_MS) {
      this.installations = this.readInstallations();
    }
    return (await this.installations.ids).get(owner.toLowerCase());
  }

  /** A failed read keeps the last list, which the configured installation stands in for until one is read. */
  private readInstallations() {
    const ids = this.app!.octokit.paginate('GET /app/installations', { per_page: 100 }).then(
      (installations) => {
        const listed = new Map<string, number>();
        const ignored = new Set<number>();
        for (const { id, account } of installations) {
          // A user or organization has a login, an enterprise a slug alone, whatever the generated types say.
          const { login, slug } = (account ?? {}) as { login?: string; slug?: string };
          const owner = login?.toLowerCase();
          if (owner !== undefined && Constants.Github.InstallationOwners.has(owner)) {
            listed.set(owner, id);
            continue;
          }

          ignored.add(id);
          if (!this.ignoredInstallations.has(id)) {
            this.logger.warn(
              `Ignoring the GitHub App's installation ${id} on ${login ?? slug ?? 'an unknown account'}, which is not one of Constants.Github.InstallationOwners`,
            );
          }
        }
        this.ignoredInstallations = ignored;
        this.lastListed = listed;
        return listed;
      },
      (error: unknown) => {
        const fallback = this.lastListed ? 'the last list stays' : 'the configured one reads every owner';
        this.logger.warn(`Could not list the GitHub App's installations, so ${fallback}: ${error}`);
        return this.lastListed ?? new Map<string, number>();
      },
    );
    return { ids, readAt: Date.now() };
  }

  private async graphql<T>(owner: string, query: string, variables: Record<string, unknown>) {
    return (await this.forOwner(owner)).graphql<T>(query, variables);
  }

  async getIssueOrPrMessage(
    org: string,
    repo: string,
    num: number,
    discordThreadId: string | undefined,
    isPrivileged: boolean,
  ) {
    try {
      const { repository } = await this.graphql<{
        repository: {
          isPrivate: boolean;
          issueOrPullRequest: { __typename: 'PullRequest' | 'Issue'; title: string; url: string };
        };
      }>(
        org,
        `
      query issueOrPr($org: String!, $repo: String!, $num: Int!) {
        repository(owner: $org, name: $repo) {
          isPrivate
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
        { org, repo, num },
      );

      if (repository.isPrivate && !isPrivileged) {
        return;
      }

      return makeIssueOrPRMessage({
        link: makeLink(org, repo, num, repository.issueOrPullRequest.url),
        type: repository.issueOrPullRequest.__typename,
        title: repository.issueOrPullRequest.title,
        discordThreadId,
      });
    } catch (error) {
      handleGraphqlError(error);
      this.logger.log(`Could not fetch issue or PR #${num}`);
    }
  }

  async getDiscussionMessage(org: string, repo: string, id: number, isPrivileged: boolean) {
    try {
      const { repository } = await this.graphql<{
        repository: { isPrivate: boolean; discussion: { title: string; url: string } };
      }>(
        org,
        `
      query discussion($org: String!, $repo: String!, $num: Int!) {
        repository(owner: $org, name: $repo) {
          isPrivate
          discussion(number: $num) {
            title
            url
          }
        }
      }
      `,
        { org, repo, num: id },
      );

      if (repository.isPrivate && !isPrivileged) {
        return;
      }

      return `[Discussion] ${repository.discussion.title} (${makeLink(org, repo, id, repository.discussion.url)})`;
    } catch (error) {
      handleGraphqlError(error);
      this.logger.log(`Could not fetch discussion #${id}`);
    }
  }

  async getStarCount(org: string, repo: string) {
    const { repository } = await this.graphql<{ repository: { stargazerCount: number } }>(
      org,
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
    const { repository } = await this.graphql<{ repository: { forkCount: number } }>(
      org,
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

  async getRepositoryFileContent(org: string, repo: string, ref: string, path: string, isPrivileged: boolean) {
    const { repository } = await this.graphql<{
      repository: { isPrivate: boolean; object: { text: string | undefined } };
    }>(
      org,
      `
      query getFile($org: String!, $repo: String!, $expression: String!) {
        repository(owner: $org, name: $repo) {
          isPrivate
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

    return isPrivileged || !repository.isPrivate ? repository.object?.text?.split('\n') : undefined;
  }

  async getCheckSuiteTriggerCommit(org: string, repo: string, checkSuiteNodeId: string) {
    const { node } = await this.graphql<{ node: { commit: { oid: string } } }>(
      org,
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
    const { repository } = await this.graphql<{
      repository: { latestRelease: { tagCommit: { oid: string } | null } | null };
    }>(
      org,
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
    const { latestRelease } = repository;
    if (latestRelease && !latestRelease.tagCommit) {
      this.logger.warn(`The latest release of ${org}/${repo} is tagged on no commit`);
    }
    return latestRelease?.tagCommit?.oid;
  }

  async isCollaborator({ org, repo, userLogin }: { org: string; repo: string; userLogin: string }) {
    const { repository } = await this.graphql<{ repository: { collaborators: { totalCount: number } } }>(
      org,
      `
      query isCollaborator($org: String!, $repo: String!, $userLogin: String!) {
        repository(owner: $org, name: $repo) {
          collaborators(login: $userLogin) {
            totalCount
          }
        }
      }
      `,
      { org, repo, userLogin },
    );

    return repository.collaborators.totalCount === 1;
  }

  async *getPullRequests(
    { org, repo }: { org: string; repo: string },
    { states = [] }: { states?: PullRequestState[] } = {},
  ) {
    let hasNextPage = true;
    let after: string = '';

    while (hasNextPage) {
      const {
        repository: {
          pullRequests: { nodes, pageInfo },
        },
      } = await this.graphql<{
        repository: {
          pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: PullRequest[] };
        };
      }>(
        org,
        `
      query getPullRequests($org: String!, $repo: String!, $states: [PullRequestState!], $after: String!) {
        repository(owner: $org, name: $repo) {
          pullRequests(first: 100, states: $states, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              ${PULL_REQUEST_FIELDS}
            }
          }
        }
      }
      `,
        { org, repo, states, after },
      );
      hasNextPage = pageInfo.hasNextPage;
      after = hasNextPage ? pageInfo.endCursor : '';

      yield nodes;
    }
  }

  async getPullRequest({ org, repo, number }: { org: string; repo: string; number: number }) {
    try {
      const { repository } = await this.graphql<{ repository: { pullRequest: PullRequest } }>(
        org,
        `
      query getPullRequest($org: String!, $repo: String!, $number: Int!) {
        repository(owner: $org, name: $repo) {
          pullRequest(number: $number) {
            ${PULL_REQUEST_FIELDS}
          }
        }
      }
      `,
        { org, repo, number },
      );
      return repository.pullRequest;
    } catch (error) {
      handleGraphqlError(error);
      this.logger.log(`Could not fetch pull request #${number}`);
    }
  }

  async getOwnerRepositories(owner: string) {
    const repositories: string[] = [];
    let login: string | undefined;
    let after: string | null = null;
    for (let page = 0; page < MAX_OWNER_PAGES; page++) {
      const { repositoryOwner }: OwnerRepositoriesPage = await this.graphql<OwnerRepositoriesPage>(
        owner,
        `
      query getOwnerRepositories($owner: String!, $after: String) {
        repositoryOwner(login: $owner) {
          login
          repositories(first: 100, after: $after, orderBy: { field: NAME, direction: ASC }) {
            nodes {
              nameWithOwner
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
      `,
        { owner, after },
      );
      if (!repositoryOwner) {
        return;
      }
      login = repositoryOwner.login;
      repositories.push(...repositoryOwner.repositories.nodes.map(({ nameWithOwner }) => nameWithOwner));
      if (!repositoryOwner.repositories.pageInfo.hasNextPage) {
        break;
      }
      after = repositoryOwner.repositories.pageInfo.endCursor;
    }
    return login === undefined ? undefined : { owner: login, repositories };
  }

  async isRepositoryPublic({ org, repo }: { org: string; repo: string }) {
    try {
      const { repository } = await this.graphql<{ repository: { visibility: string } | null }>(
        org,
        `
      query isRepositoryPublic($org: String!, $repo: String!) {
        repository(owner: $org, name: $repo) {
          visibility
        }
      }
      `,
        { org, repo },
      );
      return repository?.visibility === 'PUBLIC';
    } catch (error) {
      handleGraphqlError(error);
      return false;
    }
  }

  async getRepositoryName({ org, repo }: { org: string; repo: string }) {
    try {
      const { repository } = await this.graphql<{ repository: { nameWithOwner: string } }>(
        org,
        `
      query getRepositoryName($org: String!, $repo: String!) {
        repository(owner: $org, name: $repo) {
          nameWithOwner
        }
      }
      `,
        { org, repo },
      );
      return repository.nameWithOwner;
    } catch (error) {
      handleGraphqlError(error);
    }
  }
}
