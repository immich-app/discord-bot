import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CronJob } from 'cron';
import { IDatabaseRepository, NewScheduledMessage } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { shorten } from 'src/util';

@Injectable()
export class ScheduledMessageService implements OnModuleInit {
  private logger = new Logger(ScheduledMessageService.name);
  private jobs = new Map<string, CronJob>();

  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
  ) {}

  async onModuleInit() {
    await this.loadScheduledMessages();
  }

  private async loadScheduledMessages() {
    const messages = await this.database.getScheduledMessages();
    for (const message of messages) {
      this.registerJob(message.id, message.cronExpression, message.channelId, message.message);
    }
    this.logger.log(`Loaded ${messages.length} scheduled message(s)`);
  }

  private registerJob(id: string, cronExpression: string, channelId: string, message: string) {
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
    await this.database.createScheduledMessage(entity);
    const created = await this.database.getScheduledMessage(entity.name);
    if (created) {
      this.registerJob(created.id, created.cronExpression, created.channelId, created.message);
    }
  }

  async removeScheduledMessage(name: string) {
    const message = await this.database.getScheduledMessage(name);
    if (!message) {
      return { message: 'Scheduled message not found', isPrivate: true };
    }

    const job = this.jobs.get(message.id);
    if (job) {
      void job.stop();
      this.jobs.delete(message.id);
    }

    await this.database.removeScheduledMessage(message.id);
    return { message: `Removed scheduled message \`${message.name}\``, isPrivate: false };
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

  async listScheduledMessages(channelId?: string) {
    let messages = await this.database.getScheduledMessages();
    if (channelId) {
      messages = messages.filter((m) => m.channelId === channelId);
    }
    return messages;
  }
}
