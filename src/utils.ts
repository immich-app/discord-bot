import { RequestError } from '@octokit/request-error';
import { Constants, IMMICH_REPOSITORY_BASE_OPTIONS } from './constants.js';
import type { Octokit } from '@octokit/rest';

export async function getIssueOrPr(octokit: Octokit, id: string) {
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

export async function getDiscussion(id: string) {
  try {
    const { status } = await fetch(`${Constants.Urls.Discussions}/${id}}`);

    if (status === 200) {
      return `[Discussion] ([#${id}](${Constants.Urls.Discussions}/${id}))`;
    }
  } catch (error) {
    console.log(`Could not fetch #${id}`);
  }
}
