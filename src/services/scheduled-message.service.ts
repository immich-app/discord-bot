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
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { NewScheduledMessage } from 'src/schema';
import { shorten } from 'src/util';

@Discord()
@Injectable()
export class ScheduledMessageService {
  private logger = new Logger(ScheduledMessageService.name);
  private jobs = new Map<string, CronJob>();

  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
    @Inject(IMattermostInterface) private mattermost: IMattermostInterface,
  ) {}

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
        const message = await this.removeScheduledMessage(name);
        return {
          response_type: 'in_channel',
          text: message,
        };
      },
    );
  }

  private registerJob({
    id,
    cronExpression,
    channelId,
    message,
    suppressEmbeds,
    service,
  }: {
    id: string;
    cronExpression: string;
    channelId: string;
    message: string;
    suppressEmbeds: boolean;
    service: 'discord' | 'mattermost';
  }) {
    const job = CronJob.from({
      cronTime: cronExpression,
      onTick: async () => {
        try {
          if (service === 'discord') {
            await this.discord.sendMessage({
              channelId,
              message: { content: message, flags: suppressEmbeds ? [MessageFlags.SuppressEmbeds] : [] },
            });
          } else {
            await this.mattermost.send({
              channelId,
              message,
              props: suppressEmbeds ? { remove_link_preview: 'true' } : undefined,
            });
          }
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
      throw new Error(`Invalid cron expression ${entity.cronExpression}: ${error}`, { cause: error });
    }

    const message = await this.database.createScheduledMessage(entity);
    this.registerJob(message);
  }

  async editScheduledMessage(name: string) {
    const message = await this.database.getScheduledMessage(name);
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

    await this.jobs.get(updatedMessage.id)?.stop();
    this.registerJob(updatedMessage);

    await interaction.reply(`Successfully updated scheduled message ${inlineCode(updatedMessage.name)}`);
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
