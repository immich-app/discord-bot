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
  getLogsUploadModel,
  getHelpDeskWelcomeMessage,
  getComposeUploadModal,
  getEnvUploadModal,
  getComposeButton,
  getEnvButton,
  getLogsButton,
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
    console.time();
    if (reaction.partial) {
      await reaction.fetch();
    }
    console.timeLog();

    if (!reaction.message.author?.bot) {
      return;
    }

    const channel = reaction.message.channel;

    if (channel instanceof ThreadChannel) {
      if (channel.parentId !== Constants.Channels.HelpDesk) {
        return;
      }
    }

    const message = getHelpDeskWelcomeMessage(
      reaction.message.thread?.ownerId ?? '',
      reaction.message.reactions.cache.map((reaction) => reaction.count > 1),
    );
    console.timeLog();

    if (!message.includes(Constants.Icons.Unchecked)) {
      mainButtonRow.components.at(-1)?.setDisabled(false);

      await reaction.message.edit({ content: message, components: [mainButtonRow] });
    } else {
      mainButtonRow.components.at(-1)?.setDisabled(true);
      const thread = reaction.message.channel as ThreadChannel;
      await thread.setAppliedTags(thread.appliedTags.filter((tag) => tag !== Constants.Tags.Ready));

      await reaction.message.edit({ content: message, components: [mainButtonRow] });
    }
    console.timeEnd();
  }

  @On({ event: 'threadCreate' })
  async handleThreadCreate([thread]: ArgsOf<'threadCreate'>) {
    const welcomeMessage = getHelpDeskWelcomeMessage(thread.ownerId ?? '');
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

    if (channel.ownerId !== interaction.user.id) {
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
