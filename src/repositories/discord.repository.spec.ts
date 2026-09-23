import {
  ChannelType,
  Collection,
  DiscordAPIError,
  HTTPError,
  MessageFlags,
  MessageFlagsBitField,
  MessageType,
  PermissionFlagsBits,
  PermissionsBitField,
  ThreadAutoArchiveDuration,
  WebhookClient,
} from 'discord.js';
import { inspect } from 'node:util';
import { Constants } from 'src/constants';
import { DiscordMirrorError } from 'src/interfaces/discord-mirror.interface';
import { DiscordRepository } from 'src/repositories/discord.repository';
import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

const bot = vitest.hoisted(() => ({
  once: vitest.fn(),
  on: vitest.fn(),
  isReady: vitest.fn(),
  user: null as { id: string; displayAvatarURL: (options: unknown) => string } | null,
  channels: { fetch: vitest.fn() },
  guilds: { cache: new Map<string, unknown>() },
}));

const webhookClients = vitest.hoisted(() => new Map<string, object>());

vitest.mock('discordx', () => ({
  Client: vitest.fn(function () {
    return bot;
  }),
}));

vitest.mock('discord.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('discord.js')>()),
  WebhookClient: vitest.fn(function ({ id }: { id: string }) {
    return webhookClients.get(id);
  }),
}));

const guildId = Constants.Discord.Servers[0];
const channelId = '100000000000000001';
const threadId = '200000000000000001';
const categoryId = '100000000000000009';
const botUserId = '600000000000000001';
const secretUrl = 'https://discord.com/api/v10/webhooks/700000000000000001/secret-token';

const apiError = (code: number, status = 400) =>
  new DiscordAPIError({ code, message: `Error ${code}` }, code, status, 'POST', secretUrl, {
    body: { content: 'secret content' },
  });

/** What @discordjs/rest hands on for an answer that is not Discord's JSON, such as a proxy's error page. */
const proxyPage = new ArrayBuffer(0) as unknown as ConstructorParameters<typeof DiscordAPIError>[0];

const everyone = { id: guildId };
const me = { id: botUserId };

const permissions = (...flags: bigint[]) => new PermissionsBitField(flags);

const makeChannel = (overrides: Record<string, unknown> = {}) => ({
  id: channelId,
  guildId,
  name: 'dev',
  type: ChannelType.GuildText,
  parentId: categoryId,
  isDMBased: () => false,
  isTextBased: () => true,
  isThread: () => false,
  guild: { roles: { everyone }, members: { me, fetchMe: vitest.fn() } },
  permissionsFor: vitest.fn((target: unknown) =>
    target === everyone ? permissions() : permissions(PermissionFlagsBits.Administrator),
  ),
  fetchWebhooks: vitest.fn().mockResolvedValue(new Collection()),
  createWebhook: vitest.fn(),
  threads: { create: vitest.fn() },
  messages: { delete: vitest.fn(), fetch: vitest.fn() },
  ...overrides,
});

const makeThread = (overrides: Record<string, unknown> = {}) => ({
  id: threadId,
  isThread: () => true,
  isTextBased: () => true,
  setName: vitest.fn(),
  setArchived: vitest.fn(),
  messages: { delete: vitest.fn() },
  ...overrides,
});

const makeWebhook = (id: string, overrides: Record<string, unknown> = {}) => {
  const webhook = {
    id,
    name: 'Zulip mirror',
    owner: { id: botUserId },
    token: 'secret-token',
    send: vitest.fn(),
    editMessage: vitest.fn(),
    deleteMessage: vitest.fn(),
    ...overrides,
  };
  const { send, editMessage, deleteMessage } = webhook;
  webhookClients.set(id, { id, send, editMessage, deleteMessage, destroy: vitest.fn() });
  return webhook;
};

const webhooks = (...list: ReturnType<typeof makeWebhook>[]) => new Collection(list.map((w) => [w.id, w]));

const target = (overrides: Record<string, unknown> = {}) => ({
  channelId,
  threadId,
  messageId: '300000000000000001',
  webhookId: '700000000000000001',
  ...overrides,
});

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as DiscordMirrorError;
  }
  throw new Error('expected a rejection');
};

describe(DiscordRepository.name, () => {
  let sut: DiscordRepository;
  let channel: ReturnType<typeof makeChannel>;
  let webhook: ReturnType<typeof makeWebhook>;

  const resolveWebhook = async () => {
    channel.fetchWebhooks.mockResolvedValue(webhooks(webhook));
    await sut.ensureMirrorWebhook(channelId);
  };

  beforeEach(() => {
    vitest.clearAllMocks();
    bot.once.mockReturnValue(bot);
    bot.on.mockReturnValue(bot);
    bot.user = {
      id: botUserId,
      displayAvatarURL: vitest.fn().mockReturnValue('https://cdn.discordapp.com/avatars/bot.png'),
    };
    bot.guilds.cache.clear();
    webhookClients.clear();
    channel = makeChannel();
    webhook = makeWebhook('700000000000000001');
    bot.channels.fetch.mockResolvedValue(channel);
    vitest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    sut = new DiscordRepository();
  });

  afterEach(() => {
    vitest.useRealTimers();
    vitest.restoreAllMocks();
  });

  describe('isReady', () => {
    it('should report whether the client is ready', () => {
      bot.isReady.mockReturnValue(true);
      expect(sut.isReady()).toBe(true);
    });
  });

  describe('getMirrorChannel', () => {
    it('should describe a private text channel', async () => {
      await expect(sut.getMirrorChannel(channelId)).resolves.toEqual({
        id: channelId,
        guildId,
        name: 'dev',
        kind: 'text',
        everyoneCanView: false,
        missingPermissions: [],
      });
      expect(channel.permissionsFor).toHaveBeenCalledWith(me);
    });

    it('should report the permissions the bot lacks, with thread creation for text channels', async () => {
      channel.permissionsFor.mockImplementation((who: unknown) =>
        who === everyone ? permissions(PermissionFlagsBits.ViewChannel) : permissions(PermissionFlagsBits.ViewChannel),
      );

      const described = await sut.getMirrorChannel(channelId);

      expect(described?.everyoneCanView).toBe(true);
      expect(described?.missingPermissions.toSorted()).toEqual(
        [
          'AttachFiles',
          'CreatePublicThreads',
          'EmbedLinks',
          'ManageMessages',
          'ManageThreads',
          'ManageWebhooks',
          'ReadMessageHistory',
          'SendMessages',
          'SendMessagesInThreads',
        ].toSorted(),
      );
    });

    it('should not ask for thread creation in a forum', async () => {
      channel.type = ChannelType.GuildForum;
      channel.permissionsFor.mockReturnValue(permissions(PermissionFlagsBits.ViewChannel));

      const described = await sut.getMirrorChannel(channelId);

      expect(described?.kind).toBe('forum');
      expect(described?.missingPermissions).not.toContain('CreatePublicThreads');
      expect(described?.missingPermissions).toContain('ManageWebhooks');
    });

    it('should describe other channel types as other', async () => {
      channel.type = ChannelType.GuildVoice;
      await expect(sut.getMirrorChannel(channelId)).resolves.toMatchObject({ kind: 'other' });
    });

    it('should fetch the bot member when it is not cached', async () => {
      channel.guild.members = { me: null, fetchMe: vitest.fn().mockResolvedValue(me) } as never;
      await expect(sut.getMirrorChannel(channelId)).resolves.toMatchObject({ missingPermissions: [] });
    });

    it.each([
      ['an unknown channel', () => bot.channels.fetch.mockRejectedValue(apiError(10_003, 404))],
      ['no channel', () => bot.channels.fetch.mockResolvedValue(null)],
      ['a direct message channel', () => bot.channels.fetch.mockResolvedValue({ isDMBased: () => true })],
    ])('should return undefined for %s', async (_, arrange) => {
      arrange();
      await expect(sut.getMirrorChannel(channelId)).resolves.toBeUndefined();
    });

    it('should map a missing access error', async () => {
      bot.channels.fetch.mockRejectedValue(apiError(50_001, 403));
      await expect(sut.getMirrorChannel(channelId)).rejects.toMatchObject({ kind: 'forbidden', code: 50_001 });
    });
  });

  describe('ensureMirrorWebhook', () => {
    it('should reuse the oldest webhook the bot owns, whatever its name', async () => {
      const newer = makeWebhook('700000000000000009');
      const older = makeWebhook('70000000000000002', { name: 'Renamed by an admin' });
      const someoneElses = makeWebhook('70000000000000001', { owner: { id: '1' } });
      const follower = makeWebhook('7000000000000001', { token: null });
      channel.fetchWebhooks.mockResolvedValue(webhooks(newer, someoneElses, follower, older));
      older.send.mockResolvedValue({ id: '300000000000000005', channel_id: channelId });

      await sut.ensureMirrorWebhook(channelId);
      await sut.sendMirrorMessage({ channelId, username: 'A', content: 'x', pingUserIds: [], suppressEmbeds: false });

      expect(channel.createWebhook).not.toHaveBeenCalled();
      expect(older.send).toHaveBeenCalledOnce();
      expect(newer.send).not.toHaveBeenCalled();
    });

    it("should create a webhook with the bot's avatar when the bot owns none", async () => {
      const fetchMock = vitest
        .mocked(fetch)
        .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
      channel.createWebhook.mockResolvedValue(webhook);

      await sut.ensureMirrorWebhook(channelId);

      expect(channel.createWebhook).toHaveBeenCalledWith({
        name: 'Zulip mirror',
        avatar: 'data:image/png;base64,AQID',
        reason: 'Discord-Zulip mirror',
      });
      expect(bot.user?.displayAvatarURL).toHaveBeenCalledWith({ extension: 'png', size: 256 });
      expect(fetchMock).toHaveBeenCalledWith('https://cdn.discordapp.com/avatars/bot.png', {
        signal: expect.any(AbortSignal),
      });
    });

    it.each([
      ['an error page', () => new Response('<html>', { status: 503, headers: { 'content-type': 'text/html' } })],
      ['something that is no image', () => new Response('<html>', { headers: { 'content-type': 'text/html' } })],
      [
        'a timeout',
        () => {
          throw new DOMException('The operation timed out.', 'TimeoutError');
        },
      ],
    ])('should create the webhook without an avatar when the download gets %s', async (_, answer) => {
      vitest.mocked(fetch).mockImplementation(async () => answer());
      channel.createWebhook.mockResolvedValue(webhook);

      await sut.ensureMirrorWebhook(channelId);

      expect(channel.createWebhook).toHaveBeenCalledWith(expect.objectContaining({ avatar: undefined }));
    });

    it('should work in a forum', async () => {
      channel.type = ChannelType.GuildForum;
      await resolveWebhook();
      expect(channel.fetchWebhooks).toHaveBeenCalledOnce();
    });

    it('should do nothing once the webhook is known', async () => {
      await resolveWebhook();
      await sut.ensureMirrorWebhook(channelId);
      expect(channel.fetchWebhooks).toHaveBeenCalledOnce();
    });

    it.each([
      [50_013, 'forbidden'],
      [50_001, 'forbidden'],
      [30_007, 'max-webhooks'],
    ])('should remember a %s failure for 10 minutes', async (code, kind) => {
      vitest.useFakeTimers();
      channel.fetchWebhooks.mockRejectedValue(apiError(code, 403));

      await expect(sut.ensureMirrorWebhook(channelId)).rejects.toMatchObject({ kind, code });
      vitest.advanceTimersByTime(10 * 60 * 1000 - 1);
      await expect(sut.ensureMirrorWebhook(channelId)).rejects.toMatchObject({ kind, code });
      await expect(
        sut.sendMirrorMessage({ channelId, username: 'A', content: 'x', pingUserIds: [], suppressEmbeds: false }),
      ).rejects.toMatchObject({ kind, code });
      expect(channel.fetchWebhooks).toHaveBeenCalledOnce();

      vitest.advanceTimersByTime(1);
      channel.fetchWebhooks.mockResolvedValue(webhooks(webhook));
      await sut.ensureMirrorWebhook(channelId);
      expect(channel.fetchWebhooks).toHaveBeenCalledTimes(2);
    });

    it('should not remember other failures', async () => {
      channel.fetchWebhooks.mockRejectedValueOnce(new HTTPError(502, 'Bad Gateway', 'GET', secretUrl, {}));

      await expect(sut.ensureMirrorWebhook(channelId)).rejects.toMatchObject({ kind: 'unavailable' });
      await resolveWebhook();
      expect(channel.fetchWebhooks).toHaveBeenCalledTimes(2);
    });

    it('should refuse a created webhook that comes without a token', async () => {
      channel.createWebhook.mockResolvedValue(makeWebhook('700000000000000002', { token: null }));
      await expect(sut.ensureMirrorWebhook(channelId)).rejects.toMatchObject({ kind: 'other' });
      expect(WebhookClient).not.toHaveBeenCalled();
    });

    it('should refuse a channel that cannot hold webhooks', async () => {
      channel.type = ChannelType.PublicThread;
      await expect(sut.ensureMirrorWebhook(channelId)).rejects.toMatchObject({ kind: 'unknown-channel' });
    });

    it('should refuse before the client has logged in', async () => {
      bot.user = null;
      await expect(sut.ensureMirrorWebhook(channelId)).rejects.toMatchObject({ kind: 'other' });
    });
  });

  describe('sendMirrorMessage', () => {
    beforeEach(async () => {
      await resolveWebhook();
      webhook.send.mockResolvedValue({ id: '300000000000000005', channel_id: threadId });
    });

    it('should send through the webhook with no mentions but the listed users', async () => {
      const file = new File([Buffer.from('log line')], 'server.log', { type: 'text/plain' });

      await expect(
        sut.sendMirrorMessage({
          channelId,
          threadId,
          username: 'Alex',
          avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png?size=256',
          content: 'hello',
          files: [file],
          pingUserIds: ['400000000000000001'],
          suppressEmbeds: true,
        }),
      ).resolves.toEqual({ messageId: '300000000000000005', channelId: threadId, webhookId: webhook.id });

      expect(webhook.send).toHaveBeenCalledWith({
        content: 'hello',
        username: 'Alex',
        avatarURL: 'https://cdn.discordapp.com/avatars/1/a.png?size=256',
        threadId,
        files: [{ attachment: Buffer.from('log line'), name: 'server.log' }],
        allowedMentions: { parse: [], roles: [], users: ['400000000000000001'], repliedUser: false },
        flags: [MessageFlags.SuppressEmbeds],
      });
    });

    it('should leave out what is not given', async () => {
      await sut.sendMirrorMessage({
        channelId,
        username: 'Zulip User (Zulip)',
        content: 'hello',
        pingUserIds: [],
        suppressEmbeds: false,
      });

      expect(webhook.send).toHaveBeenCalledWith({
        content: 'hello',
        username: 'Zulip User (Zulip)',
        files: [],
        allowedMentions: { parse: [], roles: [], users: [], repliedUser: false },
        flags: [],
      });
    });

    it('should name a new forum post', async () => {
      await sut.sendMirrorMessage({
        channelId,
        threadName: 'A topic',
        username: 'Alex',
        content: 'hello',
        pingUserIds: [],
        suppressEmbeds: false,
      });

      expect(webhook.send).toHaveBeenCalledWith(expect.objectContaining({ threadName: 'A topic' }));
      expect(webhook.send.mock.calls[0][0]).not.toHaveProperty('threadId');
    });

    it('should refuse to send before the webhook is known', async () => {
      await expect(
        sut.sendMirrorMessage({
          channelId: '100000000000000002',
          username: 'A',
          content: 'x',
          pingUserIds: [],
          suppressEmbeds: false,
        }),
      ).rejects.toMatchObject({ kind: 'unknown-webhook' });
    });

    it('should forget a deleted webhook', async () => {
      webhook.send.mockRejectedValue(apiError(10_015, 404));
      const send = () =>
        sut.sendMirrorMessage({ channelId, username: 'A', content: 'x', pingUserIds: [], suppressEmbeds: false });

      await expect(send()).rejects.toMatchObject({ kind: 'unknown-webhook', code: 10_015 });
      await expect(send()).rejects.toMatchObject({ kind: 'unknown-webhook', code: undefined });
      expect(webhook.send).toHaveBeenCalledOnce();

      expect(vitest.mocked(WebhookClient).mock.results[0].value.destroy).toHaveBeenCalledOnce();
      await sut.ensureMirrorWebhook(channelId);
      expect(channel.fetchWebhooks).toHaveBeenCalledTimes(2);
    });

    it.each([
      [apiError(40_005, 413), 'too-large', 40_005],
      [new DiscordAPIError(proxyPage, undefined!, 413, 'POST', secretUrl, {}), 'too-large', undefined],
      [apiError(220_001), 'forum', 220_001],
      [apiError(220_002), 'forum', 220_002],
      [apiError(220_003), 'forum', 220_003],
      [apiError(40_067), 'forum', 40_067],
      [apiError(50_083), 'archived', 50_083],
      [apiError(160_005, 403), 'locked', 160_005],
      [apiError(10_003, 404), 'unknown-channel', 10_003],
      [apiError(50_035), 'other', 50_035],
      [new HTTPError(503, 'Service Unavailable', 'POST', secretUrl, {}), 'unavailable', undefined],
      [new DOMException('This operation was aborted', 'AbortError'), 'unavailable', undefined],
      [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'unreachable', undefined],
      [Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), 'unreachable', undefined],
      [Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 'unavailable', undefined],
      [Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }), 'unavailable', undefined],
      [new TypeError('Cannot read properties of undefined'), 'other', undefined],
    ])('should map %s', async (error, kind, code) => {
      webhook.send.mockRejectedValue(error);

      const thrown = await rejection(
        sut.sendMirrorMessage({ channelId, username: 'A', content: 'x', pingUserIds: [], suppressEmbeds: false }),
      );

      expect(thrown).toBeInstanceOf(DiscordMirrorError);
      expect(thrown).toMatchObject({ kind, code });
    });

    it("should send through a client of the webhook's own, whose REST manager nobody logs", async () => {
      await sut.sendMirrorMessage({ channelId, username: 'A', content: 'x', pingUserIds: [], suppressEmbeds: false });
      await sut.editMirrorMessage(target(), { content: 'y', suppressEmbeds: false });
      await sut.deleteMirrorMessage(target());

      expect(WebhookClient).toHaveBeenCalledExactlyOnceWith({ id: webhook.id, token: 'secret-token' });
      const client = vitest.mocked(WebhookClient).mock.results[0].value;
      expect(webhook.send.mock.contexts).toEqual([client]);
      expect(webhook.editMessage.mock.contexts).toEqual([client]);
      expect(webhook.deleteMessage.mock.contexts).toEqual([client]);
    });

    it('should never pass on the webhook token or the request body', async () => {
      webhook.send.mockRejectedValue(apiError(50_013, 403));

      const thrown = await rejection(
        sut.sendMirrorMessage({ channelId, username: 'A', content: 'x', pingUserIds: [], suppressEmbeds: false }),
      );

      expect(thrown.cause).toBeUndefined();
      expect(inspect(thrown, { depth: 10 })).not.toMatch(/secret/);
    });
  });

  describe('editMirrorMessage', () => {
    beforeEach(resolveWebhook);

    it('should edit through the webhook without mentions', async () => {
      await sut.editMirrorMessage(target(), { content: 'edited', suppressEmbeds: true });

      expect(webhook.editMessage).toHaveBeenCalledWith('300000000000000001', {
        content: 'edited',
        allowedMentions: { parse: [], users: [] },
        flags: [MessageFlags.SuppressEmbeds],
        threadId,
      });
    });

    it('should edit a message in the channel itself', async () => {
      await sut.editMirrorMessage(target({ threadId: null }), { content: 'edited', suppressEmbeds: false });

      expect(webhook.editMessage).toHaveBeenCalledWith('300000000000000001', {
        content: 'edited',
        allowedMentions: { parse: [], users: [] },
        flags: [],
      });
    });

    it('should refuse a message sent by a replaced webhook', async () => {
      await expect(
        sut.editMirrorMessage(target({ webhookId: '700000000000000000' }), { content: 'x', suppressEmbeds: false }),
      ).rejects.toMatchObject({ kind: 'replaced-webhook' });
      expect(webhook.editMessage).not.toHaveBeenCalled();
    });

    it.each([
      [50_083, 'archived'],
      [160_005, 'locked'],
      [10_008, 'unknown-message'],
    ])('should map %s', async (code, kind) => {
      webhook.editMessage.mockRejectedValue(apiError(code));
      await expect(sut.editMirrorMessage(target(), { content: 'x', suppressEmbeds: false })).rejects.toMatchObject({
        kind,
        code,
      });
    });
  });

  describe('deleteMirrorMessage', () => {
    let thread: ReturnType<typeof makeThread>;

    beforeEach(() => {
      thread = makeThread();
      bot.channels.fetch.mockImplementation((id: string) => Promise.resolve(id === threadId ? thread : channel));
    });

    it('should delete through the webhook', async () => {
      await resolveWebhook();
      await sut.deleteMirrorMessage(target());

      expect(webhook.deleteMessage).toHaveBeenCalledWith('300000000000000001', threadId);
      expect(thread.messages.delete).not.toHaveBeenCalled();
    });

    it('should delete a message in the channel itself', async () => {
      await resolveWebhook();
      await sut.deleteMirrorMessage(target({ threadId: null }));

      expect(webhook.deleteMessage).toHaveBeenCalledWith('300000000000000001', undefined);
    });

    it('should delete through the bot when the message came from a replaced webhook', async () => {
      await resolveWebhook();
      await sut.deleteMirrorMessage(target({ webhookId: '700000000000000000' }));

      expect(webhook.deleteMessage).not.toHaveBeenCalled();
      expect(bot.channels.fetch).toHaveBeenLastCalledWith(threadId);
      expect(thread.messages.delete).toHaveBeenCalledWith('300000000000000001');
    });

    it('should delete through the bot when the webhook is not known', async () => {
      await sut.deleteMirrorMessage(target({ threadId: null }));
      expect(channel.messages.delete).toHaveBeenCalledWith('300000000000000001');
    });

    it('should fall back to the bot and forget the webhook once it is deleted', async () => {
      await resolveWebhook();
      webhook.deleteMessage.mockRejectedValue(apiError(10_015, 404));

      await sut.deleteMirrorMessage(target());

      expect(thread.messages.delete).toHaveBeenCalledWith('300000000000000001');
      await expect(
        sut.sendMirrorMessage({ channelId, username: 'A', content: 'x', pingUserIds: [], suppressEmbeds: false }),
      ).rejects.toMatchObject({ kind: 'unknown-webhook' });
    });

    it('should not fall back to the bot for other webhook errors', async () => {
      await resolveWebhook();
      webhook.deleteMessage.mockRejectedValue(apiError(10_008, 404));

      await expect(sut.deleteMirrorMessage(target())).rejects.toMatchObject({ kind: 'unknown-message' });
      expect(thread.messages.delete).not.toHaveBeenCalled();
    });

    it('should map bot errors', async () => {
      thread.messages.delete.mockRejectedValue(apiError(10_008, 404));
      await expect(sut.deleteMirrorMessage(target())).rejects.toMatchObject({ kind: 'unknown-message', code: 10_008 });
    });

    it('should refuse a channel without messages', async () => {
      bot.channels.fetch.mockResolvedValue({ isTextBased: () => false });
      await expect(sut.deleteMirrorMessage(target())).rejects.toMatchObject({ kind: 'unknown-channel' });
    });
  });

  describe('startMirrorThread', () => {
    it('should start a public thread from the message', async () => {
      channel.threads.create.mockResolvedValue({ id: '300000000000000001' });

      await expect(sut.startMirrorThread(channelId, '300000000000000001', 'A topic')).resolves.toBe(
        '300000000000000001',
      );
      expect(channel.threads.create).toHaveBeenCalledWith({
        startMessage: '300000000000000001',
        name: 'A topic',
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      });
    });

    it('should refuse a channel that is not a text channel', async () => {
      channel.type = ChannelType.GuildForum;
      await expect(sut.startMirrorThread(channelId, '1', 'A topic')).rejects.toMatchObject({ kind: 'unknown-channel' });
    });

    it('should map errors', async () => {
      channel.threads.create.mockRejectedValue(apiError(50_013, 403));
      await expect(sut.startMirrorThread(channelId, '1', 'A topic')).rejects.toMatchObject({
        kind: 'forbidden',
        code: 50_013,
      });
    });
  });

  describe('renameMirrorThread and unarchiveMirrorThread', () => {
    let thread: ReturnType<typeof makeThread>;

    beforeEach(() => {
      thread = makeThread();
      bot.channels.fetch.mockResolvedValue(thread);
    });

    it('should rename the thread', async () => {
      await sut.renameMirrorThread(threadId, '✔ A topic');
      expect(bot.channels.fetch).toHaveBeenCalledWith(threadId);
      expect(thread.setName).toHaveBeenCalledWith('✔ A topic');
    });

    it('should unarchive the thread', async () => {
      await sut.unarchiveMirrorThread(threadId);
      expect(thread.setArchived).toHaveBeenCalledWith(false);
    });

    it('should leave a locked thread archived', async () => {
      bot.channels.fetch.mockResolvedValue(makeThread({ locked: true }));

      await expect(sut.unarchiveMirrorThread(threadId)).rejects.toMatchObject({ kind: 'locked' });
      expect(thread.setArchived).not.toHaveBeenCalled();
    });

    it('should refuse a channel that is not a thread', async () => {
      bot.channels.fetch.mockResolvedValue(channel);
      await expect(sut.renameMirrorThread(threadId, 'x')).rejects.toMatchObject({ kind: 'unknown-channel' });
      await expect(sut.unarchiveMirrorThread(threadId)).rejects.toMatchObject({ kind: 'unknown-channel' });
    });

    it('should map errors', async () => {
      thread.setName.mockRejectedValue(apiError(50_083));
      thread.setArchived.mockRejectedValue(apiError(160_005, 403));

      await expect(sut.renameMirrorThread(threadId, 'x')).rejects.toMatchObject({ kind: 'archived' });
      await expect(sut.unarchiveMirrorThread(threadId)).rejects.toMatchObject({ kind: 'locked' });
    });
  });

  describe('getTeamMember', () => {
    const fetchMember = vitest.fn();

    beforeEach(() => {
      fetchMember.mockReset();
      bot.guilds.cache.set(guildId, { members: { fetch: fetchMember } });
    });

    it('should describe the member', async () => {
      const displayAvatarURL = vitest.fn().mockReturnValue('https://cdn.discordapp.com/avatars/4/a.png?size=256');
      fetchMember.mockResolvedValue({
        displayName: 'Alex',
        displayAvatarURL,
        roles: { cache: new Collection([[Constants.Discord.Roles.Team, {}]]) },
      });

      await expect(sut.getTeamMember(guildId, '400000000000000001')).resolves.toEqual({
        displayName: 'Alex',
        avatarUrl: 'https://cdn.discordapp.com/avatars/4/a.png?size=256',
        roleIds: [Constants.Discord.Roles.Team],
      });
      expect(fetchMember).toHaveBeenCalledWith('400000000000000001');
      expect(displayAvatarURL).toHaveBeenCalledWith({ extension: 'png', size: 256 });
    });

    it('should return undefined for a guild the bot cannot see', async () => {
      await expect(sut.getTeamMember('999999999999999999', '1')).resolves.toBeUndefined();
    });

    it.each([10_007, 10_013])('should return undefined for error %s', async (code) => {
      fetchMember.mockRejectedValue(apiError(code, 404));
      await expect(sut.getTeamMember(guildId, '1')).resolves.toBeUndefined();
    });

    it('should map other errors', async () => {
      fetchMember.mockRejectedValue(apiError(50_001, 403));
      await expect(sut.getTeamMember(guildId, '1')).rejects.toMatchObject({ kind: 'forbidden' });
    });
  });

  describe('fetchMirrorMessagesBefore', () => {
    const makeMessage = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      guildId,
      inGuild: () => true,
      channel,
      author: { id: '400000000000000001', username: 'contrib123', displayName: 'Contrib', bot: false },
      member: null,
      webhookId: null,
      system: false,
      type: MessageType.Default,
      createdTimestamp: 1,
      url: `https://discord.com/channels/${guildId}/${channelId}/${id}`,
      flags: new MessageFlagsBitField(),
      content: `message ${id}`,
      mentions: {
        users: new Collection(),
        members: new Collection(),
        roles: new Collection(),
        channels: new Collection(),
      },
      attachments: new Collection(),
      stickers: new Collection(),
      poll: null,
      messageSnapshots: new Collection(),
      reference: null,
      ...overrides,
    });

    it('should return the candidates before the anchor, oldest first, and the oldest message of any kind', async () => {
      channel.messages.fetch.mockResolvedValue(
        new Collection([
          ['1000000000000000003', makeMessage('1000000000000000003')],
          ['1000000000000000002', makeMessage('1000000000000000002')],
          ['999999999999999999', makeMessage('999999999999999999', { webhookId: '700000000000000001' })],
        ]),
      );

      const page = await sut.fetchMirrorMessagesBefore(channelId, '1000000000000000009', 3);

      expect(channel.messages.fetch).toHaveBeenCalledWith({ before: '1000000000000000009', limit: 3 });
      expect(page.messages.map(({ id, content }) => [id, content])).toEqual([
        ['1000000000000000002', 'message 1000000000000000002'],
        ['1000000000000000003', 'message 1000000000000000003'],
      ]);
      expect(page).toMatchObject({ oldestId: '999999999999999999', full: true });
    });

    it('should read the newest messages without an anchor', async () => {
      channel.messages.fetch.mockResolvedValue(new Collection());

      await expect(sut.fetchMirrorMessagesBefore(channelId, undefined, 100)).resolves.toEqual({
        messages: [],
        oldestId: null,
        full: false,
      });
      expect(channel.messages.fetch).toHaveBeenCalledWith({ limit: 100 });
    });

    it('should refuse a channel without messages', async () => {
      bot.channels.fetch.mockResolvedValue({ isTextBased: () => false, isDMBased: () => false });
      await expect(sut.fetchMirrorMessagesBefore(channelId, '1', 50)).rejects.toMatchObject({
        kind: 'unknown-channel',
      });
    });

    it('should map errors', async () => {
      channel.messages.fetch.mockRejectedValue(apiError(50_001, 403));
      await expect(sut.fetchMirrorMessagesBefore(channelId, '1', 50)).rejects.toMatchObject({ kind: 'forbidden' });
    });
  });

  describe('sendMirrorNotice', () => {
    const notice = { title: 'Mirrored with Zulip', content: 'This channel is now mirrored' };
    const expected = { content: notice.content, allowedMentions: { parse: [] }, flags: [MessageFlags.SuppressEmbeds] };

    it('should post and pin a message in a text channel, pinging nobody', async () => {
      const sent = { id: '300000000000000009', pin: vitest.fn() };
      const send = vitest.fn().mockResolvedValue(sent);
      bot.channels.fetch.mockResolvedValue(makeChannel({ send }));

      await expect(sut.sendMirrorNotice(channelId, notice, true)).resolves.toEqual({
        messageId: sent.id,
        pinned: true,
      });
      expect(send).toHaveBeenCalledWith(expected);
      expect(sent.pin).toHaveBeenCalledOnce();
    });

    it('should open a post in a forum and pin the post', async () => {
      const post = { id: threadId, pin: vitest.fn() };
      const forum = makeChannel({
        type: ChannelType.GuildForum,
        threads: { create: vitest.fn().mockResolvedValue(post) },
      });
      bot.channels.fetch.mockResolvedValue(forum);

      await expect(sut.sendMirrorNotice(channelId, notice, true)).resolves.toEqual({
        messageId: threadId,
        pinned: true,
      });
      expect(forum.threads.create).toHaveBeenCalledWith({ name: notice.title, message: expected });
    });

    it('should say when the pin failed, and not pin when not asked', async () => {
      const sent = { id: '300000000000000009', pin: vitest.fn().mockRejectedValue(apiError(50_013, 403)) };
      bot.channels.fetch.mockResolvedValue(makeChannel({ send: vitest.fn().mockResolvedValue(sent) }));

      await expect(sut.sendMirrorNotice(channelId, notice, true)).resolves.toEqual({
        messageId: sent.id,
        pinned: false,
      });
      await expect(sut.sendMirrorNotice(channelId, notice, false)).resolves.toEqual({
        messageId: sent.id,
        pinned: false,
      });
      expect(sent.pin).toHaveBeenCalledOnce();
    });

    it('should refuse any other kind of channel, and a send Discord refuses, without the request', async () => {
      bot.channels.fetch.mockResolvedValueOnce(makeChannel({ type: ChannelType.GuildVoice }));
      expect((await rejection(sut.sendMirrorNotice(channelId, notice, true))).kind).toBe('unknown-channel');

      bot.channels.fetch.mockResolvedValueOnce(
        makeChannel({ send: vitest.fn().mockRejectedValue(apiError(50_001, 403)) }),
      );
      const error = await rejection(sut.sendMirrorNotice(channelId, notice, true));
      expect(error).toEqual(expect.objectContaining({ kind: 'forbidden', code: 50_001 }));
      expect(inspect(error)).not.toContain('secret');
    });
  });

  describe('unpinMirrorNotice', () => {
    it('should unpin the message in a text channel', async () => {
      const message = { unpin: vitest.fn() };
      channel.messages.fetch.mockResolvedValue(message);

      await sut.unpinMirrorNotice(channelId, '300000000000000009');

      expect(channel.messages.fetch).toHaveBeenCalledWith('300000000000000009');
      expect(message.unpin).toHaveBeenCalledOnce();
    });

    it('should unpin the post in a forum', async () => {
      const post = { unpin: vitest.fn() };
      bot.channels.fetch.mockResolvedValue(
        makeChannel({ type: ChannelType.GuildForum, threads: { fetch: vitest.fn().mockResolvedValue(post) } }),
      );

      await sut.unpinMirrorNotice(channelId, threadId);

      expect(post.unpin).toHaveBeenCalledOnce();
    });

    it('should turn a failure into a mirror error', async () => {
      channel.messages.fetch.mockRejectedValue(apiError(10_008, 404));

      expect((await rejection(sut.unpinMirrorNotice(channelId, '300000000000000009'))).kind).toBe('unknown-message');
    });
  });
});
