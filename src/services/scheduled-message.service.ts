import { Inject, Injectable, Logger } from '@nestjs/common';
import { CronJob } from 'cron';
import {
  heading,
  HeadingLevel,
  inlineCode,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { Discord, ModalComponent } from 'discordx';
import { DiscordModal } from 'src/constants';
import { shorten } from 'src/format';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';
import { NewScheduledMessage, ScheduledMessage, UpdateScheduledMessage } from 'src/schema';

type Service = ScheduledMessage['service'];

@Discord()
@Injectable()
export class ScheduledMessageService {
  private logger = new Logger(ScheduledMessageService.name);
  private jobs = new Map<string, CronJob>();

  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
    @Inject(IZulipInterface) private zulip: IZulipInterface,
  ) {}

  private senders: Record<Service, (message: ScheduledMessage) => Promise<unknown>> = {
    discord: ({ channelId, message, suppressEmbeds }) =>
      this.discord.sendMessage({
        channelId,
        message: { content: message, flags: suppressEmbeds ? [MessageFlags.SuppressEmbeds] : [] },
      }),
    zulip: ({ channelId, topic, message }) =>
      this.zulip.sendMessage({ stream: Number(channelId), topic: topic ?? '', content: message }),
  };

  async init() {
    const messages = await this.database.getScheduledMessages();
    for (const message of messages) {
      this.registerJob(message);
    }
  }

  private registerJob(scheduledMessage: ScheduledMessage) {
    const job = CronJob.from({
      cronTime: scheduledMessage.cronExpression,
      onTick: async () => {
        try {
          await this.senders[scheduledMessage.service](scheduledMessage);
        } catch (error) {
          this.logger.error(`Failed to send scheduled message ${scheduledMessage.id}: ${error}`);
        }
      },
      start: true,
    });
    this.jobs.set(scheduledMessage.id, job);
  }

  private async reschedule(scheduledMessage: ScheduledMessage) {
    await this.jobs.get(scheduledMessage.id)?.stop();
    this.registerJob(scheduledMessage);
  }

  async createScheduledMessage(entity: NewScheduledMessage) {
    validateCronExpression(entity.cronExpression);
    const message = await this.database.createScheduledMessage(entity);
    this.registerJob(message);
  }

  /** With a `channelId`, a message posted in another channel counts as not found, before the cron is checked. */
  async updateScheduledMessage(
    name: string,
    service: Service,
    changes: UpdateScheduledMessage,
    { channelId }: { channelId?: string } = {},
  ) {
    if (!(await this.getScheduledMessage(name, service, { channelId }))) {
      return;
    }
    if (changes.cronExpression !== undefined) {
      validateCronExpression(changes.cronExpression);
    }
    const updated = await this.database.updateScheduledMessage({ name, ...changes });
    if (updated) {
      await this.reschedule(updated);
    }
    return updated;
  }

  async editScheduledMessage(name: string) {
    const message = await this.database.getScheduledMessage(name, 'discord');
    if (!message) {
      return 'Scheduled message not found';
    }

    return new ModalBuilder({
      title: 'Edit message',
      customId: `${DiscordModal.ScheduledMessageEdit}-${name}`,
    })
      .addTextDisplayComponents(new TextDisplayBuilder({ content: heading(message.name, HeadingLevel.One) }))
      .addLabelComponents(
        new LabelBuilder({ label: 'Cron expression' }).setTextInputComponent(
          new TextInputBuilder({
            customId: 'cronExpressionInput',
            style: TextInputStyle.Short,
            value: message.cronExpression,
          }),
        ),

        new LabelBuilder({ label: 'Message' }).setTextInputComponent(
          new TextInputBuilder({
            customId: 'messageInput',
            style: TextInputStyle.Paragraph,
            value: message.message,
          }),
        ),

        new LabelBuilder({ label: 'Suppress Embeds' }).setCheckboxComponent((builder) =>
          builder.setCustomId('suppressEmbedsCheckbox').setDefault(message.suppressEmbeds),
        ),
      );
  }

  @ModalComponent({ id: new RegExp(`${DiscordModal.ScheduledMessageEdit}-.+`) })
  async handleEditScheduledMessageModal(interaction: ModalSubmitInteraction): Promise<void> {
    const name = interaction.customId.split('-').splice(1).join('-');
    const cronExpression = interaction.fields.getTextInputValue('cronExpressionInput');
    const message = interaction.fields.getTextInputValue('messageInput');
    const suppressEmbeds = interaction.fields.getCheckbox('suppressEmbedsCheckbox');

    const updatedMessage = await this.database.updateScheduledMessage({
      name,
      cronExpression,
      message,
      suppressEmbeds,
    });

    if (!updatedMessage) {
      await interaction.reply(`Failed updating scheduled message ${inlineCode(name)}`);
      return;
    }

    await this.reschedule(updatedMessage);

    await interaction.reply(`Successfully updated scheduled message ${inlineCode(updatedMessage.name)}`);
  }

  async removeScheduledMessage(name: string, service: Service) {
    const message = await this.deleteScheduledMessage(name, service);
    return message ? `Removed scheduled message ${inlineCode(message.name)}` : 'Scheduled message not found';
  }

  /** With a `channelId`, a message posted in another channel counts as not found. */
  async deleteScheduledMessage(name: string, service: Service, { channelId }: { channelId?: string } = {}) {
    const message = await this.getScheduledMessage(name, service, { channelId });
    if (!message) {
      return;
    }

    const job = this.jobs.get(message.id);
    if (job) {
      await job.stop();
      this.jobs.delete(message.id);
    }

    await this.database.removeScheduledMessage(message.id);
    return message;
  }

  async getScheduledMessages(value?: string) {
    let messages = await this.database.getScheduledMessages('discord');
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

  async listScheduledMessages(service: Service, { channelId }: { channelId?: string } = {}) {
    const messages = await this.database.getScheduledMessages(service);
    return channelId === undefined ? messages : messages.filter((message) => message.channelId === channelId);
  }

  private async getScheduledMessage(name: string, service: Service, { channelId }: { channelId?: string }) {
    const message = await this.database.getScheduledMessage(name, service);
    return message && (channelId === undefined || message.channelId === channelId) ? message : undefined;
  }
}

const validateCronExpression = (cronExpression: string) => {
  try {
    new CronJob(cronExpression, () => {});
  } catch (error) {
    throw new Error(`Invalid cron expression ${cronExpression}: ${error}`, { cause: error });
  }
};
