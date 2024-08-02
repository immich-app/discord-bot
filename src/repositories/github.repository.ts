import { Logger } from '@nestjs/common';
import { RequestError } from '@octokit/request-error';
import { Octokit } from '@octokit/rest';
import { Constants } from 'src/constants';
import { IGithubInterface } from 'src/interfaces/github.interface';

const octokit = new Octokit();

export class GithubRepository implements IGithubInterface {
  private logger = new Logger(GithubRepository.name);

  async getIssueOrPr(org: string, repo: string, id: string) {
    try {
      const response = await octokit.rest.issues.get({
        owner: org,
        repo,
        issue_number: Number(id),
      });

      const type = response.data.pull_request ? 'Pull Request' : 'Issue';
      return `[${type}] ${response.data.title} ([#${id}](${response.data.html_url}))`;
    } catch (error) {
      if (error instanceof RequestError && error.status !== 404) {
        this.logger.log(`Could not fetch #${id}`);
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
}
