import { GithubRepository } from './repositories/github.repository.js';

export async function handleSearchAutocompletion(repository: GithubRepository, value: string) {
  if (!value) {
    return [];
  }

  try {
    const result = await repository.search({
      query: `repo:immich-app/immich in:title ${value}`,
      per_page: 5,
      page: 1,
      sort: 'updated',
      order: 'desc',
    });

    return result.items.map((item) => {
      const name = `${item.pull_request ? '[PR]' : '[Issue]'} (${item.number}) ${item.title}`;
      return {
        name: name.length > 100 ? name.substring(0, 97) + '...' : name,
        value: String(item.number),
      };
    });
  } catch (error) {
    console.log('Could not fetch search results from GitHub');
    return [];
  }
}

const _star_history: Record<string, number | undefined> = {};

export async function getStarsMessage(repository: GithubRepository, channelId: string) {
  const lastStarsCount = _star_history[channelId];

  try {
    const starsCount = await repository.getStarCount();
    const delta = lastStarsCount && starsCount - lastStarsCount;
    const formattedDelta = delta && Intl.NumberFormat(undefined, { signDisplay: 'always' }).format(delta);

    _star_history[channelId] = starsCount;
    return `Stars ⭐: ${starsCount}${
      formattedDelta ? ` (${formattedDelta} stars since the last call in this channel)` : ''
    }`;
  } catch (error) {
    return 'Could not fetch stars count from the GitHub API';
  }
}

const _fork_history: Record<string, number | undefined> = {};

export async function getForksMessage(repository: GithubRepository, channelId: string) {
  const lastForksCount = _fork_history[channelId];

  try {
    const forksCount = await repository.getForkCount();
    const delta = lastForksCount && forksCount - lastForksCount;
    const formattedDelta = delta && Intl.NumberFormat(undefined, { signDisplay: 'always' }).format(delta);

    _fork_history[channelId] = forksCount;

    return `Forks: ${forksCount}${formattedDelta ? ` (${formattedDelta} forks since the last call in this channel)` : ''}`;
  } catch (error) {
    return 'Could not fetch forks count from the GitHub API';
  }
}

export async function handleGithubReferences(repository: GithubRepository, content: string) {
  content = content.replaceAll(/```.*```/gs, '');
  const matches = content.matchAll(/(^|\W)#(?<id>[0-9]+)/g);
  const ids = new Set<string>();
  for (const match of matches) {
    const id = match?.groups?.id;
    if (!id) {
      continue;
    }

    ids.add(id);
  }

  const filteredIds = ids.size > 1 ? [...ids].filter((id) => Number(id) > 500 && Number(id) < 15000) : [...ids];
  const links = await Promise.all(
    filteredIds.map(async (id) => (await repository.getIssueOrPr(id)) || (await repository.getDiscussion(id))),
  );

  return links.filter((link): link is string => link !== undefined);
}
