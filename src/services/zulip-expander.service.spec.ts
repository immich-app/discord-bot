import { Logger } from '@nestjs/common';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { IGitlabInterface } from 'src/interfaces/gitlab.interface';
import { ZulipDmExpander, ZulipExpander, ZulipExpanderGroup } from 'src/schema';
import {
  ExpanderGroupEmptyError,
  ZulipExpanderService,
  findRepository,
  gitlabPath,
  isGitlabRepository,
  toConversationKey,
} from 'src/services/zulip-expander.service';
import { beforeEach, describe, expect, it, vitest } from 'vitest';

type Tables = {
  groups: ZulipExpanderGroup[];
  streams: ZulipExpander[];
  conversations?: ZulipDmExpander[];
};

const group = (name: string, repositories: string[]): ZulipExpanderGroup => ({
  name,
  repositories,
  createdBy: 'Alice',
  createdAt: new Date(0),
});

const stream = (streamId: number, groupName: string): ZulipExpander => ({
  streamId,
  groupName,
  createdBy: 'Alice',
  createdAt: new Date(0),
});

/** Keeps the rule the tables keep: a cascade from groups. */
const fakeDatabase = (tables: Tables) => {
  const dms = { conversations: tables.conversations ?? [] };
  return {
    getZulipExpanderGroups: vitest.fn(async () => structuredClone(tables.groups)),
    getZulipExpanders: vitest.fn(async () => structuredClone(tables.streams)),
    createZulipExpanderGroup: vitest.fn(async ({ name, repositories, createdBy }) => {
      if (tables.groups.some((row) => row.name === name)) {
        return false;
      }
      tables.groups.push({ ...group(name, repositories), createdBy });
      return true;
    }),
    updateZulipExpanderGroup: vitest.fn(async (name, update) => {
      const row = tables.groups.find((candidate) => candidate.name === name);
      if (!row) {
        return false;
      }
      Object.assign(row, update);
      return true;
    }),
    removeZulipExpanderGroup: vitest.fn(async (name) => {
      const before = tables.groups.length;
      tables.groups = tables.groups.filter((row) => row.name !== name);
      tables.streams = tables.streams.filter((row) => row.groupName !== name);
      dms.conversations = dms.conversations.filter((row) => row.groupName !== name);
      return tables.groups.length !== before;
    }),
    addZulipExpander: vitest.fn(async (streamId, groupName) => {
      if (tables.streams.some((row) => row.streamId === streamId && row.groupName === groupName)) {
        return false;
      }
      tables.streams.push(stream(streamId, groupName));
      return true;
    }),
    removeZulipExpander: vitest.fn(async (streamId, groupName) => {
      const removed = tables.streams.filter(
        (row) => row.streamId === streamId && (groupName === undefined || row.groupName === groupName),
      );
      tables.streams = tables.streams.filter((row) => !removed.includes(row));
      return removed.map((row) => row.groupName);
    }),
    getZulipDmExpanders: vitest.fn(async () => structuredClone(dms.conversations)),
    addZulipDmExpander: vitest.fn(async (conversation: string, groupName: string, createdBy: string) => {
      if (dms.conversations.some((row) => row.conversation === conversation && row.groupName === groupName)) {
        return false;
      }
      dms.conversations.push({ conversation, groupName, createdBy, createdAt: new Date(0) });
      return true;
    }),
    removeZulipDmExpander: vitest.fn(async (conversation: string, groupName?: string) => {
      const removed = dms.conversations.filter(
        (row) => row.conversation === conversation && (groupName === undefined || row.groupName === groupName),
      );
      dms.conversations = dms.conversations.filter((row) => !removed.includes(row));
      return removed.map((row) => row.groupName);
    }),
  } satisfies Partial<Record<keyof IDatabaseRepository, unknown>>;
};

describe('toConversationKey', () => {
  it('should name a conversation by its users, ascending, once each, whatever order they come in', () => {
    expect(toConversationKey([99, 13, 12, 13])).toBe('12,13,99');
    expect(toConversationKey([12, 99])).toBe(toConversationKey([99, 12]));
  });
});

describe('repository names', () => {
  const repositories = [
    'immich-app/immich',
    'gitlab.futo.org/videostreaming/grayjay',
    'gitlab.futo.org/videostreaming/plugins/kick',
  ];

  it('should tell GitLab projects by their host, in any case', () => {
    expect(isGitlabRepository('gitlab.futo.org/videostreaming/grayjay')).toBe(true);
    expect(isGitlabRepository('GitLab.FUTO.org/videostreaming/grayjay')).toBe(true);
    expect(isGitlabRepository('immich-app/immich')).toBe(false);
    expect(isGitlabRepository('gitlab.futo.organisation/x/y')).toBe(false);
    expect(gitlabPath('gitlab.futo.org/videostreaming/plugins/kick')).toBe('videostreaming/plugins/kick');
  });

  it.each([
    ['immich-app/immich', 'immich-app/immich'],
    ['IMMICH', 'immich-app/immich'],
    ['grayjay', 'gitlab.futo.org/videostreaming/grayjay'],
    ['videostreaming/grayjay', 'gitlab.futo.org/videostreaming/grayjay'],
    ['gitlab.futo.org/videostreaming/GrayJay', 'gitlab.futo.org/videostreaming/grayjay'],
    ['plugins/kick', 'gitlab.futo.org/videostreaming/plugins/kick'],
    ['kick', 'gitlab.futo.org/videostreaming/plugins/kick'],
  ])('should find %s as %s', (wanted, found) => {
    expect(findRepository(repositories, wanted)).toBe(found);
  });

  it.each(['jay', 'immich-app', 'other/immich', 'ugins/kick'])('should find nothing for %s', (wanted) => {
    expect(findRepository(repositories, wanted)).toBeUndefined();
  });
});

describe(ZulipExpanderService.name, () => {
  let tables: Tables;
  let database: ReturnType<typeof fakeDatabase>;
  let sut: ZulipExpanderService;
  let github: { getOwnerRepositories: ReturnType<typeof vitest.fn> };
  let gitlab: { getGroupProjects: ReturnType<typeof vitest.fn> };

  beforeEach(async () => {
    tables = {
      groups: [
        group('immich', ['immich-app/immich']),
        group('fhs', ['futo-org/fhs-core', 'futo-org/grayjay']),
        group('apps', ['futo-org/grayjay', 'immich-app/immich']),
      ],
      streams: [stream(107, 'immich'), stream(54, 'immich'), stream(54, 'fhs')],
    };
    database = fakeDatabase(tables);
    github = { getOwnerRepositories: vitest.fn() };
    gitlab = { getGroupProjects: vitest.fn() };
    sut = newSut();
    await sut.init();
  });

  const newSut = () =>
    new ZulipExpanderService(
      database as unknown as IDatabaseRepository,
      github as unknown as IGithubInterface,
      gitlab as unknown as IGitlabInterface,
    );

  it('should know nothing before init', () => {
    const fresh = newSut();

    expect(fresh.list()).toEqual([]);
    expect(fresh.getGroups()).toEqual([]);
    expect(fresh.isEnabled(107)).toBe(false);
    expect(fresh.getScope(107)).toBeUndefined();
  });

  it('should load the tables once, at init, and answer from the cache', () => {
    expect(sut.isEnabled(107)).toBe(true);
    expect(sut.isEnabled(999)).toBe(false);
    expect(sut.list()).toEqual([54, 107]);
    expect(sut.getGroups().map(({ name }) => name)).toEqual(['apps', 'fhs', 'immich']);
    expect(sut.getPlaceGroups(54)).toEqual(['immich', 'fhs']);
    expect(sut.getStreams('immich')).toEqual([54, 107]);
    expect(database.getZulipExpanderGroups).toHaveBeenCalledOnce();
    expect(database.getZulipExpanders).toHaveBeenCalledOnce();
    expect(database.getZulipDmExpanders).toHaveBeenCalledOnce();
  });

  describe('getScope', () => {
    it('should have no scope in a stream without a group', () => {
      expect(sut.getScope(999)).toBeUndefined();
    });

    it("should give the stream's repositories alone, once each, in the order its groups were turned on", async () => {
      await sut.enable(54, 'apps', 'Alice');

      expect(sut.getScope(54)).toEqual({
        repositories: ['immich-app/immich', 'futo-org/fhs-core', 'futo-org/grayjay'],
      });
    });
  });

  it('should create a group, resolving to whether the name was free', async () => {
    expect(await sut.createGroup('new', ['owner/repo'], 'Alice on Zulip (user 12)')).toBe(true);
    expect(await sut.createGroup('new', ['owner/other'], 'Bob')).toBe(false);

    expect(database.createZulipExpanderGroup).toHaveBeenCalledWith({
      name: 'new',
      repositories: ['owner/repo'],
      createdBy: 'Alice on Zulip (user 12)',
    });
    expect(sut.getGroup('new')).toEqual({ name: 'new', repositories: ['owner/repo'] });
  });

  it('should add only the repositories a group lacks, without regard to case', async () => {
    expect(await sut.addRepositories('fhs', ['FUTO-org/fhs-core', 'futo-org/polycentric'])).toEqual([
      'futo-org/polycentric',
    ]);
    expect(await sut.addRepositories('fhs', ['futo-org/polycentric'])).toEqual([]);
    expect(await sut.addRepositories('nope', ['owner/repo'])).toBeUndefined();

    expect(database.updateZulipExpanderGroup).toHaveBeenCalledOnce();
    expect(sut.getGroup('fhs')?.repositories).toEqual([
      'futo-org/fhs-core',
      'futo-org/grayjay',
      'futo-org/polycentric',
    ]);
  });

  it('should remove repositories without regard to case, but never the last one', async () => {
    expect(await sut.removeRepositories('fhs', ['FUTO-ORG/FHS-CORE', 'owner/absent'])).toEqual(['futo-org/fhs-core']);
    expect(await sut.removeRepositories('fhs', ['owner/absent'])).toEqual([]);
    await expect(sut.removeRepositories('fhs', ['futo-org/grayjay'])).rejects.toBeInstanceOf(ExpanderGroupEmptyError);
    expect(await sut.removeRepositories('nope', ['owner/repo'])).toBeUndefined();

    expect(sut.getGroup('fhs')?.repositories).toEqual(['futo-org/grayjay']);
    expect(tables.groups.find(({ name }) => name === 'fhs')?.repositories).toEqual(['futo-org/grayjay']);
  });

  it('should delete a group and turn it off in every stream', async () => {
    expect(await sut.deleteGroup('immich')).toBe(true);
    expect(await sut.deleteGroup('immich')).toBe(false);

    expect(sut.getGroup('immich')).toBeUndefined();
    expect(sut.isEnabled(107)).toBe(false);
    expect(sut.getPlaceGroups(54)).toEqual(['fhs']);
    expect(sut.getScope(54)).toEqual({ repositories: ['futo-org/fhs-core', 'futo-org/grayjay'] });
  });

  it('should turn a group on, resolving to whether it was off', async () => {
    expect(await sut.enable(120, 'fhs', 'Alice on Zulip (user 12)')).toBe(true);
    expect(await sut.enable(120, 'fhs', 'Alice on Zulip (user 12)')).toBe(false);

    expect(database.addZulipExpander).toHaveBeenCalledWith(120, 'fhs', 'Alice on Zulip (user 12)');
    expect(sut.list()).toEqual([54, 107, 120]);
  });

  it('should turn off one group or every group, resolving to the groups turned off', async () => {
    expect(await sut.disable(54, 'fhs')).toEqual(['fhs']);
    expect(await sut.disable(54, 'fhs')).toEqual([]);
    expect(sut.getPlaceGroups(54)).toEqual(['immich']);

    expect(await sut.disable(54)).toEqual(['immich']);
    expect(sut.isEnabled(54)).toBe(false);
    expect(sut.getScope(54)).toBeUndefined();
  });

  describe('direct message conversations', () => {
    const DM = '12,13,99';

    it('should turn a group on in a conversation, keeping it out of the stream listings', async () => {
      expect(await sut.enable(DM, 'fhs', 'Alice on Zulip (user 12)')).toBe(true);
      expect(await sut.enable(DM, 'fhs', 'Alice on Zulip (user 12)')).toBe(false);

      expect(database.addZulipDmExpander).toHaveBeenCalledWith(DM, 'fhs', 'Alice on Zulip (user 12)');
      expect(database.addZulipExpander).not.toHaveBeenCalled();
      expect(sut.getScope(DM)).toEqual({ repositories: ['futo-org/fhs-core', 'futo-org/grayjay'] });
      expect(sut.list()).toEqual([54, 107]);
      expect(sut.getStreams('fhs')).toEqual([54]);
    });

    it('should turn every group off in a conversation', async () => {
      await sut.enable(DM, 'fhs', 'Alice');

      expect(await sut.disable(DM)).toEqual(['fhs']);
      expect(database.removeZulipDmExpander).toHaveBeenCalledWith(DM, undefined);
      expect(database.removeZulipExpander).not.toHaveBeenCalled();
      expect(sut.isEnabled(DM)).toBe(false);
    });

    it('should load conversations at init, and turn a deleted group off in them', async () => {
      tables.conversations = [{ conversation: DM, groupName: 'fhs', createdBy: 'Alice', createdAt: new Date(0) }];
      database = fakeDatabase(tables);
      sut = newSut();
      await sut.init();

      expect(sut.getPlaceGroups(DM)).toEqual(['fhs']);

      await sut.deleteGroup('fhs');

      expect(sut.isEnabled(DM)).toBe(false);
    });
  });

  it('should leave the cache as it was when a write fails', async () => {
    database.addZulipExpander.mockRejectedValue(new Error('connection terminated'));

    await expect(sut.enable(999, 'fhs', 'Alice')).rejects.toThrow('connection terminated');

    expect(sut.isEnabled(999)).toBe(false);
  });

  it('should run a change after one still writing, so the cache ends as the tables do', async () => {
    let finishAdd = () => {};
    const add = database.addZulipExpander.getMockImplementation()!;
    database.addZulipExpander.mockImplementationOnce(
      (...args) => new Promise((resolve) => (finishAdd = () => resolve(add(...args)))),
    );

    const enabling = sut.enable(120, 'fhs', 'Alice');
    const disabling = sut.disable(120);
    await Promise.resolve();
    expect(database.removeZulipExpander).not.toHaveBeenCalled();

    finishAdd();
    expect(await enabling).toBe(true);
    expect(await disabling).toEqual(['fhs']);

    expect(tables.streams.some(({ streamId }) => streamId === 120)).toBe(false);
    expect(sut.isEnabled(120)).toBe(false);
  });

  it('should change repositories from what the write before left', async () => {
    const adding = sut.addRepositories('fhs', ['futo-org/polycentric']);
    const removing = sut.removeRepositories('fhs', ['futo-org/fhs-core']);

    expect(await adding).toEqual(['futo-org/polycentric']);
    expect(await removing).toEqual(['futo-org/fhs-core']);
    expect(sut.getGroup('fhs')?.repositories).toEqual(['futo-org/grayjay', 'futo-org/polycentric']);
  });

  it('should cache a change as the write reported it when reading the tables back fails', async () => {
    vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const failRead = () => database.getZulipExpanders.mockRejectedValueOnce(new Error('connection terminated'));

    failRead();
    expect(await sut.enable(120, 'fhs', 'Alice')).toBe(true);
    expect(sut.getPlaceGroups(120)).toEqual(['fhs']);

    failRead();
    expect(await sut.addRepositories('fhs', ['futo-org/polycentric'])).toEqual(['futo-org/polycentric']);
    expect(sut.getGroup('fhs')?.repositories).toContain('futo-org/polycentric');

    failRead();
    expect(await sut.createGroup('new', ['owner/repo'], 'Alice')).toBe(true);
    expect(sut.getGroup('new')).toEqual({ name: 'new', repositories: ['owner/repo'] });

    failRead();
    expect(await sut.disable(120)).toEqual(['fhs']);
    expect(sut.isEnabled(120)).toBe(false);

    failRead();
    expect(await sut.deleteGroup('immich')).toBe(true);
    expect(sut.getPlaceGroups(54)).toEqual(['fhs']);
    expect(sut.isEnabled(107)).toBe(false);

    expect(Logger.prototype.warn).toHaveBeenCalledTimes(5);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'Could not read the Zulip expanders back, so the change is cached as the write reported it',
      expect.any(Error),
    );
  });

  describe('patterns', () => {
    const IMMICH_APP = ['immich-app/immich', 'immich-app/static-pages', 'immich-app/devtools'];

    const withPatterns = async () => {
      tables.groups.push(
        group('everything', ['immich-app/*', 'gitlab.futo.org/videostreaming/*', 'futo-org/fhs-core']),
        group('only', ['immich-app/*']),
      );
      tables.streams.push(stream(130, 'everything'), stream(140, 'only'));
      github.getOwnerRepositories.mockResolvedValue({ owner: 'immich-app', repositories: IMMICH_APP });
      gitlab.getGroupProjects.mockResolvedValue({
        path: 'videostreaming',
        projects: ['videostreaming/grayjay', 'videostreaming/plugins/kick'],
      });
      sut = newSut();
      await sut.init();
      await vitest.waitFor(() => expect(sut.getPatternRepositories('gitlab.futo.org/videostreaming/*')).toBeDefined());
    };

    it('should read every pattern at init, in the background', async () => {
      await withPatterns();

      expect(github.getOwnerRepositories).toHaveBeenCalledExactlyOnceWith('immich-app');
      expect(gitlab.getGroupProjects).toHaveBeenCalledExactlyOnceWith('videostreaming');
      expect(sut.getPatternRepositories('IMMICH-APP/*')).toEqual(IMMICH_APP);
    });

    it('should not read a group that names repositories only', async () => {
      await sut.refreshPatterns();

      expect(github.getOwnerRepositories).not.toHaveBeenCalled();
      expect(gitlab.getGroupProjects).not.toHaveBeenCalled();
    });

    it('should expand a group, without duplicates', async () => {
      await withPatterns();
      const everything = sut.getGroup('everything')!;

      expect(sut.getRepositories(everything)).toEqual([
        ...IMMICH_APP,
        'gitlab.futo.org/videostreaming/grayjay',
        'gitlab.futo.org/videostreaming/plugins/kick',
        'futo-org/fhs-core',
      ]);
      expect(sut.getScope(130)).toEqual({ repositories: sut.getRepositories(everything) });
      expect(sut.getScope(140)).toEqual({ repositories: IMMICH_APP });
    });

    it('should read a pattern as GitHub or GitLab spells it, or not at all when there is no such owner', async () => {
      github.getOwnerRepositories.mockResolvedValueOnce({ owner: 'immich-app', repositories: IMMICH_APP });
      gitlab.getGroupProjects.mockResolvedValueOnce({
        path: 'VideoStreaming/Plugins',
        projects: ['VideoStreaming/Plugins/kick'],
      });

      expect(await sut.readPattern('IMMICH-APP/*')).toEqual({ entry: 'immich-app/*', repositories: IMMICH_APP });
      expect(await sut.readPattern('gitlab.futo.org/videostreaming/plugins/*')).toEqual({
        entry: 'gitlab.futo.org/VideoStreaming/Plugins/*',
        repositories: ['gitlab.futo.org/VideoStreaming/Plugins/kick'],
      });
      expect(gitlab.getGroupProjects).toHaveBeenCalledWith('videostreaming/plugins');
      expect(await sut.readPattern('nobody/*')).toBeUndefined();
      expect(sut.getPatternRepositories('nobody/*')).toBeUndefined();
    });

    it('should keep what a pattern had when it cannot be read again, and say why', async () => {
      await withPatterns();
      const warn = vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      github.getOwnerRepositories.mockRejectedValueOnce(new Error('rate limited'));
      gitlab.getGroupProjects.mockResolvedValueOnce(undefined);

      await sut.refreshPatterns();

      expect(sut.getPatternRepositories('immich-app/*')).toEqual(IMMICH_APP);
      expect(sut.getPatternRepositories('gitlab.futo.org/videostreaming/*')).toHaveLength(2);
      expect(warn).toHaveBeenCalledWith('Could not read the repositories of immich-app/*', expect.any(Error));
      expect(warn).toHaveBeenCalledWith(
        'gitlab.futo.org/videostreaming/* has no repository I can see, so its expander groups keep what they had',
      );
    });

    it('should pick up a repository the owner added since', async () => {
      await withPatterns();
      github.getOwnerRepositories.mockResolvedValueOnce({
        owner: 'immich-app',
        repositories: [...IMMICH_APP, 'immich-app/new-thing'],
      });

      await sut.refreshPatterns();

      expect(sut.getScope(140)?.repositories).toContain('immich-app/new-thing');
    });
  });
});
