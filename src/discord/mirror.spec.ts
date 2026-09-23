import { Logger } from '@nestjs/common';
import { AnyThreadChannel, ChannelType, Collection, Message, TextBasedChannel } from 'discord.js';
import { MetadataStorage } from 'discordx';
import { DiscordMirrorEvents } from 'src/discord/mirror';
import { isMirrorCandidate, mirrorLocation, toDiscordSourceMessage } from 'src/mirror/discord-message';
import { MirrorService } from 'src/services/mirror.service';
import { afterEach, beforeEach, describe, expect, it, Mocked, vitest } from 'vitest';

vitest.mock('src/mirror/discord-message', () => ({
  isMirrorCandidate: vitest.fn(),
  mirrorLocation: vitest.fn(),
  toDiscordSourceMessage: vitest.fn(),
}));

const PARENT = '100000000000000001';
const THREAD = '200000000000000001';
const dto = { id: '300000000000000001' };

const guildChannel = { id: THREAD, isDMBased: () => false } as unknown as TextBasedChannel;
const thread = (overrides: Record<string, unknown> = {}) =>
  ({
    id: THREAD,
    name: 'Crash',
    parentId: PARENT,
    type: ChannelType.PublicThread,
    ...overrides,
  }) as unknown as AnyThreadChannel;

describe(DiscordMirrorEvents.name, () => {
  let sut: DiscordMirrorEvents;
  let mirror: Mocked<
    Pick<
      MirrorService,
      | 'handlesChannel'
      | 'onDiscordMessage'
      | 'onDiscordMessageEdited'
      | 'onDiscordMessagesDeleted'
      | 'onDiscordThreadRenamed'
      | 'onDiscordThreadDeleted'
      | 'onDiscordReady'
      | 'onDiscordDisconnected'
      | 'onDiscordResumed'
    >
  >;

  beforeEach(() => {
    vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    mirror = {
      handlesChannel: vitest.fn((channelId: string) => channelId === PARENT),
      onDiscordMessage: vitest.fn(),
      onDiscordMessageEdited: vitest.fn(),
      onDiscordMessagesDeleted: vitest.fn(),
      onDiscordThreadRenamed: vitest.fn(),
      onDiscordThreadDeleted: vitest.fn(),
      onDiscordReady: vitest.fn().mockResolvedValue(undefined),
      onDiscordDisconnected: vitest.fn(),
      onDiscordResumed: vitest.fn(),
    };
    vitest.mocked(isMirrorCandidate).mockReturnValue(true);
    vitest.mocked(mirrorLocation).mockReturnValue({ channelId: PARENT, threadId: THREAD, threadName: 'Crash' });
    vitest.mocked(toDiscordSourceMessage).mockReturnValue(dto as ReturnType<typeof toDiscordSourceMessage>);
    sut = new DiscordMirrorEvents(mirror as unknown as MirrorService);
  });

  afterEach(() => {
    vitest.restoreAllMocks();
  });

  const message = { id: dto.id, channel: guildChannel } as unknown as Message<true>;

  it('should run every message and thread handler before the default ones', () => {
    const handlers = MetadataStorage.instance.events.filter(({ classRef }) => classRef === DiscordMirrorEvents);
    expect(Object.fromEntries(handlers.map(({ event, priority }) => [event, priority]))).toEqual({
      messageCreate: 0,
      messageUpdate: 0,
      messageDelete: 0,
      messageDeleteBulk: 0,
      threadUpdate: 0,
      threadDelete: 0,
      shardReady: Number.MAX_SAFE_INTEGER,
      shardReconnecting: Number.MAX_SAFE_INTEGER,
      shardDisconnect: Number.MAX_SAFE_INTEGER,
      shardResume: Number.MAX_SAFE_INTEGER,
    });
  });

  it('should pass a mirror candidate in a mirrored channel on', () => {
    sut.onMessageCreate([message]);
    sut.onMessageUpdate([message, message]);

    expect(mirrorLocation).toHaveBeenCalledWith(guildChannel);
    expect(mirror.onDiscordMessage).toHaveBeenCalledExactlyOnceWith(dto);
    expect(mirror.onDiscordMessageEdited).toHaveBeenCalledExactlyOnceWith(dto);
  });

  it('should drop a message that is not a mirror candidate', () => {
    vitest.mocked(isMirrorCandidate).mockReturnValue(false);

    sut.onMessageCreate([message]);
    sut.onMessageUpdate([message, message]);

    expect(mirror.onDiscordMessage).not.toHaveBeenCalled();
    expect(mirror.onDiscordMessageEdited).not.toHaveBeenCalled();
  });

  it('should drop a message in a channel that is not mirrored', () => {
    vitest
      .mocked(mirrorLocation)
      .mockReturnValue({ channelId: '100000000000000555', threadId: null, threadName: null });

    sut.onMessageCreate([message]);

    expect(mirror.onDiscordMessage).not.toHaveBeenCalled();
  });

  it('should pass deletions on by ID', () => {
    sut.onMessageDelete([message]);
    sut.onMessageDeleteBulk([
      new Collection([
        ['1', message],
        ['2', message],
      ]),
      guildChannel,
    ] as never);

    expect(mirror.onDiscordMessagesDeleted.mock.calls).toEqual([
      [PARENT, [dto.id]],
      [PARENT, ['1', '2']],
    ]);
  });

  it.each([
    ['an uncached channel', null],
    ['a direct message', { isDMBased: () => true }],
  ])('should drop a deletion in %s', (_, channel) => {
    sut.onMessageDelete([{ id: dto.id, channel } as unknown as Message<true>]);

    expect(mirror.onDiscordMessagesDeleted).not.toHaveBeenCalled();
  });

  it('should pass a thread rename on', () => {
    sut.onThreadUpdate([thread(), thread({ name: 'Crash on start' })]);

    expect(mirror.onDiscordThreadRenamed).toHaveBeenCalledExactlyOnceWith({
      channelId: PARENT,
      threadId: THREAD,
      name: 'Crash on start',
    });
  });

  it.each([
    ['keeps its name', {}],
    ['is private', { name: 'Crash on start', type: ChannelType.PrivateThread }],
    ['is outside a mirrored channel', { name: 'Crash on start', parentId: '100000000000000555' }],
    ['has no parent', { name: 'Crash on start', parentId: null }],
  ])('should ignore an update of a thread that %s', (_, overrides) => {
    sut.onThreadUpdate([thread(), thread(overrides)]);

    expect(mirror.onDiscordThreadRenamed).not.toHaveBeenCalled();
  });

  it('should pass a thread deletion on', () => {
    sut.onThreadDelete([thread()]);
    sut.onThreadDelete([thread({ parentId: '100000000000000555' })]);

    expect(mirror.onDiscordThreadDeleted).toHaveBeenCalledExactlyOnceWith({ channelId: PARENT, threadId: THREAD });
  });

  it('should check the Discord channels on every new gateway session and log a failure', async () => {
    mirror.onDiscordReady.mockRejectedValueOnce(new Error('boom'));

    sut.onShardReady();
    await Promise.resolve();
    await Promise.resolve();

    expect(mirror.onDiscordReady).toHaveBeenCalledOnce();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'The Discord-Zulip mirror could not check its Discord channels',
      expect.any(Error),
    );
  });

  it('should tell the mirror as soon as the gateway connection drops, and when it resumes', () => {
    sut.onShardReconnecting();
    sut.onShardDisconnect();
    expect(mirror.onDiscordDisconnected).toHaveBeenCalledTimes(2);
    expect(mirror.onDiscordResumed).not.toHaveBeenCalled();

    sut.onShardResume();
    expect(mirror.onDiscordResumed).toHaveBeenCalledOnce();
  });

  it('should log a handler that throws instead of passing it to discordx', () => {
    vitest.mocked(toDiscordSourceMessage).mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => sut.onMessageCreate([message])).not.toThrow();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'The Discord-Zulip mirror failed on messageCreate',
      expect.any(Error),
    );
  });
});
