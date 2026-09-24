import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { ZulipExpander } from 'src/schema';
import { ZulipExpanderKind } from 'src/schema/tables/zulip-expander.table';
import { ZulipExpanderService } from 'src/services/zulip-expander.service';
import { beforeEach, describe, expect, it, Mocked, vitest } from 'vitest';

const row = (streamId: number, expander: ZulipExpanderKind): ZulipExpander => ({
  streamId,
  expander,
  createdBy: 'migration',
  createdAt: new Date(0),
});

describe(ZulipExpanderService.name, () => {
  let database: Mocked<Pick<IDatabaseRepository, 'getZulipExpanders' | 'addZulipExpanders' | 'removeZulipExpanders'>>;
  let sut: ZulipExpanderService;

  beforeEach(async () => {
    database = {
      getZulipExpanders: vitest.fn().mockResolvedValue([row(107, 'twitter'), row(54, 'github'), row(107, 'github')]),
      addZulipExpanders: vitest.fn(),
      removeZulipExpanders: vitest.fn(),
    };
    sut = new ZulipExpanderService(database as unknown as IDatabaseRepository);
    await sut.init();
  });

  it('should know no stream before init', () => {
    const fresh = new ZulipExpanderService(database as unknown as IDatabaseRepository);

    expect(fresh.list()).toEqual([]);
    expect(fresh.isEnabled(107, 'github')).toBe(false);
  });

  it('should load the table once, at init, and answer from the cache', () => {
    expect(sut.isEnabled(107, 'github')).toBe(true);
    expect(sut.isEnabled(107, 'twitter')).toBe(true);
    expect(sut.isEnabled(54, 'github')).toBe(true);
    expect(sut.isEnabled(54, 'twitter')).toBe(false);
    expect(sut.isEnabled(999, 'github')).toBe(false);
    expect(database.getZulipExpanders).toHaveBeenCalledOnce();
  });

  it('should list every stream with an expander on, by stream ID, the expanders in a fixed order', () => {
    expect(sut.list()).toEqual([
      { streamId: 54, expanders: ['github'] },
      { streamId: 107, expanders: ['github', 'twitter'] },
    ]);
    expect(sut.enabledIn(107)).toEqual(['github', 'twitter']);
    expect(sut.enabledIn(999)).toEqual([]);
  });

  it('should enable, resolve to what the table took and cache it at once', async () => {
    database.addZulipExpanders.mockResolvedValue([row(54, 'twitter')]);

    expect(await sut.enable(54, ['github', 'twitter'], 'Alice on Zulip (user 12)')).toEqual(['twitter']);

    expect(database.addZulipExpanders).toHaveBeenCalledExactlyOnceWith(
      54,
      ['github', 'twitter'],
      'Alice on Zulip (user 12)',
    );
    expect(sut.isEnabled(54, 'twitter')).toBe(true);
    expect(sut.enabledIn(54)).toEqual(['github', 'twitter']);
    expect(database.getZulipExpanders).toHaveBeenCalledOnce();
  });

  it('should disable, resolve to what the table removed and drop a stream left with nothing', async () => {
    database.removeZulipExpanders.mockResolvedValueOnce([row(107, 'twitter')]);
    expect(await sut.disable(107, ['twitter'])).toEqual(['twitter']);
    expect(sut.enabledIn(107)).toEqual(['github']);

    database.removeZulipExpanders.mockResolvedValueOnce([row(54, 'github')]);
    expect(await sut.disable(54, ['github', 'twitter'])).toEqual(['github']);

    expect(database.removeZulipExpanders).toHaveBeenLastCalledWith(54, ['github', 'twitter']);
    expect(sut.list()).toEqual([{ streamId: 107, expanders: ['github'] }]);
  });

  it('should leave the cache as it was when the table refuses a change', async () => {
    database.addZulipExpanders.mockRejectedValue(new Error('connection terminated'));

    await expect(sut.enable(999, ['github'], 'Alice')).rejects.toThrow('connection terminated');

    expect(sut.isEnabled(999, 'github')).toBe(false);
  });
});
