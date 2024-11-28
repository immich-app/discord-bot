import { Logger } from '@nestjs/common';
import {
  ActionRowBuilder,
  AnyThreadChannel,
  ApplicationCommandOptionType,
  BaseInteraction,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Channel,
  CommandInteraction,
  MessageActionRowComponentBuilder,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  ThreadChannel,
} from 'discord.js';
import { ArgsOf, ButtonComponent, Discord, ModalComponent, On, Slash, SlashChoice, SlashOption } from 'discordx';
import { Constants, DiscordButton, DiscordField, DiscordModal } from 'src/constants';
import { DiscordChannel } from 'src/interfaces/discord.interface';

const submitButton = new ButtonBuilder({
  customId: DiscordButton.Submit,
  label: 'Submit',
  style: ButtonStyle.Success,
  disabled: true,
});

const mainButtonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(submitButton);

enum UploadFileType {
  Logs = 'logs',
  Compose = 'compose',
  Env = 'env',
}

@Discord()
export class DiscordHelpDesk {
  private logger = new Logger(DiscordHelpDesk.name);

  @Slash({ name: 'helpdesk', description: 'Trigger help desk message' })
  async handleCreate(interaction: CommandInteraction) {
    if (!interaction.channel?.isThread() || interaction.channel.parentId !== DiscordChannel.HelpDesk) {
      await interaction.reply({
        content: 'This command may only be executed in help desk threads',
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    const user = interaction.channel.ownerId ?? '';
    await this.sendWelcomeMessage(user, await interaction.channel.fetch());
    await interaction.reply({
      content: 'Helpdesk welcome message sent',
      flags: [MessageFlags.Ephemeral],
    });
  }

  @Slash({ name: 'close', description: 'Closes the ticket. Can be re-opened if need be' })
  async handleClose(interaction: CommandInteraction) {
    const channel = interaction.channel;
    if (!(channel instanceof ThreadChannel) || channel.parentId !== DiscordChannel.HelpDesk) {
      return interaction.reply({
        ephemeral: true,
        content: `This command can only be invoked in <#${DiscordChannel.HelpDesk}> tickets.`,
      });
    }

    const members = interaction.guild?.members.cache;
    const userRoles = members?.get(interaction.user.id)?.roles.cache;
    const isContributor = userRoles?.has(Constants.Roles.Contributor);
    const isSupportCrew = userRoles?.has(Constants.Roles.SupportCrew);

    if (!(isContributor || isSupportCrew || channel.ownerId === interaction.user.id)) {
      return interaction.reply({ ephemeral: true, content: 'Only the OP and team members can close a thread.' });
    }

    const buttonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder({ customId: DiscordButton.OpenTicket, label: 'Re-Open', style: ButtonStyle.Success }),
    );

    await interaction.reply({
      content: 'This thread has been closed. To re-open, use the button below.',
      components: [buttonRow],
    });
    await channel.setArchived(true);
  }

  @Slash({ name: 'upload', description: 'Upload files (env, logs, docker compose)' })
  handleUpload(
    @SlashChoice(...Object.values(UploadFileType))
    @SlashOption({ name: 'type', description: 'type', type: ApplicationCommandOptionType.String, required: true })
    type: UploadFileType,
    interaction: CommandInteraction,
  ) {
    const channel = interaction.channel;
    if (!(channel instanceof ThreadChannel) || channel.parentId !== DiscordChannel.HelpDesk) {
      return interaction.reply({
        ephemeral: true,
        content: `This command can only be invoked in <#${DiscordChannel.HelpDesk}> tickets.`,
      });
    }
    const members = interaction.guild?.members.cache;
    const isContributor = members?.get(interaction.user.id)?.roles.cache.has(Constants.Roles.Contributor);

    if (channel.ownerId !== interaction.user.id && !isContributor) {
      return interaction.reply({ ephemeral: true, content: 'Only the OP can add files to this thread.' });
    }

    return interaction.showModal(this.buildModal(type));
  }

  @ButtonComponent({ id: DiscordButton.OpenTicket })
  @Slash({ name: 'open', description: 'Opens the ticket' })
  async handleReopen(interaction: BaseInteraction) {
    const channel = interaction.channel;

    if (!(channel instanceof ThreadChannel) || channel.parentId !== DiscordChannel.HelpDesk) {
      if (interaction instanceof CommandInteraction) {
        return interaction?.reply({
          ephemeral: true,
          content: `This command can only be invoked in <#${DiscordChannel.HelpDesk}> tickets.`,
        });
      }
      return;
    }

    await channel.setArchived(false);
    await channel.lastMessage?.delete();
  }

  @ButtonComponent({ id: DiscordButton.Submit })
  async handleSubmit(interaction: ButtonInteraction): Promise<void> {
    const thread = interaction.message.channel as ThreadChannel;
    if (thread.appliedTags.find((tag) => tag === Constants.Tags.Ready)) {
      return;
    }

    await interaction.reply(`Successfully submitted, a tag has been added to inform contributors. :white_check_mark:`);
    await thread.setAppliedTags([...thread.appliedTags, Constants.Tags.Ready]);
  }

  @ModalComponent({ id: DiscordModal.Logs })
  async handleLogsModal(interaction: ModalSubmitInteraction): Promise<void> {
    const logs = interaction.fields.getTextInputValue(DiscordField.Logs);
    const source = interaction.fields.getTextInputValue(DiscordField.Source);
    const channel = interaction.channel;

    if (channel?.isSendable()) {
      await channel.send({
        content: `${interaction.user} uploaded`,
        files: [{ attachment: Buffer.from(logs), name: `${source}.txt` }],
        flags: [MessageFlags.SuppressNotifications],
      });
    }

    await interaction.deferUpdate();
  }

  @ModalComponent({ id: DiscordModal.Compose })
  async handleComposeModal(interaction: ModalSubmitInteraction): Promise<void> {
    const compose = interaction.fields.getTextInputValue('compose');
    const channel = interaction.channel;

    if (channel?.isSendable()) {
      await channel.send({
        content: `${interaction.user} uploaded`,
        files: [{ attachment: Buffer.from(compose), name: 'docker-compose.yml' }],
        flags: [MessageFlags.SuppressNotifications],
      });
    }

    await interaction.deferUpdate();
  }

  @ModalComponent({ id: DiscordModal.Env })
  async handleEnvModal(interaction: ModalSubmitInteraction): Promise<void> {
    const env = interaction.fields.getTextInputValue(DiscordField.Env);
    const channel = interaction.channel;

    if (channel?.isSendable()) {
      await channel.send({
        content: `${interaction.user} uploaded`,
        files: [{ attachment: Buffer.from(env), name: 'env.txt' }],
        flags: [MessageFlags.SuppressNotifications],
      });
    }

    await interaction.deferUpdate();
  }

  @On({ event: 'messageReactionRemove' })
  @On({ event: 'messageReactionAdd' })
  async handleReaction([reaction]: ArgsOf<'messageReactionAdd'>) {
    if (reaction.partial) {
      await reaction.fetch();
    }

    if (!reaction.message.author?.bot) {
      return;
    }

    const channel = await reaction.message.channel.fetch();
    if (!this.isValidThread(channel)) {
      return;
    }

    const message = this.buildWelcomeMessage(
      channel.ownerId ?? '',
      reaction.message.reactions.cache.map((reaction) => reaction.count > 1),
    )[1];

    if (!message.includes(Constants.Icons.Unchecked)) {
      mainButtonRow.components.at(-1)?.setDisabled(false);
      await reaction.message.edit({ content: message, components: [mainButtonRow] });
    } else {
      mainButtonRow.components.at(-1)?.setDisabled(true);
      await channel.setAppliedTags(channel.appliedTags.filter((tag) => tag !== Constants.Tags.Ready));
      await reaction.message.edit({ content: message, components: [mainButtonRow] });
    }
  }

  @On({ event: 'threadCreate' })
  async handleThreadCreate([thread]: ArgsOf<'threadCreate'>) {
    if (!this.isValidThread(thread)) {
      return;
    }

    const user = thread.ownerId ?? '';
    const t = await thread.fetch();
    try {
      await this.sendWelcomeMessage(user, t);
    } catch (e) {
      this.logger.error('Retrying helpdesk welcome message:', e);
      setTimeout(async () => await this.sendWelcomeMessage(user, t), 5000);
    }
  }

  private isValidThread(channel: Channel | null): channel is AnyThreadChannel {
    if (!channel) {
      return false;
    }

    return channel.isThread() && channel.parentId === DiscordChannel.HelpDesk;
  }

  private async sendWelcomeMessage(user: string, thread: ThreadChannel) {
    const [welcomeMessage, tasks] = this.buildWelcomeMessage(user, []);
    await thread.send({
      content: welcomeMessage,
      flags: [MessageFlags.SuppressEmbeds],
    });
    const message = await thread.send({
      content: tasks,
      components: [mainButtonRow],
      flags: [MessageFlags.SuppressEmbeds],
    });

    const itemCount = tasks.match(new RegExp(Constants.Icons.Unchecked, 'g'))?.length ?? 0;
    for (let i = 1; i <= itemCount; i++) {
      await message.react(`${i}️⃣`);
    }
  }

  private buildModal(type: UploadFileType) {
    switch (type) {
      case UploadFileType.Logs:
        return new ModalBuilder({ customId: DiscordModal.Logs, title: 'Logs' }).addComponents(
          new ActionRowBuilder<TextInputBuilder>({
            components: [
              new TextInputBuilder({
                customId: DiscordField.Source,
                label: 'Where do those logs belong to?',
                style: TextInputStyle.Short,
                placeholder: 'immich_server',
              }),
            ],
          }),

          new ActionRowBuilder<TextInputBuilder>({
            components: [
              new TextInputBuilder({ customId: DiscordField.Logs, label: 'Logs', style: TextInputStyle.Paragraph }),
            ],
          }),
        );
      case UploadFileType.Compose:
        return new ModalBuilder({ customId: DiscordModal.Compose, title: 'docker-compose.yml' }).addComponents(
          new ActionRowBuilder<TextInputBuilder>({
            components: [
              new TextInputBuilder({
                customId: 'compose',
                label: 'docker-compose.yml',
                style: TextInputStyle.Paragraph,
              }),
            ],
          }),
        );
      case UploadFileType.Env:
        return new ModalBuilder({ customId: DiscordModal.Env, title: '.env' }).addComponents(
          new ActionRowBuilder<TextInputBuilder>({
            components: [
              new TextInputBuilder({ customId: DiscordField.Env, label: '.env', style: TextInputStyle.Paragraph }),
            ],
          }),
        );
    }
  }

  private buildWelcomeMessage(user: string, isChecked: boolean[]) {
    const icon = (index: number) => (isChecked[index] ? Constants.Icons.Checked : Constants.Icons.Unchecked);

    const tasks = [
      `I have verified I'm on the latest release(note that mobile app releases may take some time).`,
      `I have read applicable [release notes](${Constants.Urls.Release}).`,
      `I have reviewed the [FAQs](${Constants.Urls.Docs.FAQ}) for known issues.`,
      `I have reviewed [Github](${Constants.Urls.Issues}) for known issues.`,
      'I have tried accessing Immich via local ip (without a custom reverse proxy).',
      'I have uploaded the relevant information (see below).',
      'I have tried an incognito window, disabled extensions, cleared mobile app cache, logged out and back in, different browsers, etc. as applicable',
    ];

    return [
      `:wave: Hey <@${user}>,

Thanks for reaching out to us. Please carefully read this message and follow the recommended actions. This will help us be more effective in our support effort and leave more time for building Immich ${Constants.Icons.Immich}.
## References
- __Container Logs:__ \`docker compose logs\` [docs](${Constants.Urls.Docs.Logs})
- __Container Status__:  \`docker compose ps\` [docs](${Constants.Urls.Docs.Containers})
- __Reverse Proxy:__ ${Constants.Urls.Docs.ReverseProxy}`,
      `

## Checklist
${tasks.map((task, index) => `${index + 1}. ${icon(index)} ${task}`).join('\n')}

(an item can be marked as "complete" by reacting with the appropriate number)

## Information

In order to be able to effectively help you, we need you to provide clear information to show what the problem is. The exact details needed vary per case, but here is a list of things to consider:
- Your docker-compose.yml and .env files.
- Logs from all the containers.
- The status of the containers (\`docker ps -a\`).
- All the troubleshooting steps you've tried so far.
- Any recent changes you've made to Immich or your system.
- Details about your system (both software/OS and hardware).
- Details about your storage (filesystems, type of disks, output of commands like \`fdisk -l\` and \`df -h\`).
- The version of the Immich server, mobile app, and other relevant pieces.
- Any other information that you think might be relevant.

Please paste files and logs with proper [code formatting](${Constants.Urls.Formatting}), and especially avoid blurry screenshots.
Without the right information we can't work out what the problem is. Help us help you ;)

If this ticket can be closed you can use the \`/close\` command, and re-open it later if needed.`,
    ];
  }
}
