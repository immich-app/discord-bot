import { Inject, Injectable } from '@nestjs/common';
import { getConfig } from 'src/config';
import { IGithubInterface, PullRequest, PullRequestBaseEvent } from 'src/interfaces/github.interface';

const IMMICH = { org: 'immich-app', repo: 'immich' };

/** `node_id` must be the GraphQL node ID (`id`), the `pull_request` table's key; `id` is the numeric database ID a webhook carries. */
const toPullRequestEvent = ({
  repository,
  author,
  id,
  fullDatabaseId,
  number,
  title,
  body,
  url,
}: PullRequest): PullRequestBaseEvent => ({
  pull_request: {
    number,
    id: Number(fullDatabaseId),
    node_id: id,
    title,
    body,
    html_url: url,
  },
  repository: { full_name: repository.nameWithOwner },
  sender: { type: author.__typename },
});

@Injectable()
export class GithubService {
  constructor(@Inject(IGithubInterface) private repository: IGithubInterface) {}

  async init() {
    const { github } = getConfig();
    if (github.appId !== 'dev') {
      await this.repository.init(github.appId, github.privateKey, github.installationId);
    }
  }

  async getOpenPullRequests() {
    const pullRequests: PullRequestBaseEvent[] = [];

    for await (const batch of this.repository.getPullRequests(IMMICH, { states: ['OPEN'] })) {
      pullRequests.push(...batch.map((pullRequest) => toPullRequestEvent(pullRequest)));
    }

    return pullRequests;
  }

  async getOpenPullRequest(number: number) {
    const pullRequest = await this.repository.getPullRequest({ ...IMMICH, number });
    return pullRequest?.state === 'OPEN' ? toPullRequestEvent(pullRequest) : undefined;
  }
}
