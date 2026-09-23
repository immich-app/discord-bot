import { Logger } from '@nestjs/common';
import { MessageFlags, ModalBuilder, ModalSubmitInteraction } from 'discord.js';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';
import { ScheduledMessage } from 'src/schema';
import { ScheduledMessageService } from 'src/services/scheduled-message.service';
import { Mocked, afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

const newDatabaseMock = (): Mocked<
  Pick<
    IDatabaseRepository,
    | 'getScheduledMessages'
    | 'getScheduledMessage'
    | 'createScheduledMessage'
    | 'updateScheduledMessage'
    | 'removeScheduledMessage'
  >
> => ({
  getScheduledMessages: vitest.fn().mockResolvedValue([]),
  getScheduledMessage: vitest.fn(),
  createScheduledMessage: vitest.fn(),
  updateScheduledMessage: vitest.fn(),
  removeScheduledMessage: vitest.fn(),
});

const newDiscordMock = (): Mocked<IDiscordInterface> => ({
  login: vitest.fn(),
  isReady: vitest.fn().mockReturnValue(true),
  sendMessage: vitest.fn(),
  createEmote: vitest.fn(),
  getEmotes: vitest.fn(),
  setThreadArchived: vitest.fn(),
  createThread: vitest.fn(),
  updateThread: vitest.fn(),
});

const newMattermostMock = (): Mocked<IMattermostInterface> => ({
  createEmote: vitest.fn(),
  init: vitest.fn(),
  joinChannel: vitest.fn(),
  registerCommand: vitest.fn() as any,
  registerEventListener: vitest.fn() as any,
  reply: vitest.fn(),
  runCommand: vitest.fn(),
  send: vitest.fn(),
  listEmoji: vitest.fn(),
  streamChannels: vitest.fn(),
  updatePost: vitest.fn(),
  openDialog: vitest.fn(),
  submitDialog: vitest.fn(),
});

const newZulipMock = (): Mocked<IZulipInterface> => ({
  init: vitest.fn(),
  isInitialised: vitest.fn().mockReturnValue(true),
  sendMessage: vitest.fn().mockResolvedValue({ id: 1 }),
  createEmote: vitest.fn(),
  getMessage: vitest.fn(),
  updateMessage: vitest.fn(),
  listEmoji: vitest.fn(),
  getSubscriptions: vitest.fn(),
  getOwnUser: vitest.fn(),
  getMessages: vitest.fn(),
  registerQueue: vitest.fn(),
  getEvents: vitest.fn(),
  deleteQueue: vitest.fn(),
  getEmojiCodes: vitest.fn(),
});

const makeScheduledMessage = (overrides: Partial<ScheduledMessage> = {}): ScheduledMessage => ({
  id: 'msg-1',
  name: 'test-message',
  channelId: '123456',
  message: 'Hello world',
  suppressEmbeds: true,
  cronExpression: '0 9 * * 1',
  createdBy: 'user-1',
  createdAt: new Date(),
  service: 'discord',
  topic: null,
  ...overrides,
});

describe('ScheduledMessageService', () => {
  let sut: ScheduledMessageService;
  let databaseMock: ReturnType<typeof newDatabaseMock>;
  let discordMock: Mocked<IDiscordInterface>;
  let mattermostMock: Mocked<IMattermostInterface>;
  let zulipMock: Mocked<IZulipInterface>;

  beforeEach(() => {
    databaseMock = newDatabaseMock();
    discordMock = newDiscordMock();
    mattermostMock = newMattermostMock();
    zulipMock = newZulipMock();
    sut = new ScheduledMessageService(
      databaseMock as unknown as IDatabaseRepository,
      discordMock,
      mattermostMock,
      zulipMock,
    );
  });

  const mattermostCommand = (trigger: string) => {
    const registration = mattermostMock.registerCommand.mock.calls.find(([command]) => command.trigger === trigger);
    expect(registration, trigger).toBeDefined();
    return registration![1] as (request: unknown) => Promise<unknown>;
  };

  describe('onModuleInit', () => {
    it('should load and register all scheduled messages from the database', async () => {
      const messages = [
        makeScheduledMessage({ id: '1', name: 'msg-a', cronExpression: '0 9 * * 1' }),
        makeScheduledMessage({ id: '2', name: 'msg-b', cronExpression: '0 12 * * *' }),
      ];
      databaseMock.getScheduledMessages.mockResolvedValue(messages);

      await sut.init();

      expect(databaseMock.getScheduledMessages).toHaveBeenCalledOnce();
    });
  });

  describe('createScheduledMessage', () => {
    it('should reject invalid cron expressions before persisting', async () => {
      const entity = {
        name: 'bad-cron',
        channelId: '123',
        message: 'test',
        cronExpression: 'not a cron',
        createdBy: 'user-1',
        service: 'discord',
      } as const;

      await expect(sut.createScheduledMessage(entity)).rejects.toThrow();
      expect(databaseMock.createScheduledMessage).not.toHaveBeenCalled();
    });

    it('should persist and register a job for a valid cron expression', async () => {
      const entity = {
        name: 'valid-message',
        channelId: '123',
        message: 'Hello!',
        cronExpression: '0 9 * * 1',
        createdBy: 'user-1',
        service: 'discord',
      } as const;
      const created = makeScheduledMessage({ id: 'new-1', ...entity });
      databaseMock.createScheduledMessage.mockResolvedValue(created);

      await sut.createScheduledMessage(entity);

      expect(databaseMock.createScheduledMessage).toHaveBeenCalledWith(entity);
    });
  });

  describe('removeScheduledMessage', () => {
    it('should return not-found message when name does not exist', async () => {
      databaseMock.getScheduledMessage.mockResolvedValue(undefined);

      const result = await sut.removeScheduledMessage('nonexistent', 'discord');

      expect(databaseMock.getScheduledMessage).toHaveBeenCalledExactlyOnceWith('nonexistent', 'discord');
      expect(result).toEqual('Scheduled message not found');
      expect(databaseMock.removeScheduledMessage).not.toHaveBeenCalled();
    });

    it('should stop the job, remove from DB, and return success', async () => {
      const msg = makeScheduledMessage({ id: 'rm-1', name: 'to-remove' });
      databaseMock.getScheduledMessage.mockResolvedValue(msg);

      const result = await sut.removeScheduledMessage('to-remove', 'mattermost');

      expect(databaseMock.getScheduledMessage).toHaveBeenCalledExactlyOnceWith('to-remove', 'mattermost');
      expect(databaseMock.removeScheduledMessage).toHaveBeenCalledWith('rm-1');
      expect(result).toEqual('Removed scheduled message `to-remove`');
    });

    it('should look the name up on the platform it was removed from', async () => {
      databaseMock.getScheduledMessage.mockResolvedValue(makeScheduledMessage({ id: 'rm-1', name: 'to-remove' }));

      const result = await sut.removeScheduledMessage('to-remove', 'discord');

      expect(databaseMock.getScheduledMessage).toHaveBeenCalledExactlyOnceWith('to-remove', 'discord');
      expect(databaseMock.removeScheduledMessage).toHaveBeenCalledExactlyOnceWith('rm-1');
      expect(result).toEqual('Removed scheduled message `to-remove`');
    });
  });

  describe('editScheduledMessage', () => {
    it('should look the name up among discord rows only, and say so when it is not found', async () => {
      databaseMock.getScheduledMessage.mockResolvedValue(undefined);

      const result = await sut.editScheduledMessage('nonexistent');

      expect(databaseMock.getScheduledMessage).toHaveBeenCalledExactlyOnceWith('nonexistent', 'discord');
      expect(result).toBe('Scheduled message not found');
    });

    it('should look the name up among discord rows only when it is found', async () => {
      databaseMock.getScheduledMessage.mockResolvedValue(makeScheduledMessage({ name: 'standup' }));

      const result = await sut.editScheduledMessage('standup');

      expect(databaseMock.getScheduledMessage).toHaveBeenCalledExactlyOnceWith('standup', 'discord');
      expect(result).toBeInstanceOf(ModalBuilder);
      expect((result as ModalBuilder).toJSON().custom_id).toBe('scheduledMessageEdit-standup');
    });
  });

  describe('getScheduledMessages (autocomplete)', () => {
    it('should return all messages formatted for autocomplete', async () => {
      databaseMock.getScheduledMessages.mockResolvedValue([
        makeScheduledMessage({ name: 'daily-standup', cronExpression: '0 9 * * *', message: 'Time for standup!' }),
        makeScheduledMessage({ name: 'weekly-recap', cronExpression: '0 17 * * 5', message: 'Weekly recap time' }),
      ]);

      const result = await sut.getScheduledMessages();

      expect(databaseMock.getScheduledMessages).toHaveBeenCalledExactlyOnceWith('discord');
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: expect.stringContaining('daily-standup'),
        value: 'daily-standup',
      });
      expect(result[1]).toEqual({
        name: expect.stringContaining('weekly-recap'),
        value: 'weekly-recap',
      });
    });

    it('should filter by name when a search value is provided', async () => {
      databaseMock.getScheduledMessages.mockResolvedValue([
        makeScheduledMessage({ name: 'daily-standup' }),
        makeScheduledMessage({ name: 'weekly-recap' }),
      ]);

      const result = await sut.getScheduledMessages('daily');

      expect(databaseMock.getScheduledMessages).toHaveBeenCalledExactlyOnceWith('discord');
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe('daily-standup');
    });

    it('should filter case-insensitively', async () => {
      databaseMock.getScheduledMessages.mockResolvedValue([makeScheduledMessage({ name: 'Daily-Standup' })]);

      const result = await sut.getScheduledMessages('daily');

      expect(databaseMock.getScheduledMessages).toHaveBeenCalledExactlyOnceWith('discord');
      expect(result).toHaveLength(1);
    });

    it('should limit results to 25 entries', async () => {
      const messages = Array.from({ length: 30 }, (_, i) => makeScheduledMessage({ name: `msg-${i}` }));
      databaseMock.getScheduledMessages.mockResolvedValue(messages);

      const result = await sut.getScheduledMessages();

      expect(databaseMock.getScheduledMessages).toHaveBeenCalledExactlyOnceWith('discord');
      expect(result).toHaveLength(25);
    });
  });

  describe('listScheduledMessages', () => {
    it('should return all messages when no channel filter is provided', async () => {
      const messages = [makeScheduledMessage({ channelId: 'ch-1' }), makeScheduledMessage({ channelId: 'ch-2' })];
      databaseMock.getScheduledMessages.mockResolvedValue(messages);

      const result = await sut.listScheduledMessages('discord');

      expect(databaseMock.getScheduledMessages).toHaveBeenCalledExactlyOnceWith('discord');
      expect(result).toHaveLength(2);
    });

    it.each(['discord', 'mattermost'] as const)(
      'should pass the %s service through as the database filter and return its rows as they are',
      async (service) => {
        const messages = [makeScheduledMessage({ service })];
        databaseMock.getScheduledMessages.mockResolvedValue(messages);

        const result = await sut.listScheduledMessages(service);

        expect(databaseMock.getScheduledMessages).toHaveBeenCalledExactlyOnceWith(service);
        expect(result).toBe(messages);
      },
    );
  });

  describe('the mattermost commands', () => {
    const request = {
      user_id: 'u1',
      parameters: { name: 'standup', cronExpression: '0 9 * * 1', message: 'Standup in **5 minutes**', channel: 'c1' },
    };

    beforeEach(async () => {
      vitest.useFakeTimers();
      await sut.init();
    });

    afterEach(() => {
      vitest.clearAllTimers();
      vitest.useRealTimers();
    });

    it('should store a schedule-add as a mattermost row for the mentioned channel, created by the caller', async () => {
      databaseMock.createScheduledMessage.mockResolvedValue(
        makeScheduledMessage({ id: 'new-1', name: 'standup', channelId: 'c1', createdBy: 'u1', service: 'mattermost' }),
      );

      const response = await mattermostCommand('schedule-add')(request);

      expect(databaseMock.createScheduledMessage.mock.calls).toStrictEqual([
        [
          {
            name: 'standup',
            cronExpression: '0 9 * * 1',
            message: 'Standup in **5 minutes**',
            channelId: 'c1',
            createdBy: 'u1',
            service: 'mattermost',
          },
        ],
      ]);
      expect(response).toStrictEqual({
        response_type: 'in_channel',
        text: 'Scheduled message `standup` created with cron `0 9 * * 1` in ~c1',
      });
    });

    it('should answer an invalid cron expression privately with the error, storing nothing', async () => {
      const response = await mattermostCommand('schedule-add')({
        ...request,
        parameters: { ...request.parameters, cronExpression: 'not a cron' },
      });

      expect(databaseMock.createScheduledMessage).not.toHaveBeenCalled();
      expect(response).toStrictEqual({
        text: 'Failed to create scheduled message: Error: Invalid cron expression not a cron: Error: Unknown alias: not',
      });
    });

    it('should answer a failed insert privately with the error', async () => {
      databaseMock.createScheduledMessage.mockRejectedValue(
        new Error('duplicate key value violates unique constraint'),
      );

      const response = await mattermostCommand('schedule-add')(request);

      expect(databaseMock.createScheduledMessage).toHaveBeenCalledOnce();
      expect(response).toStrictEqual({
        text: 'Failed to create scheduled message: Error: duplicate key value violates unique constraint',
      });
    });

    it('should look a schedule-remove up among mattermost rows only', async () => {
      databaseMock.getScheduledMessage.mockResolvedValue(undefined);

      const response = await mattermostCommand('schedule-remove')({ parameters: { name: 'to-remove' } });

      expect(databaseMock.getScheduledMessage).toHaveBeenCalledExactlyOnceWith('to-remove', 'mattermost');
      expect(databaseMock.removeScheduledMessage).not.toHaveBeenCalled();
      expect(response).toStrictEqual({ response_type: 'in_channel', text: 'Scheduled message not found' });
    });

    it('should list mattermost rows only for a schedule-list', async () => {
      databaseMock.getScheduledMessages.mockClear();

      const response = await mattermostCommand('schedule-list')({});

      expect(databaseMock.getScheduledMessages).toHaveBeenCalledExactlyOnceWith('mattermost');
      expect(response).toStrictEqual({ text: 'No scheduled messages found.' });
    });
  });

  describe('the cron tick', () => {
    const everyMinute = '* * * * *';
    const message = '<@&1234> Standup in **5 minutes**: https://example.com/standup';

    const nextMinute = () => vitest.advanceTimersByTimeAsync(60_000);

    beforeEach(() => {
      vitest.useFakeTimers();
      vitest.setSystemTime(new Date('2026-01-05T08:59:30.000Z'));
      vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      vitest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vitest.clearAllTimers();
      vitest.useRealTimers();
      vitest.restoreAllMocks();
    });

    it('should send nothing until the cron expression fires', async () => {
      databaseMock.getScheduledMessages.mockResolvedValue([makeScheduledMessage({ cronExpression: everyMinute })]);

      await sut.init();
      await vitest.advanceTimersByTimeAsync(29_999);

      expect(discordMock.sendMessage).not.toHaveBeenCalled();

      await vitest.advanceTimersByTimeAsync(1);

      expect(discordMock.sendMessage).toHaveBeenCalledOnce();
    });

    it.each([
      [true, [MessageFlags.SuppressEmbeds]],
      [false, []],
    ])(
      'should send a discord row as its content, with suppressEmbeds %s as flags %j',
      async (suppressEmbeds, flags) => {
        databaseMock.getScheduledMessages.mockResolvedValue([
          makeScheduledMessage({
            cronExpression: everyMinute,
            channelId: '991930592843272342',
            message,
            suppressEmbeds,
          }),
        ]);

        await sut.init();
        await nextMinute();

        expect(discordMock.sendMessage.mock.calls).toStrictEqual([
          [{ channelId: '991930592843272342', message: { content: message, flags } }],
        ]);
        expect(mattermostMock.send).not.toHaveBeenCalled();
      },
    );

    it.each([
      [true, { remove_link_preview: 'true' }],
      [false, undefined],
    ])(
      'should send a mattermost row as its message, with suppressEmbeds %s as props %j',
      async (suppressEmbeds, props) => {
        databaseMock.getScheduledMessages.mockResolvedValue([
          makeScheduledMessage({
            cronExpression: everyMinute,
            channelId: 'mattermost-channel',
            message,
            suppressEmbeds,
            service: 'mattermost',
          }),
        ]);

        await sut.init();
        await nextMinute();

        expect(mattermostMock.send.mock.calls).toStrictEqual([[{ channelId: 'mattermost-channel', message, props }]]);
        expect(discordMock.sendMessage).not.toHaveBeenCalled();
      },
    );

    it('should send every row loaded at init to its own platform and channel, on every tick', async () => {
      databaseMock.getScheduledMessages.mockResolvedValue([
        makeScheduledMessage({ id: '1', name: 'a', cronExpression: everyMinute, channelId: 'discord-1', message: 'A' }),
        makeScheduledMessage({
          id: '2',
          name: 'b',
          cronExpression: everyMinute,
          channelId: 'mattermost-1',
          message: 'B',
          suppressEmbeds: false,
          service: 'mattermost',
        }),
        makeScheduledMessage({ id: '3', name: 'c', cronExpression: '0 0 1 1 *', channelId: 'discord-2', message: 'C' }),
      ]);

      await sut.init();
      await nextMinute();
      await nextMinute();

      expect(databaseMock.getScheduledMessages).toHaveBeenCalledExactlyOnceWith();
      expect(discordMock.sendMessage.mock.calls).toStrictEqual([
        [{ channelId: 'discord-1', message: { content: 'A', flags: [MessageFlags.SuppressEmbeds] } }],
        [{ channelId: 'discord-1', message: { content: 'A', flags: [MessageFlags.SuppressEmbeds] } }],
      ]);
      expect(mattermostMock.send.mock.calls).toStrictEqual([
        [{ channelId: 'mattermost-1', message: 'B', props: undefined }],
        [{ channelId: 'mattermost-1', message: 'B', props: undefined }],
      ]);
    });

    it('should send the row the database returned for a created message', async () => {
      const entity = {
        name: 'created',
        channelId: '123',
        message: 'Hello!',
        cronExpression: everyMinute,
        createdBy: 'user-1',
        service: 'discord',
      } as const;
      databaseMock.createScheduledMessage.mockResolvedValue(
        makeScheduledMessage({ id: 'new-1', ...entity, suppressEmbeds: true }),
      );

      await sut.createScheduledMessage(entity);
      await nextMinute();

      expect(discordMock.sendMessage.mock.calls).toStrictEqual([
        [{ channelId: '123', message: { content: 'Hello!', flags: [MessageFlags.SuppressEmbeds] } }],
      ]);
    });

    it.each([
      ['discord', () => discordMock.sendMessage],
      ['mattermost', () => mattermostMock.send],
    ] as const)(
      'should log a failed %s send instead of throwing, and send again on the next tick',
      async (service, send) => {
        databaseMock.getScheduledMessages.mockResolvedValue([
          makeScheduledMessage({ id: 'msg-1', cronExpression: everyMinute, service }),
        ]);
        send().mockRejectedValueOnce(new Error('Missing Access'));

        await sut.init();
        await nextMinute();

        expect(send()).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
          'Failed to send scheduled message msg-1: Error: Missing Access',
        );
        expect(console.error).not.toHaveBeenCalled();

        await nextMinute();

        expect(send()).toHaveBeenCalledTimes(2);
        expect(Logger.prototype.error).toHaveBeenCalledOnce();
      },
    );

    it('should stop sending a message once it is removed', async () => {
      const row = makeScheduledMessage({ id: 'rm-1', name: 'to-remove', cronExpression: everyMinute });
      databaseMock.getScheduledMessages.mockResolvedValue([row]);
      databaseMock.getScheduledMessage.mockResolvedValue(row);

      await sut.init();
      await nextMinute();
      await sut.removeScheduledMessage('to-remove', 'discord');
      await nextMinute();

      expect(discordMock.sendMessage).toHaveBeenCalledOnce();
    });

    it('should send only the edited message after an edit from the Discord modal', async () => {
      const row = makeScheduledMessage({ id: 'edit-1', name: 'standup', cronExpression: everyMinute });
      databaseMock.getScheduledMessages.mockResolvedValue([row]);
      databaseMock.updateScheduledMessage.mockResolvedValue({ ...row, message: 'Edited', suppressEmbeds: false });
      const values: Record<string, string> = { cronExpressionInput: everyMinute, messageInput: 'Edited' };
      const interaction = {
        customId: 'scheduledMessageEdit-standup',
        fields: {
          getTextInputValue: vitest.fn((id: string) => values[id]),
          getCheckbox: vitest.fn().mockReturnValue(false),
        },
        reply: vitest.fn(),
      };

      await sut.init();
      await sut.handleEditScheduledMessageModal(interaction as unknown as ModalSubmitInteraction);
      await nextMinute();

      expect(databaseMock.updateScheduledMessage).toHaveBeenCalledExactlyOnceWith({
        name: 'standup',
        cronExpression: everyMinute,
        message: 'Edited',
        suppressEmbeds: false,
      });
      expect(discordMock.sendMessage.mock.calls).toStrictEqual([
        [{ channelId: '123456', message: { content: 'Edited', flags: [] } }],
      ]);
    });

    it('should send only the edited message after a Mattermost schedule-edit, which re-registers the job', async () => {
      const row = makeScheduledMessage({
        id: 'mm-1',
        name: 'standup',
        cronExpression: everyMinute,
        channelId: 'mattermost-channel',
        suppressEmbeds: false,
        service: 'mattermost',
      });
      databaseMock.getScheduledMessages.mockResolvedValue([row]);
      databaseMock.getScheduledMessage.mockResolvedValue(row);
      databaseMock.updateScheduledMessage.mockResolvedValue({ ...row, message: 'Edited' });
      mattermostMock.openDialog.mockResolvedValue({
        cancelled: false,
        cronExpression: everyMinute,
        message: 'Edited',
        suppressEmbeds: 'false',
      } as any);

      await sut.init();
      await mattermostCommand('schedule-edit')({ trigger_id: 'trigger-1', parameters: { name: 'standup' } });
      // The dialog runs detached from the command; let it finish before the tick.
      await vitest.advanceTimersByTimeAsync(0);
      expect(databaseMock.updateScheduledMessage).toHaveBeenCalledOnce();
      await nextMinute();

      expect(mattermostMock.send.mock.calls).toStrictEqual([
        [{ channelId: 'mattermost-channel', message: 'Edited', props: undefined }],
      ]);
    });
  });

  describe('zulip rows', () => {
    const everyMinute = '* * * * *';
    const nextMinute = () => vitest.advanceTimersByTimeAsync(60_000);
    const zulipRow = (overrides: Partial<ScheduledMessage> = {}) =>
      makeScheduledMessage({
        id: 'z-1',
        name: 'standup',
        cronExpression: everyMinute,
        channelId: '107',
        topic: 'standup',
        message: '@*mobile* Standup in **5 minutes**: https://example.com/standup',
        service: 'zulip',
        ...overrides,
      });

    beforeEach(() => {
      vitest.useFakeTimers();
      vitest.setSystemTime(new Date('2026-01-05T08:59:30.000Z'));
      vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vitest.clearAllTimers();
      vitest.useRealTimers();
      vitest.restoreAllMocks();
    });

    it.each([true, false])(
      'should send a zulip row to its stream and topic as it is, whatever suppressEmbeds (%s) says',
      async (suppressEmbeds) => {
        databaseMock.getScheduledMessages.mockResolvedValue([zulipRow({ suppressEmbeds })]);

        await sut.init();
        await nextMinute();

        expect(zulipMock.sendMessage.mock.calls).toStrictEqual([
          [
            {
              stream: 107,
              topic: 'standup',
              content: '@*mobile* Standup in **5 minutes**: https://example.com/standup',
            },
          ],
        ]);
        expect(discordMock.sendMessage).not.toHaveBeenCalled();
        expect(mattermostMock.send).not.toHaveBeenCalled();
      },
    );

    it('should send a zulip row that has no topic to the empty topic', async () => {
      databaseMock.getScheduledMessages.mockResolvedValue([zulipRow({ topic: null })]);

      await sut.init();
      await nextMinute();

      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ stream: 107, topic: '' }),
      );
    });

    it('should log a failed zulip send instead of throwing, and send again on the next tick', async () => {
      databaseMock.getScheduledMessages.mockResolvedValue([zulipRow()]);
      zulipMock.sendMessage.mockRejectedValueOnce(new Error('Zulip client not initialised'));

      await sut.init();
      await nextMinute();
      await nextMinute();

      expect(zulipMock.sendMessage).toHaveBeenCalledTimes(2);
      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        'Failed to send scheduled message z-1: Error: Zulip client not initialised',
      );
    });

    it('should send only the updated message, to the updated topic, after an update', async () => {
      const row = zulipRow();
      databaseMock.getScheduledMessages.mockResolvedValue([row]);
      databaseMock.getScheduledMessage.mockResolvedValue(row);
      databaseMock.updateScheduledMessage.mockResolvedValue({ ...row, message: 'Edited', topic: 'daily' });

      await sut.init();
      const updated = await sut.updateScheduledMessage('standup', 'zulip', { message: 'Edited', topic: 'daily' });
      await nextMinute();

      expect(databaseMock.getScheduledMessage).toHaveBeenCalledExactlyOnceWith('standup', 'zulip');
      expect(databaseMock.updateScheduledMessage).toHaveBeenCalledExactlyOnceWith({
        name: 'standup',
        message: 'Edited',
        topic: 'daily',
      });
      expect(updated).toMatchObject({ message: 'Edited', topic: 'daily' });
      expect(zulipMock.sendMessage.mock.calls).toStrictEqual([[{ stream: 107, topic: 'daily', content: 'Edited' }]]);
    });

    it('should move the job to the updated schedule', async () => {
      const row = zulipRow({ cronExpression: '0 0 1 1 *' });
      databaseMock.getScheduledMessages.mockResolvedValue([row]);
      databaseMock.getScheduledMessage.mockResolvedValue(row);
      databaseMock.updateScheduledMessage.mockResolvedValue({ ...row, cronExpression: everyMinute });

      await sut.init();
      await nextMinute();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();

      await sut.updateScheduledMessage('standup', 'zulip', { cronExpression: everyMinute });
      await nextMinute();

      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
    });

    it('should not update a row of another platform, nor an invalid cron expression', async () => {
      databaseMock.getScheduledMessage.mockResolvedValue(undefined);

      await expect(sut.updateScheduledMessage('standup', 'zulip', { message: 'Edited' })).resolves.toBeUndefined();
      await expect(sut.updateScheduledMessage('standup', 'zulip', { cronExpression: 'not a cron' })).rejects.toThrow(
        'Invalid cron expression not a cron',
      );

      expect(databaseMock.getScheduledMessage).toHaveBeenCalledExactlyOnceWith('standup', 'zulip');
      expect(databaseMock.updateScheduledMessage).not.toHaveBeenCalled();
    });

    it('should stop a deleted zulip row and resolve to it', async () => {
      const row = zulipRow();
      databaseMock.getScheduledMessages.mockResolvedValue([row]);
      databaseMock.getScheduledMessage.mockResolvedValue(row);

      await sut.init();
      await expect(sut.deleteScheduledMessage('standup', 'zulip')).resolves.toBe(row);
      await nextMinute();

      expect(databaseMock.getScheduledMessage).toHaveBeenCalledExactlyOnceWith('standup', 'zulip');
      expect(databaseMock.removeScheduledMessage).toHaveBeenCalledExactlyOnceWith('z-1');
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should resolve to nothing when there is no row by that name to delete', async () => {
      databaseMock.getScheduledMessage.mockResolvedValue(undefined);

      await expect(sut.deleteScheduledMessage('standup', 'zulip')).resolves.toBeUndefined();

      expect(databaseMock.removeScheduledMessage).not.toHaveBeenCalled();
    });
  });

  describe('the mattermost schedule-edit dialog', () => {
    const row = makeScheduledMessage({ id: 'mm-1', name: 'standup', service: 'mattermost' });

    beforeEach(async () => {
      vitest.useFakeTimers();
      vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      databaseMock.getScheduledMessage.mockResolvedValue(row);
      databaseMock.updateScheduledMessage.mockResolvedValue(row);
      await sut.init();
    });

    afterEach(() => {
      vitest.clearAllTimers();
      vitest.useRealTimers();
      vitest.restoreAllMocks();
    });

    const edit = async (response: Record<string, unknown>) => {
      mattermostMock.openDialog.mockResolvedValue(response as any);
      await mattermostCommand('schedule-edit')({ trigger_id: 'trigger-1', parameters: { name: 'standup' } });
      await vitest.advanceTimersByTimeAsync(0);
    };

    it('should store the edited fields only, not the rest of the dialog response', async () => {
      await edit({
        cancelled: false,
        cronExpression: '0 9 * * 1',
        message: 'Edited',
        suppressEmbeds: false,
        file_ids: [],
      });

      expect(databaseMock.updateScheduledMessage).toHaveBeenCalledExactlyOnceWith({
        name: 'standup',
        cronExpression: '0 9 * * 1',
        message: 'Edited',
        suppressEmbeds: false,
      });
    });

    it('should log an invalid cron expression from the dialog and store nothing', async () => {
      await edit({ cancelled: false, cronExpression: 'not a cron', message: 'Edited' });

      expect(databaseMock.updateScheduledMessage).not.toHaveBeenCalled();
      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/^Failed to edit scheduled message standup: Error: Invalid cron expression not a cron/),
      );
    });

    it('should store nothing when the dialog is cancelled', async () => {
      await edit({ cancelled: true });

      expect(databaseMock.updateScheduledMessage).not.toHaveBeenCalled();
    });
  });
});
