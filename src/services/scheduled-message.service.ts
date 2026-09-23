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
import { Constants, DiscordModal } from 'src/constants';
import { shorten } from 'src/format';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';
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
    @Inject(IMattermostInterface) private mattermost: IMattermostInterface,
    @Inject(IZulipInterface) private zulip: IZulipInterface,
  ) {}

  private senders: Record<Service, (message: ScheduledMessage) => Promise<unknown>> = {
    discord: ({ channelId, message, suppressEmbeds }) =>
      this.discord.sendMessage({
        channelId,
        message: { content: message, flags: suppressEmbeds ? [MessageFlags.SuppressEmbeds] : [] },
      }),
    mattermost: ({ channelId, message, suppressEmbeds }) =>
      this.mattermost.send({
        channelId,
        message,
        props: suppressEmbeds ? { remove_link_preview: 'true' } : undefined,
      }),
    zulip: ({ channelId, topic, message }) =>
      this.zulip.sendMessage({ stream: Number(channelId), topic: topic ?? '', content: message }),
  };

  async init() {
    const messages = await this.database.getScheduledMessages();
    for (const message of messages) {
      this.registerJob(message);
    }

    await this.mattermost.registerCommand(
      {
        trigger: 'schedule-add',
        display_name: 'Schedule add',
        description: 'Create a recurring scheduled message',
        auto_complete: true,
        auto_complete_desc: 'cron is a regular cron expression. The message may include role mentions and markdown.',
        team_id: Constants.Mattermost.Teams.Immich,
        parameters: [
          { name: 'name', type: 'text', optional: false },
          { name: 'cronExpression', type: 'text', optional: false },
          { name: 'message', type: 'text', optional: false },
          { name: 'channel', type: 'channelMention', optional: false },
        ],
      },
      async ({ user_id, parameters: { name, cronExpression, message, channel } }) => {
        try {
          await this.createScheduledMessage({
            name,
            cronExpression,
            message,
            channelId: channel,
            createdBy: user_id,
            service: 'mattermost',
          });
          return {
            response_type: 'in_channel',
            text: `Scheduled message ${inlineCode(name)} created with cron ${inlineCode(cronExpression)} in ~${channel}`,
          };
        } catch (error) {
          return { text: `Failed to create scheduled message: ${error}` };
        }
      },
    );

    await this.mattermost.registerCommand(
      {
        trigger: 'schedule-remove',
        display_name: 'Schedule add',
        description: 'Remove scheduled message',
        auto_complete: true,
        team_id: Constants.Mattermost.Teams.Immich,
        parameters: [{ name: 'name', type: 'text', optional: false }],
      },
      async ({ parameters: { name } }) => {
        const message = await this.removeScheduledMessage(name, 'mattermost');
        return {
          response_type: 'in_channel',
          text: message,
        };
      },
    );

    await this.mattermost.registerCommand(
      {
        trigger: 'schedule-list',
        display_name: 'Schedule lists',
        description: 'List all scheduled messages',
        auto_complete: true,
        team_id: Constants.Mattermost.Teams.Immich,
      },
      async () => {
        const messages = await this.listScheduledMessages('mattermost');

        if (messages.length === 0) {
          return { text: 'No scheduled messages found.' };
        }

        return {
          text: messages
            .map(
              (message) =>
                `- **${message.name}**:  ${inlineCode(message.cronExpression)} in ~${message.channelId}: ${message.message}`,
            )
            .join('\n'),
        };
      },
    );

    await this.mattermost.registerCommand(
      {
        trigger: 'schedule-edit',
        display_name: 'Edit schedule',
        description: 'Edit an existing scheduled message',
        team_id: Constants.Mattermost.Teams.Immich,
        auto_complete: true,
        auto_complete_desc: 'The name of the scheduled message to edit',
        parameters: [{ name: 'name', type: 'text', optional: false }],
      },
      async ({ trigger_id, parameters: { name } }) => {
        const message = await this.database.getScheduledMessage(name, 'mattermost');
        if (!message) {
          return 'Scheduled message not found';
        }

        void (async () => {
          const response = await this.mattermost.openDialog(trigger_id, {
            title: message.name,
            elements: [
              {
                type: 'text',
                display_name: 'Cron expression',
                name: 'cronExpression',
                default: message.cronExpression,
              },
              { type: 'textarea', display_name: 'Message', name: 'message', default: message.message },
              {
                type: 'bool',
                display_name: 'Suppress embeds',
                name: 'suppressEmbeds',
                optional: true,
                default: String(message.suppressEmbeds),
              },
            ],
          });

          if (response.cancelled) {
            return;
          }

          const { cronExpression, message: text, suppressEmbeds } = response;
          await this.updateScheduledMessage(name, 'mattermost', { cronExpression, message: text, suppressEmbeds });
        })().catch((error) => this.logger.error(`Failed to edit scheduled message ${name}: ${error}`));
      },
    );
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

  async updateScheduledMessage(name: string, service: Service, changes: UpdateScheduledMessage) {
    if (changes.cronExpression !== undefined) {
      validateCronExpression(changes.cronExpression);
    }
    if (!(await this.database.getScheduledMessage(name, service))) {
      return;
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

  async deleteScheduledMessage(name: string, service: Service) {
    const message = await this.database.getScheduledMessage(name, service);
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

  async listScheduledMessages(service: Service) {
    return this.database.getScheduledMessages(service);
  }
}

const validateCronExpression = (cronExpression: string) => {
  try {
    new CronJob(cronExpression, () => {});
  } catch (error) {
    throw new Error(`Invalid cron expression ${cronExpression}: ${error}`, { cause: error });
  }
};
