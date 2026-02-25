import { IDatabaseRepository, ScheduledMessage } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { ScheduledMessageService } from 'src/services/scheduled-message.service';
import { Mocked, beforeEach, describe, expect, it, vitest } from 'vitest';

const newDatabaseMock = (): Mocked<
  Pick<
    IDatabaseRepository,
    'getScheduledMessages' | 'getScheduledMessage' | 'createScheduledMessage' | 'removeScheduledMessage'
  >
> => ({
  getScheduledMessages: vitest.fn().mockResolvedValue([]),
  getScheduledMessage: vitest.fn(),
  createScheduledMessage: vitest.fn(),
  removeScheduledMessage: vitest.fn(),
});

const newDiscordMock = (): Mocked<IDiscordInterface> => ({
  login: vitest.fn(),
  sendMessage: vitest.fn(),
  createEmote: vitest.fn(),
  getEmotes: vitest.fn(),
});

const makeScheduledMessage = (overrides: Partial<ScheduledMessage> = {}): ScheduledMessage => ({
  id: 'msg-1',
  name: 'test-message',
  channelId: '123456',
  message: 'Hello world',
  cronExpression: '0 9 * * 1',
  createdBy: 'user-1',
  createdAt: new Date(),
  ...overrides,
});

describe('ScheduledMessageService', () => {
  let sut: ScheduledMessageService;
  let databaseMock: ReturnType<typeof newDatabaseMock>;
  let discordMock: Mocked<IDiscordInterface>;

  beforeEach(() => {
    databaseMock = newDatabaseMock();
    discordMock = newDiscordMock();
    sut = new ScheduledMessageService(databaseMock as unknown as IDatabaseRepository, discordMock);
  });

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
      };

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
      };
      const created = makeScheduledMessage({ id: 'new-1', ...entity });
      databaseMock.createScheduledMessage.mockResolvedValue(created);

      await sut.createScheduledMessage(entity);

      expect(databaseMock.createScheduledMessage).toHaveBeenCalledWith(entity);
    });
  });

  describe('removeScheduledMessage', () => {
    it('should return not-found message when name does not exist', async () => {
      databaseMock.getScheduledMessage.mockResolvedValue(undefined);

      const result = await sut.removeScheduledMessage('nonexistent');

      expect(result).toEqual('Scheduled message not found');
      expect(databaseMock.removeScheduledMessage).not.toHaveBeenCalled();
    });

    it('should stop the job, remove from DB, and return success', async () => {
      const msg = makeScheduledMessage({ id: 'rm-1', name: 'to-remove' });
      databaseMock.getScheduledMessage.mockResolvedValue(msg);

      const result = await sut.removeScheduledMessage('to-remove');

      expect(databaseMock.removeScheduledMessage).toHaveBeenCalledWith('rm-1');
      expect(result).toEqual('Removed scheduled message `to-remove`');
    });
  });

  describe('getScheduledMessages (autocomplete)', () => {
    it('should return all messages formatted for autocomplete', async () => {
      databaseMock.getScheduledMessages.mockResolvedValue([
        makeScheduledMessage({ name: 'daily-standup', cronExpression: '0 9 * * *', message: 'Time for standup!' }),
        makeScheduledMessage({ name: 'weekly-recap', cronExpression: '0 17 * * 5', message: 'Weekly recap time' }),
      ]);

      const result = await sut.getScheduledMessages();

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

      expect(result).toHaveLength(1);
      expect(result[0].value).toBe('daily-standup');
    });

    it('should filter case-insensitively', async () => {
      databaseMock.getScheduledMessages.mockResolvedValue([makeScheduledMessage({ name: 'Daily-Standup' })]);

      const result = await sut.getScheduledMessages('daily');

      expect(result).toHaveLength(1);
    });

    it('should limit results to 25 entries', async () => {
      const messages = Array.from({ length: 30 }, (_, i) => makeScheduledMessage({ name: `msg-${i}` }));
      databaseMock.getScheduledMessages.mockResolvedValue(messages);

      const result = await sut.getScheduledMessages();

      expect(result).toHaveLength(25);
    });
  });

  describe('listScheduledMessages', () => {
    it('should return all messages when no channel filter is provided', async () => {
      const messages = [makeScheduledMessage({ channelId: 'ch-1' }), makeScheduledMessage({ channelId: 'ch-2' })];
      databaseMock.getScheduledMessages.mockResolvedValue(messages);

      const result = await sut.listScheduledMessages();

      expect(result).toHaveLength(2);
    });
  });
});
