import { Logger } from '@nestjs/common';
import { GithubRepository } from 'src/repositories/github.repository';
import { beforeEach, describe, expect, it, vitest } from 'vitest';

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
});
