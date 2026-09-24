import { Logger } from '@nestjs/common';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { ZulipExpander } from 'src/schema';
import { ZulipExpanderService } from 'src/services/zulip-expander.service';
import { beforeEach, describe, expect, it, Mocked, vitest } from 'vitest';

const row = (streamId: number): ZulipExpander => ({ streamId, createdBy: 'migration', createdAt: new Date(0) });

describe(ZulipExpanderService.name, () => {
  let database: Mocked<Pick<IDatabaseRepository, 'getZulipExpanders' | 'addZulipExpander' | 'removeZulipExpander'>>;
  let sut: ZulipExpanderService;

  let table: ZulipExpander[];

  beforeEach(async () => {
    table = [row(107), row(54)];
    database = {
      getZulipExpanders: vitest.fn(async () => [...table]),
      addZulipExpander: vitest.fn(async (streamId) => {
        if (table.some((existing) => existing.streamId === streamId)) {
          return false;
        }
        table.push(row(streamId));
        return true;
      }),
      removeZulipExpander: vitest.fn(async (streamId) => {
        const before = table.length;
        table = table.filter((existing) => existing.streamId !== streamId);
        return table.length !== before;
      }),
    };
    sut = new ZulipExpanderService(database as unknown as IDatabaseRepository);
    await sut.init();
  });

  it('should know no stream before init', () => {
    const fresh = new ZulipExpanderService(database as unknown as IDatabaseRepository);

    expect(fresh.list()).toEqual([]);
    expect(fresh.isEnabled(107)).toBe(false);
  });

  it('should load the table once, at init, and answer from the cache', () => {
    expect(sut.isEnabled(107)).toBe(true);
    expect(sut.isEnabled(54)).toBe(true);
    expect(sut.isEnabled(999)).toBe(false);
    expect(database.getZulipExpanders).toHaveBeenCalledOnce();
  });

  it('should list the streams by ID', () => {
    expect(sut.list()).toEqual([54, 107]);
  });

  it('should enable, resolve to whether the table took it and cache it at once', async () => {
    expect(await sut.enable(120, 'Alice on Zulip (user 12)')).toBe(true);
    expect(await sut.enable(120, 'Alice on Zulip (user 12)')).toBe(false);

    expect(database.addZulipExpander).toHaveBeenCalledWith(120, 'Alice on Zulip (user 12)');
    expect(sut.isEnabled(120)).toBe(true);
    expect(sut.list()).toEqual([54, 107, 120]);
  });

  it('should disable, resolve to whether the table had it and drop it at once', async () => {
    expect(await sut.disable(107)).toBe(true);
    expect(await sut.disable(107)).toBe(false);

    expect(database.removeZulipExpander).toHaveBeenLastCalledWith(107);
    expect(sut.isEnabled(107)).toBe(false);
    expect(sut.list()).toEqual([54]);
  });

  it('should leave the cache as it was when the table refuses a change', async () => {
    database.addZulipExpander.mockRejectedValue(new Error('connection terminated'));

    await expect(sut.enable(999, 'Alice')).rejects.toThrow('connection terminated');

    expect(sut.isEnabled(999)).toBe(false);
  });

  it('should run a change after one still writing, so the cache ends as the table does', async () => {
    let finishAdd = () => {};
    const add = database.addZulipExpander.getMockImplementation()!;
    database.addZulipExpander.mockImplementationOnce(
      (...args) => new Promise((resolve) => (finishAdd = () => resolve(add(...args)))),
    );

    const enabling = sut.enable(120, 'Alice');
    const disabling = sut.disable(120);
    await Promise.resolve();
    expect(database.removeZulipExpander).not.toHaveBeenCalled();

    finishAdd();
    expect(await enabling).toBe(true);
    expect(await disabling).toBe(true);

    expect(table.some(({ streamId }) => streamId === 120)).toBe(false);
    expect(sut.isEnabled(120)).toBe(false);
  });

  it('should cache a change as the table reported it when reading the table back fails', async () => {
    vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    database.getZulipExpanders.mockRejectedValueOnce(new Error('connection terminated'));
    expect(await sut.enable(120, 'Alice')).toBe(true);
    expect(sut.isEnabled(120)).toBe(true);

    database.getZulipExpanders.mockRejectedValueOnce(new Error('connection terminated'));
    expect(await sut.disable(107)).toBe(true);
    expect(sut.isEnabled(107)).toBe(false);
    expect(sut.list()).toEqual([54, 120]);
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(2);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'Could not read the Zulip expanders of stream 107 back, so the change is cached as the table reported it',
      expect.any(Error),
    );
  });
});
