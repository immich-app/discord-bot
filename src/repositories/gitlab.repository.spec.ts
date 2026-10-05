import { Logger } from '@nestjs/common';
import { GitlabRepository } from 'src/repositories/gitlab.repository';
import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

const config = { gitlab: { token: undefined as string | undefined } };

vitest.mock('src/config', () => ({ getConfig: () => config }));

const API = 'https://gitlab.futo.org/api/v4';

describe(GitlabRepository.name, () => {
  let fetchMock: ReturnType<typeof vitest.fn>;

  const respond = (status: number, body: unknown) =>
    fetchMock.mockResolvedValueOnce(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

  beforeEach(() => {
    config.gitlab.token = undefined;
    fetchMock = vitest.fn();
    vitest.stubGlobal('fetch', fetchMock);
    vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vitest.unstubAllGlobals();
  });

  describe('getProjectPath', () => {
    it('should ask for the project by its encoded path, without a token when none is set', async () => {
      respond(200, { path_with_namespace: 'videostreaming/Grayjay.Desktop' });

      expect(await new GitlabRepository().getProjectPath('videostreaming/grayjay.desktop')).toBe(
        'videostreaming/Grayjay.Desktop',
      );
      expect(fetchMock).toHaveBeenCalledWith(`${API}/projects/videostreaming%2Fgrayjay.desktop`, {
        headers: {},
        signal: expect.any(AbortSignal),
      });
    });

    it('should send the token when one is set', async () => {
      config.gitlab.token = 'secret';
      respond(200, { path_with_namespace: 'team/private' });

      await new GitlabRepository().getProjectPath('team/private');

      expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { 'PRIVATE-TOKEN': 'secret' } });
    });

    it.each([401, 403, 404])('should resolve to undefined when GitLab answers %s', async (status) => {
      respond(status, { message: 'nope' });

      expect(await new GitlabRepository().getProjectPath('team/private')).toBeUndefined();
    });

    it('should throw when GitLab fails otherwise, so the command can say so', async () => {
      respond(502, 'Bad Gateway');

      await expect(new GitlabRepository().getProjectPath('team/project')).rejects.toThrow(
        'GitLab answered 502 for /projects/team%2Fproject',
      );
    });
  });

  describe('getItem', () => {
    it('should read an issue or a merge request', async () => {
      respond(200, {
        title: 'Fixed downloaded UMP casting',
        web_url: 'https://gitlab.futo.org/videostreaming/grayjay/-/merge_requests/194',
        updated_at: '2026-09-24T18:18:50.893Z',
      });

      expect(await new GitlabRepository().getItem('videostreaming/grayjay', 'merge_requests', 194)).toEqual({
        kind: 'merge_requests',
        title: 'Fixed downloaded UMP casting',
        url: 'https://gitlab.futo.org/videostreaming/grayjay/-/merge_requests/194',
        updatedAt: new Date('2026-09-24T18:18:50.893Z'),
      });
      expect(fetchMock.mock.calls[0][0]).toBe(`${API}/projects/videostreaming%2Fgrayjay/merge_requests/194`);
    });

    it('should resolve to undefined when there is none', async () => {
      respond(404, { message: '404 Not found' });

      expect(await new GitlabRepository().getItem('videostreaming/grayjay', 'issues', 999)).toBeUndefined();
    });

    it('should log and resolve to undefined when GitLab cannot be reached, so the other expansions still post', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

      expect(await new GitlabRepository().getItem('videostreaming/grayjay', 'issues', 1)).toBeUndefined();
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        'Could not fetch GitLab issues 1 of videostreaming/grayjay',
        expect.any(TypeError),
      );
    });
  });

  describe('getFileContent', () => {
    it('should read the raw file at the ref, its path encoded', async () => {
      respond(200, 'one\ntwo\nthree');

      expect(await new GitlabRepository().getFileContent('videostreaming/grayjay', 'master', 'app/src/a b.kt')).toEqual(
        ['one', 'two', 'three'],
      );
      expect(fetchMock.mock.calls[0][0]).toBe(
        `${API}/projects/videostreaming%2Fgrayjay/repository/files/app%2Fsrc%2Fa%20b.kt/raw?ref=master`,
      );
    });

    it('should not read a file GitLab says is over 1 MB', async () => {
      const body = new ReadableStream({ start: (controller) => controller.enqueue(new Uint8Array(10)) });
      const cancel = vitest.spyOn(body, 'cancel');
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-length': '1000001' } }));

      expect(
        await new GitlabRepository().getFileContent('videostreaming/grayjay', 'master', 'big.bin'),
      ).toBeUndefined();
      expect(cancel).toHaveBeenCalled();
    });

    it('should stop reading a file without a length once it passes 1 MB', async () => {
      let pulls = 0;
      const body = new ReadableStream({
        pull: (controller) => {
          pulls++;
          controller.enqueue(new Uint8Array(400_000));
        },
      });
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));

      expect(
        await new GitlabRepository().getFileContent('videostreaming/grayjay', 'master', 'big.bin'),
      ).toBeUndefined();
      expect(pulls).toBeLessThanOrEqual(4);
    });

    it('should resolve to undefined when there is no such file, or GitLab fails', async () => {
      respond(404, { message: '404 File Not Found' });
      respond(500, 'oops');

      const sut = new GitlabRepository();
      expect(await sut.getFileContent('videostreaming/grayjay', 'master', 'missing.kt')).toBeUndefined();
      expect(await sut.getFileContent('videostreaming/grayjay', 'master', 'broken.kt')).toBeUndefined();
    });
  });

  describe('getGroupProjects', () => {
    const projects = (count: number, from = 0) =>
      Array.from({ length: count }, (_, index) => ({ path_with_namespace: `team/sub/p${from + index}` }));

    it("should read the group, then every page of its projects and its subgroups'", async () => {
      respond(200, { id: 46, full_path: 'Team' });
      respond(200, projects(100));
      respond(200, projects(2, 100));

      const found = await new GitlabRepository().getGroupProjects('team');

      expect(found?.path).toBe('Team');
      expect(found?.projects).toHaveLength(102);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `${API}/groups/team`,
        `${API}/groups/46/projects?include_subgroups=true&simple=true&order_by=path&sort=asc&per_page=100&page=1`,
        `${API}/groups/46/projects?include_subgroups=true&simple=true&order_by=path&sort=asc&per_page=100&page=2`,
      ]);
    });

    it('should resolve to undefined when there is no such group, or it cannot be seen', async () => {
      respond(404, { message: '404 Group Not Found' });

      expect(await new GitlabRepository().getGroupProjects('nope')).toBeUndefined();
    });

    it('should stop after 20 pages', async () => {
      respond(200, { id: 1, full_path: 'big' });
      for (let page = 0; page < 25; page++) {
        respond(200, projects(100, page * 100));
      }

      expect((await new GitlabRepository().getGroupProjects('big'))?.projects).toHaveLength(2000);
    });

    it('should throw when a page of projects cannot be seen, rather than pass a list cut short for the whole', async () => {
      respond(200, { id: 1, full_path: 'team' });
      respond(200, projects(100));
      respond(403, { message: '403 Forbidden' });

      await expect(new GitlabRepository().getGroupProjects('team')).rejects.toThrow(
        'GitLab did not show page 2 of the projects of group team',
      );
    });

    it('should throw when GitLab fails, so a refresh keeps what it had', async () => {
      respond(200, { id: 1, full_path: 'team' });
      respond(502, 'Bad Gateway');

      await expect(new GitlabRepository().getGroupProjects('team')).rejects.toThrow('GitLab answered 502');
    });
  });
});
