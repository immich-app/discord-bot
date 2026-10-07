import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Constants } from 'src/constants';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { IGitlabInterface } from 'src/interfaces/gitlab.interface';

/** `repositories` holds repositories and patterns, `owner/*` or `gitlab.futo.org/namespace/*`. */
export type ExpanderGroup = { name: string; repositories: string[] };

/** What GitHub expansion resolves `#123` and `repo#123` against in one stream. */
export type ExpanderScope = {
  /** `owner/name`, every repository of the stream's groups, patterns expanded, in the order the groups were turned on. */
  repositories: string[];
};

/** A stream with no group: links and `owner/name#1234` expand, a bare `#1234` or `name#1234` goes nowhere. */
export const LINKS_ONLY: ExpanderScope = { repositories: [] };

/** Where groups are turned on: a stream by its ID, or a direct message conversation by `toConversationKey`. */
export type ExpanderPlace = number | string;

/** A direct message conversation's users, whatever order they come in, the bot's included. */
export const toConversationKey = (userIds: number[]) => [...new Set(userIds)].sort((a, b) => a - b).join(',');

const isStream = (place: ExpanderPlace): place is number => typeof place === 'number';

type Cache = {
  groups: Map<string, ExpanderGroup>;
  /** Group names, in the order they were turned on in the place. */
  places: Map<ExpanderPlace, string[]>;
};

export const sameRepository = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const GITLAB_PREFIX = `${Constants.Gitlab.Host}/`;

export const isGitlabRepository = (repository: string) => repository.toLowerCase().startsWith(GITLAB_PREFIX);

/** The project's path on GitLab, `namespace/project`. */
export const gitlabPath = (repository: string) => repository.slice(GITLAB_PREFIX.length);

/** The repository named in full or by the end of its name: `name`, `owner/name`, a GitLab path without its host. */
export const findRepository = (repositories: string[], wanted: string) =>
  repositories.find((candidate) => sameRepository(candidate, wanted)) ??
  repositories.find((candidate) => candidate.toLowerCase().endsWith(`/${wanted.toLowerCase()}`));

const hasRepository = (repositories: string[], repository: string) =>
  repositories.some((candidate) => sameRepository(candidate, repository));

/** An entry that stands for every repository of a GitHub owner, or of a GitLab group and its subgroups. */
export const isPattern = (entry: string) => entry.endsWith('/*');

const patternOwner = (entry: string) => entry.slice(0, -2);

/** One pass: a pattern can stand for thousands of repositories, and a scope is built for every message. */
const unique = (repositories: string[]) => {
  const seen = new Set<string>();
  return repositories.filter((repository) => {
    const key = repository.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

/**
 * The `zulip_expander_group`, `zulip_expander` and `zulip_dm_expander` tables, cached so that no message costs a query;
 * only this service writes them.
 */
@Injectable()
export class ZulipExpanderService {
  private logger = new Logger(ZulipExpanderService.name);
  private cache: Cache = { groups: new Map(), places: new Map() };
  private writes: Promise<unknown> = Promise.resolve();
  /** The repositories of each pattern, by the pattern in lower case, as last read. */
  private patterns = new Map<string, string[]>();

  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    @Inject(IGithubInterface) private github: IGithubInterface,
    @Inject(IGitlabInterface) private gitlab: IGitlabInterface,
  ) {}

  /** The patterns are read in the background, so a slow or failing GitHub does not hold up the start. */
  async init() {
    this.cache = await this.load();
    void this.refreshPatterns();
  }

  /** A pattern that cannot be read keeps the repositories it had. */
  @Cron(Constants.Cron.ExpanderPatterns)
  async refreshPatterns() {
    const entries = unique(this.getGroups().flatMap(({ repositories }) => repositories.filter(isPattern)));
    await Promise.all(
      entries.map(async (entry) => {
        try {
          if (!(await this.readPattern(entry))) {
            this.logger.warn(`${entry} has no repository I can see, so its expander groups keep what they had`);
          }
        } catch (error) {
          this.logger.warn(`Could not read the repositories of ${entry}`, error);
        }
      }),
    );
  }

  /**
   * Reads and caches the repositories of a pattern; resolves to the pattern as GitHub or GitLab spells its owner,
   * `undefined` when there is no such owner or group. Throws when GitHub or GitLab cannot be read.
   */
  async readPattern(entry: string): Promise<{ entry: string; repositories: string[] } | undefined> {
    const owner = patternOwner(entry);
    let found: { entry: string; repositories: string[] } | undefined;
    if (isGitlabRepository(entry)) {
      const group = await this.gitlab.getGroupProjects(gitlabPath(owner));
      found = group && {
        entry: `${GITLAB_PREFIX}${group.path}/*`,
        repositories: group.projects.map((project) => `${GITLAB_PREFIX}${project}`),
      };
    } else {
      const user = await this.github.getOwnerRepositories(owner);
      found = user && { entry: `${user.owner}/*`, repositories: user.repositories };
    }
    if (found) {
      this.patterns.set(found.entry.toLowerCase(), found.repositories);
    }
    return found;
  }

  /** `undefined` while it has not been read. */
  getPatternRepositories(entry: string) {
    return this.patterns.get(entry.toLowerCase());
  }

  /** The repositories a group names, its patterns expanded. */
  getRepositories({ repositories }: ExpanderGroup) {
    return unique(
      repositories.flatMap((entry) => (isPattern(entry) ? (this.getPatternRepositories(entry) ?? []) : [entry])),
    );
  }

  isEnabled(place: ExpanderPlace) {
    return this.cache.places.has(place);
  }

  /** The streams with a group on; direct message conversations are never listed. */
  list() {
    return [...this.cache.places.keys()].filter(isStream).sort((a, b) => a - b);
  }

  getGroups() {
    return [...this.cache.groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getGroup(name: string) {
    return this.cache.groups.get(name);
  }

  getPlaceGroups(place: ExpanderPlace) {
    return this.cache.places.get(place) ?? [];
  }

  getStreams(groupName: string) {
    return this.list().filter((streamId) => this.getPlaceGroups(streamId).includes(groupName));
  }

  getScope(place: ExpanderPlace): ExpanderScope | undefined {
    const groups = this.getPlaceGroups(place)
      .map((name) => this.cache.groups.get(name))
      .filter((group): group is ExpanderGroup => group !== undefined && group.repositories.length > 0);
    if (groups.length === 0) {
      return;
    }

    return { repositories: unique(groups.flatMap((group) => this.getRepositories(group))) };
  }

  /** Resolves to whether it was created, `false` when the name is taken. */
  createGroup(name: string, repositories: string[], createdBy: string) {
    return this.write(
      () => this.database.createZulipExpanderGroup({ name, repositories, createdBy }),
      (created, cache) => {
        if (created) {
          cache.groups.set(name, { name, repositories });
        }
      },
    );
  }

  /** Resolves to the repositories it added, `undefined` when there is no such group. */
  addRepositories(name: string, repositories: string[]) {
    return this.changeRepositories(name, (current) => {
      const added = repositories.filter((repository) => !hasRepository(current, repository));
      return { repositories: [...current, ...added], changed: added };
    });
  }

  /**
   * Resolves to the repositories it removed, `undefined` when there is no such group; a group keeps at least one, so
   * a change that would leave none throws `ExpanderGroupEmptyError` instead.
   */
  removeRepositories(name: string, repositories: string[]) {
    return this.changeRepositories(name, (current) => {
      const removed = current.filter((repository) => hasRepository(repositories, repository));
      const kept = current.filter((repository) => !hasRepository(repositories, repository));
      if (kept.length === 0) {
        throw new ExpanderGroupEmptyError(name);
      }
      return { repositories: kept, changed: removed };
    });
  }

  /** Also turns it off in every stream; resolves to whether there was one. */
  deleteGroup(name: string) {
    return this.write(
      () => this.database.removeZulipExpanderGroup(name),
      (removed, cache) => {
        if (!removed) {
          return;
        }
        cache.groups.delete(name);
        for (const [place, groups] of cache.places) {
          this.setPlaceGroups(
            cache,
            place,
            groups.filter((group) => group !== name),
          );
        }
      },
    );
  }

  /** Resolves to whether it was off and is now on. */
  enable(place: ExpanderPlace, groupName: string, createdBy: string) {
    return this.write(
      () =>
        isStream(place)
          ? this.database.addZulipExpander(place, groupName, createdBy)
          : this.database.addZulipDmExpander(place, groupName, createdBy),
      (added, cache) => {
        if (added) {
          this.setPlaceGroups(cache, place, [...this.groupsOf(cache, place), groupName]);
        }
      },
    );
  }

  /** Every group of the place when none is named; resolves to the groups it turned off. */
  disable(place: ExpanderPlace, groupName?: string) {
    return this.write(
      () =>
        isStream(place)
          ? this.database.removeZulipExpander(place, groupName)
          : this.database.removeZulipDmExpander(place, groupName),
      (removed, cache) =>
        this.setPlaceGroups(
          cache,
          place,
          this.groupsOf(cache, place).filter((group) => !removed.includes(group)),
        ),
    );
  }

  private changeRepositories(
    name: string,
    change: (current: string[]) => { repositories: string[]; changed: string[] },
  ): Promise<string[] | undefined> {
    return this.write(
      async () => {
        const group = this.cache.groups.get(name);
        if (!group) {
          return;
        }
        const { repositories, changed } = change(group.repositories);
        if (changed.length > 0 && !(await this.database.updateZulipExpanderGroup(name, { repositories }))) {
          return;
        }
        return { repositories, changed };
      },
      (result, cache) => {
        const group = cache.groups.get(name);
        if (result && group) {
          cache.groups.set(name, { ...group, repositories: result.repositories });
        }
      },
    ).then((result) => result?.changed);
  }

  private groupsOf(cache: Cache, place: ExpanderPlace) {
    return cache.places.get(place) ?? [];
  }

  private setPlaceGroups(cache: Cache, place: ExpanderPlace, groups: string[]) {
    if (groups.length > 0) {
      cache.places.set(place, groups);
      return;
    }
    cache.places.delete(place);
  }

  private async load(): Promise<Cache> {
    const [groups, streams, conversations] = await Promise.all([
      this.database.getZulipExpanderGroups(),
      this.database.getZulipExpanders(),
      this.database.getZulipDmExpanders(),
    ]);
    const cache: Cache = { groups: new Map(), places: new Map() };
    for (const { name, repositories } of groups) {
      cache.groups.set(name, { name, repositories });
    }
    const placed = [
      ...streams.map(({ streamId, groupName }) => ({ place: streamId as ExpanderPlace, groupName })),
      ...conversations.map(({ conversation, groupName }) => ({ place: conversation, groupName })),
    ];
    for (const { place, groupName } of placed) {
      cache.places.set(place, [...this.groupsOf(cache, place), groupName]);
    }
    return cache;
  }

  /**
   * A command the event loop stopped waiting for can still be writing when the next one runs, so writes run one at a
   * time, each reading the cache the one before left, and the cache is read back from the tables after each; when
   * that read fails, the change is applied to the cache as the write reported it.
   */
  private write<T>(change: () => Promise<T>, apply: (result: T, cache: Cache) => void): Promise<T> {
    const run = this.writes.then(async () => {
      let result: T;
      try {
        result = await change();
      } catch (error) {
        await this.reload().catch(() => undefined);
        throw error;
      }
      try {
        await this.reload();
      } catch (error) {
        this.logger.warn(
          'Could not read the Zulip expanders back, so the change is cached as the write reported it',
          error,
        );
        apply(result, this.cache);
      }
      return result;
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  private async reload() {
    this.cache = await this.load();
  }
}

export class ExpanderGroupEmptyError extends Error {
  constructor(name: string) {
    super(`The expander group ${name} would have no repository left`);
  }
}
