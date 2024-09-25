import { Inject, Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';
import { readFile, writeFile } from 'node:fs/promises';
import { GithubOrg, GithubRepo } from 'src/constants';
import { GithubIssue, GithubPullRequest, GithubStarGazer, IGithubInterface } from 'src/interfaces/github.interface';

const compare = (a: DateTime, b: DateTime) => {
  if (a.toMillis() === b.toMillis()) {
    return 0;
  }

  return a < b ? -1 : 1;
};

@Injectable()
export class MetricsService {
  private logger = new Logger(MetricsService.name);

  constructor(@Inject(IGithubInterface) private githubRepository: IGithubInterface) {}

  async runStars() {
    // const stargazers = await this.githubRepository.getStargazers(GithubOrg.ImmichApp, GithubRepo.Immich);
    // await writeFile('./export-stargazers.json', JSON.stringify(stargazers));
    const data = await readFile('./export-stargazers.json');
    const stargazers: GithubStarGazer[] = JSON.parse(data.toString());

    this.logger.log(`Loaded ${stargazers.length} stargazers`);

    const days: Record<string, { timestamp: number; delta: number; total: number }> = {};
    const items = stargazers
      .map(({ starredAt }) => ({ starredAt: DateTime.fromISO(starredAt) }))
      .toSorted((a, b) => compare(a.starredAt, b.starredAt));

    let total = 0;

    for (const { starredAt } of items) {
      const key = starredAt.toFormat('yyyy-LL-dd');
      if (!days[key]) {
        days[key] = {
          timestamp: starredAt.startOf('day').toUnixInteger(),
          delta: 0,
          total,
        };
      }

      days[key].delta++;
      days[key].total = ++total;
    }

    return Object.values(days).map(({ timestamp, total }) => [timestamp, total]);
  }

  async runIssues() {
    // const issues = await this.githubRepository.getIssues(GithubOrg.ImmichApp, GithubRepo.Immich);
    // await writeFile('./export-issues.json', JSON.stringify(issues));
    const data = await readFile('./export-issues.json');
    const issues: GithubIssue[] = JSON.parse(data.toString());
    this.logger.log(`Loaded ${issues.length} issues`);
    const days: Record<string, { timestamp: number; closed: number; open: number }> = {};

    const increment = (date: DateTime, type: 'open' | 'closed') => {
      const key = date.toFormat('yyyy-LL-dd');
      if (!days[key]) {
        days[key] = {
          timestamp: date.startOf('day').toUnixInteger(),
          open: 0,
          closed: 0,
        };
      }

      days[key][type]++;
    };

    for (const { createdAt, closedAt } of issues) {
      increment(DateTime.fromISO(createdAt), 'open');
      if (closedAt) {
        increment(DateTime.fromISO(closedAt), 'closed');
      }
    }

    let open = 0;
    let closed = 0;

    return [
      ['timestamp', 'opened', 'closed', 'total'],
      ...Object.keys(days)
        .toSorted()
        .map((key) => {
          const { timestamp, open: dailyOpen, closed: dailyClosed } = days[key];
          open += dailyOpen;
          closed += dailyClosed;

          // return { ...item, totalOpened: opened, totalClosed: closed, total: opened - closed };
          return [timestamp, open, closed, open - closed];
        }),
    ];
  }

  async runPullRequests() {
    // const pullRequests = await this.githubRepository.getPullRequests(GithubOrg.ImmichApp, GithubRepo.Immich);
    // await writeFile('./export-pullRequests.json', JSON.stringify(pullRequests));
    const data = await readFile('./export-pullRequests.json');
    const pullRequests: GithubPullRequest[] = JSON.parse(data.toString());
    this.logger.log(`Loaded ${pullRequests.length} pull requests`);
    const days: Record<string, { timestamp: number; closed: number; open: number }> = {};

    const increment = (date: DateTime, type: 'open' | 'closed') => {
      const key = date.toFormat('yyyy-LL-dd');
      if (!days[key]) {
        days[key] = {
          timestamp: date.startOf('day').toUnixInteger(),
          open: 0,
          closed: 0,
        };
      }

      days[key][type]++;
    };

    for (const { createdAt, closedAt } of pullRequests) {
      increment(DateTime.fromISO(createdAt), 'open');
      if (closedAt) {
        increment(DateTime.fromISO(closedAt), 'closed');
      }
    }

    let open = 0;
    let closed = 0;

    return [
      ['timestamp', 'opened', 'closed', 'total'],
      ...Object.keys(days)
        .toSorted()
        .map((key) => {
          const { timestamp, open: dailyOpen, closed: dailyClosed } = days[key];
          open += dailyOpen;
          closed += dailyClosed;

          // return { ...item, totalOpened: opened, totalClosed: closed, total: opened - closed };
          return [timestamp, open, closed, open - closed];
        }),
    ];
  }
}
