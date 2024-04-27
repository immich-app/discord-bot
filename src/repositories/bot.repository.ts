import { Octokit } from '@octokit/rest';
import { IMMICH_REPOSITORY_BASE_OPTIONS, Constants } from '../constants.js';
import { RequestError } from '@octokit/request-error';

const octokit = new Octokit();
export class BotRepository {
  async getIssueOrPr(id: string) {
    try {
      const response = await octokit.rest.issues.get({
        ...IMMICH_REPOSITORY_BASE_OPTIONS,
        issue_number: Number(id),
      });

      const type = response.data.pull_request ? 'Pull Request' : 'Issue';
      return `[${type}] ${response.data.title} ([#${id}](${response.data.html_url}))`;
    } catch (error) {
      if (error instanceof RequestError && error.status !== 404) {
        console.log(`Could not fetch #${id}`);
      }
    }
  }

  async getDiscussion(id: string) {
    try {
      const { status } = await fetch(`${Constants.Urls.Discussions}/${id}}`);

      if (status === 200) {
        return `[Discussion] ([#${id}](${Constants.Urls.Discussions}/${id}))`;
      }
    } catch (error) {
      console.log(`Could not fetch #${id}`);
    }
  }

  async getStarCount() {
    return octokit.rest.repos.get(IMMICH_REPOSITORY_BASE_OPTIONS).then((repo) => repo.data.stargazers_count);
  }

  async getForkCount() {
    return octokit.rest.repos.get(IMMICH_REPOSITORY_BASE_OPTIONS).then((repo) => repo.data.forks_count);
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
      .then((response) => response.data);
  }
}
