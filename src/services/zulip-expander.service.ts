import { Inject, Injectable, Logger } from '@nestjs/common';
import { Constants } from 'src/constants';
import { IDatabaseRepository } from 'src/interfaces/database.interface';

export type ExpanderGroup = { name: string; repositories: string[]; threshold: number };

/** What GitHub expansion resolves `#123` and `repo#123` against in one stream. */
export type ExpanderScope = {
  /** `owner/name`, every repository of the stream's groups, in the order the groups were turned on. */
  repositories: string[];
  defaultRepository: string;
  /** A bare `#123` below this expands only for a pull request updated in the last two weeks. */
  threshold: (repository: string) => number;
};

type Cache = {
  groups: Map<string, ExpanderGroup>;
  /** Group names, in the order they were turned on in the stream. */
  streams: Map<number, string[]>;
  defaults: Map<number, string>;
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

/**
 * The `zulip_expander_group`, `zulip_expander` and `zulip_expander_default` tables, cached so that no message costs a
 * query; only this service writes them.
 */
@Injectable()
export class ZulipExpanderService {
  private logger = new Logger(ZulipExpanderService.name);
  private cache: Cache = { groups: new Map(), streams: new Map(), defaults: new Map() };
  private writes: Promise<unknown> = Promise.resolve();

  constructor(@Inject(IDatabaseRepository) private database: IDatabaseRepository) {}

  async init() {
    this.cache = await this.load();
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

    const repositories: string[] = [];
    for (const repository of groups.flatMap((group) => group.repositories)) {
      if (!hasRepository(repositories, repository)) {
        repositories.push(repository);
      }
    }
    const chosen = this.cache.defaults.get(streamId);
    const defaultRepository =
      (chosen && repositories.find((repository) => sameRepository(repository, chosen))) ?? groups[0].repositories[0];

    return {
      repositories,
      defaultRepository,
      threshold: (repository) =>
        Math.max(
          0,
          ...groups.filter((group) => hasRepository(group.repositories, repository)).map((group) => group.threshold),
        ),
    };
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
