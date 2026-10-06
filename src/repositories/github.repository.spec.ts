import { Logger } from '@nestjs/common';
import { GraphqlResponseError } from '@octokit/graphql';
import { GithubRepository } from 'src/repositories/github.repository';
import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

describe(GithubRepository.name, () => {
  let sut: GithubRepository;
  let graphql: ReturnType<typeof vitest.fn>;

  beforeEach(() => {
    sut = new GithubRepository();
    graphql = vitest.fn();
    (sut as unknown as { octokit: { graphql: typeof graphql } }).octokit = { graphql };
  });

  describe('getLatestReleaseTag', () => {
    it('should resolve to the commit the latest release is tagged on', async () => {
      graphql.mockResolvedValue({ repository: { latestRelease: { tagCommit: { oid: 'abc123' } } } });

      expect(await sut.getLatestReleaseTag('immich-app', 'immich')).toBe('abc123');
      expect(graphql).toHaveBeenCalledWith(expect.any(String), { org: 'immich-app', repo: 'immich' });
    });

    it('should resolve to undefined for a repository without a release, quietly', async () => {
      const warn = vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      graphql.mockResolvedValue({ repository: { latestRelease: null } });

      expect(await sut.getLatestReleaseTag('immich-app', 'discord-bot')).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it('should resolve to undefined for a release whose tag points at no commit, and say so', async () => {
      const warn = vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      graphql.mockResolvedValue({ repository: { latestRelease: { tagCommit: null } } });

      expect(await sut.getLatestReleaseTag('immich-app', 'immich')).toBeUndefined();
      expect(warn).toHaveBeenCalledExactlyOnceWith('The latest release of immich-app/immich is tagged on no commit');
    });
  });

  describe('isRepositoryPublic', () => {
    it.each([
      { visibility: 'PUBLIC', expected: true },
      { visibility: 'PRIVATE', expected: false },
      { visibility: 'INTERNAL', expected: false },
    ])('should resolve to $expected for a $visibility repository', async ({ visibility, expected }) => {
      graphql.mockResolvedValue({ repository: { visibility } });

      expect(await sut.isRepositoryPublic({ org: 'immich-app', repo: 'immich' })).toBe(expected);
      expect(graphql).toHaveBeenCalledWith(expect.stringContaining('visibility'), {
        org: 'immich-app',
        repo: 'immich',
      });
    });

    it('should resolve to false for a repository GitHub does not show', async () => {
      graphql.mockRejectedValue(
        new GraphqlResponseError(
          { method: 'POST', url: '/graphql' },
          {},
          {
            data: { repository: null },
            errors: [
              {
                type: 'NOT_FOUND',
                message: 'Not found',
                locations: [{ line: 1, column: 1 }],
                path: ['repository'],
                extensions: {},
              },
            ],
          },
        ),
      );

      expect(await sut.isRepositoryPublic({ org: 'futo-org', repo: 'secret' })).toBe(false);
    });

    it('should throw when GitHub cannot be read', async () => {
      graphql.mockRejectedValue(new Error('GitHub is down'));

      await expect(sut.isRepositoryPublic({ org: 'immich-app', repo: 'immich' })).rejects.toThrow('GitHub is down');
    });
  });

  describe('installations', () => {
    const CONFIGURED = 1;
    const FUTO = 2;

    const newClient = () => ({
      graphql: vitest.fn((query: string, { owner }: { owner?: string }) =>
        Promise.resolve(
          query.includes('repositoryOwner')
            ? {
                repositoryOwner: {
                  login: owner,
                  repositories: {
                    nodes: [{ nameWithOwner: `${owner}/private-thing` }],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              }
            : { repository: { stargazerCount: 5 } },
        ),
      ),
    });

    const install = (installations: Promise<unknown[]>) => {
      const configured = newClient();
      const clients = new Map<number, ReturnType<typeof newClient>>();
      const app = {
        octokit: { paginate: vitest.fn().mockReturnValue(installations) },
        getInstallationOctokit: vitest.fn((id: number) => {
          const client = newClient();
          clients.set(id, client);
          return Promise.resolve(client);
        }),
      };
      Object.assign(sut, {
        app,
        octokit: configured,
        installationOctokits: new Map([[CONFIGURED, Promise.resolve(configured)]]),
      });
      return { app, configured, clients };
    };

    const installed = (futo = FUTO) =>
      Promise.resolve([
        { id: CONFIGURED, account: { login: 'immich-app' } },
        { id: futo, account: { login: 'futo-org' } },
      ]);

    afterEach(() => {
      vitest.useRealTimers();
    });

    it('should read with the installation on the owner, whatever the case of its login', async () => {
      const { app, configured, clients } = install(installed());

      expect(await sut.getStarCount('FUTO-org', 'fhs-core')).toBe(5);
      expect(app.getInstallationOctokit).toHaveBeenCalledExactlyOnceWith(FUTO);
      expect(clients.get(FUTO)!.graphql).toHaveBeenCalledWith(expect.any(String), {
        org: 'FUTO-org',
        repo: 'fhs-core',
      });
      expect(configured.graphql).not.toHaveBeenCalled();
    });

    it('should ignore an installation on an account outside the allowed owners, and say so once', async () => {
      vitest.useFakeTimers();
      const warn = vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const { app, configured } = install(
        Promise.resolve([
          { id: CONFIGURED, account: { login: 'immich-app' } },
          { id: 6, account: { login: 'Someone-Else' } },
          { id: 7, account: { slug: 'an-enterprise' } },
          { id: 8, account: null },
        ]),
      );
      await sut.getStarCount('someone-else', 'private-thing');
      vitest.advanceTimersByTime(10 * 60 * 1000);
      await sut.getStarCount('someone-else', 'private-thing');

      expect(app.octokit.paginate).toHaveBeenCalledTimes(2);
      expect(configured.graphql).toHaveBeenCalledTimes(2);
      expect(app.getInstallationOctokit).not.toHaveBeenCalled();
      expect(warn.mock.calls).toEqual([
        [
          "Ignoring the GitHub App's installation 6 on Someone-Else, which is not one of Constants.Github.InstallationOwners",
        ],
        [
          "Ignoring the GitHub App's installation 7 on an-enterprise, which is not one of Constants.Github.InstallationOwners",
        ],
        [
          "Ignoring the GitHub App's installation 8 on an unknown account, which is not one of Constants.Github.InstallationOwners",
        ],
      ]);
    });

    it('should warn again about an ignored installation that went away and came back', async () => {
      vitest.useFakeTimers();
      const warn = vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const ignored = { id: 6, account: { login: 'someone-else' } };
      const { app } = install(Promise.resolve([ignored]));
      await sut.getStarCount('someone-else', 'repo');

      for (const installations of [[], [ignored]]) {
        app.octokit.paginate.mockReturnValue(Promise.resolve(installations));
        vitest.advanceTimersByTime(10 * 60 * 1000);
        await sut.getStarCount('someone-else', 'repo');
      }

      expect(app.octokit.paginate).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it("should list an organization's repositories, private ones included, with its installation", async () => {
      const { configured, clients } = install(installed());

      expect(await sut.getOwnerRepositories('futo-org')).toEqual({
        owner: 'futo-org',
        repositories: ['futo-org/private-thing'],
      });
      expect(clients.get(FUTO)!.graphql).toHaveBeenCalledOnce();
      expect(configured.graphql).not.toHaveBeenCalled();
    });

    it('should read with the configured installation for an owner the app is not installed on', async () => {
      const { app, configured } = install(installed());

      await sut.getStarCount('someone-else', 'repo');

      expect(configured.graphql).toHaveBeenCalledOnce();
      expect(app.getInstallationOctokit).not.toHaveBeenCalled();
    });

    it("should read the configured installation's owner with the client it already has", async () => {
      const { app, configured } = install(installed());

      await sut.getStarCount('immich-app', 'immich');

      expect(configured.graphql).toHaveBeenCalledOnce();
      expect(app.getInstallationOctokit).not.toHaveBeenCalled();
    });

    it('should make one client per installation and list the installations once', async () => {
      const { app, clients } = install(installed());

      await sut.getStarCount('futo-org', 'fhs-core');
      await sut.getStarCount('futo-org', 'grayjay');
      await sut.getStarCount('someone-else', 'repo');

      expect(app.getInstallationOctokit).toHaveBeenCalledExactlyOnceWith(FUTO);
      expect(clients.get(FUTO)!.graphql).toHaveBeenCalledTimes(2);
      expect(app.octokit.paginate).toHaveBeenCalledExactlyOnceWith('GET /app/installations', { per_page: 100 });
    });

    it('should list the installations again once the list is ten minutes old, for a new installation', async () => {
      vitest.useFakeTimers();
      const { app } = install(Promise.resolve([{ id: CONFIGURED, account: { login: 'immich-app' } }]));
      await sut.getStarCount('futo-org', 'fhs-core');
      vitest.advanceTimersByTime(9 * 60 * 1000);
      await sut.getStarCount('futo-org', 'fhs-core');
      expect(app.octokit.paginate).toHaveBeenCalledOnce();

      app.octokit.paginate.mockReturnValue(installed());
      vitest.advanceTimersByTime(60 * 1000);
      await sut.getStarCount('futo-org', 'fhs-core');

      expect(app.octokit.paginate).toHaveBeenCalledTimes(2);
      expect(app.getInstallationOctokit).toHaveBeenCalledExactlyOnceWith(FUTO);
    });

    it('should list the installations again once the list is ten minutes old, for a reinstalled one', async () => {
      vitest.useFakeTimers();
      const { app, clients } = install(installed());
      await sut.getStarCount('futo-org', 'fhs-core');

      app.octokit.paginate.mockReturnValue(installed(5));
      vitest.advanceTimersByTime(10 * 60 * 1000);
      await sut.getStarCount('futo-org', 'fhs-core');

      expect(app.getInstallationOctokit).toHaveBeenNthCalledWith(2, 5);
      expect(clients.get(5)!.graphql).toHaveBeenCalledOnce();
    });

    it('should keep the last list, and say so, when listing the installations again fails', async () => {
      vitest.useFakeTimers();
      const warn = vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const { app, configured, clients } = install(installed());
      await sut.getStarCount('futo-org', 'fhs-core');

      app.octokit.paginate.mockReturnValue(Promise.reject(new Error('Service unavailable')));
      vitest.advanceTimersByTime(10 * 60 * 1000);
      await sut.getStarCount('futo-org', 'fhs-core');

      expect(app.octokit.paginate).toHaveBeenCalledTimes(2);
      expect(clients.get(FUTO)!.graphql).toHaveBeenCalledTimes(2);
      expect(configured.graphql).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "Could not list the GitHub App's installations, so the last list stays: Error: Service unavailable",
      );
    });

    it('should say the configured installation reads every owner while no list has been read', async () => {
      vitest.useFakeTimers();
      const warn = vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const { app, configured } = install(Promise.reject(new Error('Bad credentials')));
      await sut.getStarCount('futo-org', 'fhs-core');

      app.octokit.paginate.mockReturnValue(Promise.reject(new Error('Bad credentials')));
      vitest.advanceTimersByTime(10 * 60 * 1000);
      await sut.getStarCount('futo-org', 'fhs-core');

      expect(configured.graphql).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenLastCalledWith(
        "Could not list the GitHub App's installations, so the configured one reads every owner: Error: Bad credentials",
      );
    });

    it('should read with the configured installation, and say so once, when the installations cannot be listed', async () => {
      const warn = vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const { configured } = install(Promise.reject(new Error('Bad credentials')));

      await sut.getStarCount('futo-org', 'fhs-core');
      await sut.getStarCount('futo-org', 'fhs-core');

      expect(configured.graphql).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "Could not list the GitHub App's installations, so the configured one reads every owner: Error: Bad credentials",
      );
    });
  });
});
