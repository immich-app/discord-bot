import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Constants, GithubOrg, GithubRepo } from 'src/constants';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { IGitlabInterface } from 'src/interfaces/gitlab.interface';

/** `repositories` holds repositories and patterns, `owner/*` or `gitlab.futo.org/namespace/*`. */
export type ExpanderGroup = { name: string; repositories: string[]; threshold: number };

/** What GitHub expansion resolves `#123` and `repo#123` against in one stream, or in direct messages. */
export type ExpanderScope = {
  /** `owner/name`, every repository of the stream's groups, patterns expanded, in the order the groups were turned on. */
  repositories: string[];
  /** None when no group of the stream names a repository of its own and the stream chose none. */
  defaultRepository?: string;
  /** A bare `#123` below this expands only for a pull request updated in the last two weeks. */
  threshold: (repository: string) => number;
  /** When set, a repository expands, link, reference or permalink, only once this resolves to `true` for it. */
  allows?: (repository: string) => Promise<boolean>;
};

type Cache = {
  groups: Map<string, ExpanderGroup>;
  /** Group names, in the order they were turned on in the stream. */
  streams: Map<number, string[]>;
  defaults: Map<number, string>;
};

export const sameRepository = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const GITLAB_PREFIX = `${Constants.Gitlab.Host}/`;

/** What a bare `#123` means in a direct message. */
const DIRECT_MESSAGE_REPOSITORY = `${GithubOrg.ImmichApp}/${GithubRepo.Immich}`;

/** How long a repository's visibility is trusted once read. */
const VISIBILITY_MAX_AGE_MS = 10 * 60 * 1000;

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
 * The `zulip_expander_group`, `zulip_expander` and `zulip_expander_default` tables, cached so that no message costs a
 * query; only this service writes them.
 */
@Injectable()
export class ZulipExpanderService {
  private logger = new Logger(ZulipExpanderService.name);
  private cache: Cache = { groups: new Map(), streams: new Map(), defaults: new Map() };
  private writes: Promise<unknown> = Promise.resolve();
  /** The repositories of each pattern, by the pattern in lower case, as last read. */
  private patterns = new Map<string, string[]>();
  /** Whether each repository is public, by the repository in lower case, as last read. */
  private visibility = new Map<string, { isPublic: Promise<boolean>; readAt: number }>();

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

  /** The first repository the group names itself, which a pattern never is. */
  getGroupDefault({ repositories }: ExpanderGroup) {
    return repositories.find((entry) => !isPattern(entry));
  }

  isEnabled(streamId: number) {
    return this.cache.streams.has(streamId);
  }

  /** The streams GitHub expansion is on in. */
  list() {
    return [...this.cache.streams.keys()].sort((a, b) => a - b);
  }

  getGroups() {
    return [...this.cache.groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getGroup(name: string) {
    return this.cache.groups.get(name);
  }

  getStreamGroups(streamId: number) {
    return this.cache.streams.get(streamId) ?? [];
  }

  getStreams(groupName: string) {
    return this.list().filter((streamId) => this.getStreamGroups(streamId).includes(groupName));
  }

  getScope(streamId: number): ExpanderScope | undefined {
    const groups = this.getStreamGroups(streamId)
      .map((name) => this.cache.groups.get(name))
      .filter((group): group is ExpanderGroup => group !== undefined && group.repositories.length > 0);
    if (groups.length === 0) {
      return;
    }

    const expanded = groups.map((group) => ({ group, repositories: this.getRepositories(group) }));
    const repositories = unique(expanded.flatMap((entry) => entry.repositories));
    const chosen = this.cache.defaults.get(streamId);
    const defaultRepository =
      (chosen && repositories.find((repository) => sameRepository(repository, chosen))) ??
      groups.map((group) => this.getGroupDefault(group)).find((repository) => repository !== undefined);

    return {
      repositories,
      defaultRepository,
      threshold: (repository) =>
        Math.max(
          0,
          ...expanded
            .filter((entry) => hasRepository(entry.repositories, repository))
            .map((entry) => entry.group.threshold),
        ),
    };
  }

  /**
   * Anyone in the realm can message the bot, so a direct message expands public repositories alone: a bare `#123` is
   * `immich-app/immich`'s, below the highest threshold of the groups that hold it as in a stream, and links,
   * references and permalinks expand once `isPublic` says their repository is.
   */
  getDirectScope(): ExpanderScope {
    const threshold = Math.max(
      0,
      ...this.getGroups()
        .filter((group) => hasRepository(this.getRepositories(group), DIRECT_MESSAGE_REPOSITORY))
        .map((group) => group.threshold),
    );
    return {
      repositories: [DIRECT_MESSAGE_REPOSITORY],
      defaultRepository: DIRECT_MESSAGE_REPOSITORY,
      threshold: () => threshold,
      allows: (repository) => this.isPublic(repository),
    };
  }

  /**
   * Whether GitHub or GitLab shows the repository to everyone, cached for ten minutes; one whose visibility cannot be
   * read counts as private, and is read again the next time.
   */
  isPublic(repository: string) {
    const key = repository.toLowerCase();
    const now = Date.now();
    const cached = this.visibility.get(key);
    if (cached && now - cached.readAt < VISIBILITY_MAX_AGE_MS) {
      return cached.isPublic;
    }
    for (const [stale, { readAt }] of this.visibility) {
      if (now - readAt >= VISIBILITY_MAX_AGE_MS) {
        this.visibility.delete(stale);
      }
    }
    const entry = {
      readAt: now,
      isPublic: this.readVisibility(repository).catch((error: unknown) => {
        this.logger.warn(`Could not read whether ${repository} is public, so it counts as private`, error);
        if (this.visibility.get(key) === entry) {
          this.visibility.delete(key);
        }
        return false;
      }),
    };
    this.visibility.set(key, entry);
    return entry.isPublic;
  }

  private async readVisibility(repository: string) {
    if (isGitlabRepository(repository)) {
      return this.gitlab.isProjectPublic(gitlabPath(repository));
    }
    const [org, repo, ...rest] = repository.split('/');
    return !!org && !!repo && rest.length === 0 && this.github.isRepositoryPublic({ org, repo });
  }

  /** Resolves to whether it was created, `false` when the name is taken. */
  createGroup(name: string, repositories: string[], createdBy: string) {
    return this.write(
      () => this.database.createZulipExpanderGroup({ name, repositories, createdBy }),
      (created, cache) => {
        if (created) {
          cache.groups.set(name, { name, repositories, threshold: 0 });
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

  /** Resolves to whether there is such a group. */
  setThreshold(name: string, threshold: number) {
    return this.write(
      () => this.database.updateZulipExpanderGroup(name, { threshold }),
      (updated, cache) => {
        const group = cache.groups.get(name);
        if (updated && group) {
          cache.groups.set(name, { ...group, threshold });
        }
      },
    );
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
        for (const [streamId, groups] of cache.streams) {
          this.setStreamGroups(
            cache,
            streamId,
            groups.filter((group) => group !== name),
          );
        }
      },
    );
  }

  /** Resolves to whether it was off and is now on. */
  enable(streamId: number, groupName: string, createdBy: string) {
    return this.write(
      () => this.database.addZulipExpander(streamId, groupName, createdBy),
      (added, cache) => {
        if (added) {
          this.setStreamGroups(cache, streamId, [...this.groupsOf(cache, streamId), groupName]);
        }
      },
    );
  }

  /** Every group of the stream when none is named; resolves to the groups it turned off. */
  disable(streamId: number, groupName?: string) {
    return this.write(
      () => this.database.removeZulipExpander(streamId, groupName),
      (removed, cache) =>
        this.setStreamGroups(
          cache,
          streamId,
          this.groupsOf(cache, streamId).filter((group) => !removed.includes(group)),
        ),
    );
  }

  setDefault(streamId: number, repository: string, createdBy: string) {
    return this.write(
      () => this.database.setZulipExpanderDefault(streamId, repository, createdBy),
      (_, cache) => {
        cache.defaults.set(streamId, repository);
      },
    );
  }

  getDefault(streamId: number) {
    return this.cache.defaults.get(streamId);
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

  private groupsOf(cache: Cache, streamId: number) {
    return cache.streams.get(streamId) ?? [];
  }

  private setStreamGroups(cache: Cache, streamId: number, groups: string[]) {
    if (groups.length > 0) {
      cache.streams.set(streamId, groups);
      return;
    }
    cache.streams.delete(streamId);
    cache.defaults.delete(streamId);
  }

  private async load(): Promise<Cache> {
    const [groups, streams, defaults] = await Promise.all([
      this.database.getZulipExpanderGroups(),
      this.database.getZulipExpanders(),
      this.database.getZulipExpanderDefaults(),
    ]);
    const cache: Cache = { groups: new Map(), streams: new Map(), defaults: new Map() };
    for (const { name, repositories, threshold } of groups) {
      cache.groups.set(name, { name, repositories, threshold });
    }
    for (const { streamId, groupName } of streams) {
      cache.streams.set(streamId, [...this.groupsOf(cache, streamId), groupName]);
    }
    for (const { streamId, repository } of defaults) {
      cache.defaults.set(streamId, repository);
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
