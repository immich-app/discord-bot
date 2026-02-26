import { Inject, Injectable, Logger } from '@nestjs/common';
import { CronJob } from 'cron';
import { inlineCode } from 'discord.js';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { NewScheduledMessage } from 'src/schema';
import { shorten } from 'src/util';

@Injectable()
export class ScheduledMessageService {
  private logger = new Logger(ScheduledMessageService.name);
  private jobs = new Map<string, CronJob>();

  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
  ) {}

  async init() {
    const messages = await this.database.getScheduledMessages();
    for (const message of messages) {
      this.registerJob(message);
    }
  }

  private registerJob({
    id,
    cronExpression,
    channelId,
    message,
  }: {
    id: string;
    cronExpression: string;
    channelId: string;
    message: string;
  }) {
    const job = CronJob.from({
      cronTime: cronExpression,
      onTick: async () => {
        try {
          await this.discord.sendMessage({ channelId, message: { content: message } });
        } catch (error) {
          this.logger.error(`Failed to send scheduled message ${id}: ${error}`);
        }
      },
      start: true,
    });
    this.jobs.set(id, job);
  }

  async createScheduledMessage(entity: NewScheduledMessage) {
    try {
      new CronJob(entity.cronExpression, () => {});
    } catch (error) {
      throw new Error(`Invalid cron expression ${entity.cronExpression}: ${error}`);
    }

    const message = await this.database.createScheduledMessage(entity);
    this.registerJob(message);
  }

  async removeScheduledMessage(name: string) {
    const message = await this.database.getScheduledMessage(name);
    if (!message) {
      return 'Scheduled message not found';
    }

    const job = this.jobs.get(message.id);
    if (job) {
      await job.stop();
      this.jobs.delete(message.id);
    }

    await this.database.removeScheduledMessage(message.id);
    return `Removed scheduled message ${inlineCode(message.name)}`;
  }

  async getScheduledMessages(value?: string) {
    let messages = await this.database.getScheduledMessages();
    if (value) {
      const query = value.toLowerCase();
      messages = messages.filter(({ name }) => name.toLowerCase().includes(query));
    }

    return messages
      .map(({ name, cronExpression, message }) => ({
        name: shorten(`${name} — ${cronExpression} — ${message}`, 100),
        value: name,
      }))
      .slice(0, 25);
  }

  async listScheduledMessages() {
    return this.database.getScheduledMessages();
  }
}
