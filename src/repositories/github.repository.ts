import { Logger } from '@nestjs/common';
import { RequestError } from '@octokit/request-error';
import { Octokit } from '@octokit/rest';
import { IGithubInterface } from 'src/interfaces/github.interface';

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
