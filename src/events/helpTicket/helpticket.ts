import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  BaseInteraction,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  CommandInteraction,
  MessageActionRowComponentBuilder,
  MessageFlags,
  ThreadChannel,
} from 'discord.js';
import { ArgsOf, ButtonComponent, Discord, On, Slash, SlashChoice, SlashOption } from 'discordx';
import { Constants } from '../../constants.js';
import {
  getComposeButton,
  getComposeUploadModal,
  getEnvButton,
  getEnvUploadModal,
  getHelpDeskWelcomeMessage,
  getLogsButton,
  getLogsUploadModel,
} from './util.js';

const submitButton = new ButtonBuilder({
  customId: 'submit',
  label: 'Submit',
  style: ButtonStyle.Success,
  disabled: true,
});

const mainButtonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
  getComposeButton(),
  getEnvButton(),
  getLogsButton(),
  submitButton,
);

async function sendHelpdeskWelcomeMessage(user: string, thread: ThreadChannel) {
  const welcomeMessage = getHelpDeskWelcomeMessage(user);
  const message = await thread.send({
      content: welcomeMessage,
      components: [mainButtonRow],
      flags: [MessageFlags.SuppressEmbeds],
    });

  const itemCount = welcomeMessage.match(new RegExp(Constants.Icons.Unchecked, 'g'))?.length ?? 0;
  for (let i = 1; i <= itemCount; i++) {
    await message.react(`${i}️⃣`);
  }
}

@Discord()
export class HelpTicket {
  @ButtonComponent({ id: 'submit' })
  async handleSubmit(interaction: ButtonInteraction): Promise<void> {
    const thread = interaction.message.channel as ThreadChannel;
    if (thread.appliedTags.find((tag) => tag === Constants.Tags.Ready)) {
      return;
    }

    await interaction.reply(`Successfully submitted, a tag has been added to inform contributors. :white_check_mark:`);
    await thread.setAppliedTags([...thread.appliedTags, Constants.Tags.Ready]);
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

    if (!(channel instanceof ThreadChannel)) {
      return;
    }

    if (channel.parentId !== Constants.Channels.HelpDesk) {
      return;
    }

    const message = getHelpDeskWelcomeMessage(
      channel.ownerId ?? '',
      reaction.message.reactions.cache.map((reaction) => reaction.count > 1),
    );

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
    if (thread.parentId !== Constants.Channels.HelpDesk) {
      return;
    }

    const user = thread.ownerId ?? '';
    await sendHelpdeskWelcomeMessage(user, await thread.fetch());
  }

  @Slash({ name: 'helpdesk', description: 'Trigger help desk message' })
  async handleHelpDeskCommand(interaction: CommandInteraction) {
    if (!interaction.channel?.isThread() || interaction.channel.parentId !== Constants.Channels.HelpDesk) {
      await interaction.reply({
        content: 'This command may only be executed in help desk threads',
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    const user = interaction.channel.ownerId ?? '';
    await sendHelpdeskWelcomeMessage(user, await interaction.channel.fetch())
    await interaction.reply({
      content: 'Helpdesk welcome message sent',
      flags: [MessageFlags.Ephemeral],
    });
  }

  @ButtonComponent({ id: 'openTicket' })
  @Slash({ name: 'open', description: 'Opens the ticket' })
  async handleTicketOpen(interaction: BaseInteraction) {
    const channel = interaction.channel;

    if (!(channel instanceof ThreadChannel) || channel.parentId !== Constants.Channels.HelpDesk) {
      if (interaction instanceof CommandInteraction) {
        return interaction?.reply({
          ephemeral: true,
          content: `This command can only be invoked in <#${Constants.Channels.HelpDesk}> tickets.`,
        });
      }
      return;
    }

    await channel.setArchived(false);
    await channel.lastMessage?.delete();
  }

  @Slash({ name: 'close', description: 'Closes the ticket. Can be re-opened if need be' })
  async handleTicketClose(interaction: CommandInteraction) {
    const channel = interaction.channel;
    if (!(channel instanceof ThreadChannel) || channel.parentId !== Constants.Channels.HelpDesk) {
      return interaction.reply({
        ephemeral: true,
        content: `This command can only be invoked in <#${Constants.Channels.HelpDesk}> tickets.`,
      });
    }

    const members = interaction.guild?.members.cache;
    const isContributor = members?.get(interaction.user.id)?.roles.cache.has(Constants.Roles.Contributor);

    if (!(isContributor || channel.ownerId === interaction.user.id)) {
      return interaction.reply({ ephemeral: true, content: 'Only the OP and contributors can close a thread.' });
    }

    const buttonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder({ customId: 'openTicket', label: 'Re-Open', style: ButtonStyle.Success }),
    );

    await interaction.reply({
      content: 'This thread has been closed. To re-open, use the button below.',
      components: [buttonRow],
    });
    await channel.setArchived(true);
  }

  @Slash({ name: 'upload', description: 'Upload files (env, logs, docker compose)' })
  handleFileUpload(
    @SlashChoice('logs', 'compose', 'env')
    @SlashOption({ name: 'type', description: 'type', type: ApplicationCommandOptionType.String, required: true })
    type: 'logs' | 'compose' | 'env',
    interaction: CommandInteraction,
  ) {
    const channel = interaction.channel;
    if (!(channel instanceof ThreadChannel) || channel.parentId !== Constants.Channels.HelpDesk) {
      return interaction.reply({
        ephemeral: true,
        content: `This command can only be invoked in <#${Constants.Channels.HelpDesk}> tickets.`,
      });
    }
    const members = interaction.guild?.members.cache;
    const isContributor = members?.get(interaction.user.id)?.roles.cache.has(Constants.Roles.Contributor);

    if (channel.ownerId !== interaction.user.id && !isContributor) {
      return interaction.reply({ ephemeral: true, content: 'Only the OP can add files to this thread.' });
    }

    switch (type) {
      case 'logs':
        return interaction.showModal(getLogsUploadModel());
      case 'compose':
        return interaction.showModal(getComposeUploadModal());
      case 'env':
        return interaction.showModal(getEnvUploadModal());
    }
  }
}
