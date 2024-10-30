import { Injectable } from '@nestjs/common';
import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  ThreadChannel,
  type CommandInteraction,
} from 'discord.js';
import { Discord, ModalComponent, Slash, SlashOption } from 'discordx';
import { Constants, DiscordField, DiscordModal } from 'src/constants';
import { DiscordChannel } from 'src/interfaces/discord.interface';
import { DiscordService } from 'src/services/discord.service';

const authGuard = async (interaction: CommandInteraction) => {
  const isValid = [
    // allowed channels
    DiscordChannel.BotSpam,
    DiscordChannel.SupportCrew,
    DiscordChannel.QQ,
  ].includes(interaction.channelId as DiscordChannel);

  if (!isValid) {
    await interaction.reply({
      content: 'This command is not available in this channel',
      ephemeral: true,
    });
  }

  return isValid;
};

@Discord()
@Injectable()
export class DiscordCommands {
  constructor(private service: DiscordService) {}

  @Slash({ name: 'link-add', description: 'Add a new link' })
  async addLink(
    @SlashOption({
      description: 'The link name',
      name: 'name',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    name: string,
    @SlashOption({
      description: 'The link value',
      name: 'link',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    link: string,
    interaction: CommandInteraction,
  ) {
    if (!(await authGuard(interaction))) {
      return;
    }

    const message = await this.service.addLink({
      name,
      link,
      author: interaction.user.username,
    });

    return interaction.reply({ content: message, flags: [MessageFlags.SuppressEmbeds] });
  }

  @Slash({ name: 'link-remove', description: 'Remove an existing link' })
  async removeLink(
    @SlashOption({
      description: 'The name of the link to remove',
      name: 'name',
      required: true,
      autocomplete: true,
      type: ApplicationCommandOptionType.String,
    })
    name: string,
    interaction: CommandInteraction | AutocompleteInteraction,
  ) {
    if (interaction.isAutocomplete()) {
      const value = interaction.options.getFocused(true).value;
      const message = await this.service.getLinks(value);
      return interaction.respond(message);
    }

    if (!(await authGuard(interaction))) {
      return;
    }

    const { message, isPrivate } = await this.service.removeLink({ name });

    return interaction.reply({ content: message, ephemeral: isPrivate, flags: [MessageFlags.SuppressEmbeds] });
  }

  @Slash({ name: 'age', description: 'Immich age' })
  handleAge(interaction: CommandInteraction) {
    const message = this.service.getAge();
    return interaction.reply(message);
  }

  @Slash({ name: 'forks', description: 'Immich forks' })
  async handleForks(interaction: CommandInteraction) {
    const message = await this.service.getForksMessage(interaction.channelId);
    return interaction.reply(message);
  }

  @Slash({ name: 'release-notes', description: 'Release notes' })
  handleReleaseNotes(interaction: CommandInteraction) {
    const message = this.service.getReleaseNotes();
    return interaction.reply({ content: message, flags: [MessageFlags.SuppressEmbeds] });
  }

  @Slash({ name: 'stars', description: 'Immich stars' })
  async handleStars(interaction: CommandInteraction) {
    const message = await this.service.getStarsMessage(interaction.channelId);
    return interaction.reply(message);
  }

  @Slash({ name: 'link', description: 'Links to Immich pages' })
  async handleLink(
    @SlashOption({
      description: 'Which docs do you need?',
      name: 'type',
      required: true,
      autocomplete: true,
      type: ApplicationCommandOptionType.String,
    })
    name: string,
    @SlashOption({
      description: 'Text that will be prepended before the link',
      name: 'text',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    message: string | null,
    interaction: CommandInteraction | AutocompleteInteraction,
  ) {
    if (interaction.isAutocomplete()) {
      const value = interaction.options.getFocused(true).value;
      const message = await this.service.getLinks(value);
      return interaction.respond(message);
    }

    const { message: content, isPrivate } = await this.service.getLink(name, message);
    return interaction.reply({ content, ephemeral: isPrivate, flags: [MessageFlags.SuppressEmbeds] });
  }

  @Slash({ name: 'tags', description: 'Returns the currently set tags' })
  async handleGetTags(interaction: CommandInteraction) {
    const members = interaction.guild?.members.cache;
    if (!members?.get(interaction.user.id)?.roles.cache.has(Constants.Roles.Contributor)) {
      return;
    }

    const channel = interaction.channel;
    if (channel instanceof ThreadChannel) {
      await interaction.reply(channel.appliedTags.join(', '));
    }
  }
  @Slash({ name: 'messages', description: 'Text blocks for reoccurring questions' })
  async handleMessages(
    @SlashOption({
      description: 'Which message do you need?',
      name: 'type',
      required: true,
      autocomplete: true,
      type: ApplicationCommandOptionType.String,
    })
    name: string,
    interaction: CommandInteraction | AutocompleteInteraction,
  ) {
    if (interaction.isAutocomplete()) {
      const value = interaction.options.getFocused(true).value;
      const message = await this.service.getMessages(value);
      return interaction.respond(message);
    }

    const message = await this.service.getMessage(name);

    if (!message) {
      return interaction.reply({ content: 'Message could not be found', ephemeral: true });
    }

    return interaction.reply({ content: message.content, flags: [MessageFlags.SuppressEmbeds] });
  }

  @Slash({ name: 'search', description: 'Search for PRs and Issues by title' })
  async handleSearch(
    @SlashOption({
      description: 'Query that applies to title',
      name: 'query',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: true,
    })
    id: string,
    interaction: CommandInteraction | AutocompleteInteraction,
  ) {
    if (interaction.isAutocomplete()) {
      const value = interaction.options.getFocused(true).value;
      const message = await this.service.handleSearchAutocompletion(value);
      return interaction.respond(message);
    }

    const content = await this.service.getPrOrIssue(Number(id));
    return interaction.reply({ content, flags: [MessageFlags.SuppressEmbeds] });
  }

  @Slash({ name: 'message-add', description: 'Add a new message' })
  async handleMessageAdd(interaction: CommandInteraction) {
    if (!(await authGuard(interaction))) {
      return;
    }

    const modal = new ModalBuilder({ customId: DiscordModal.Message, title: 'Add message' }).addComponents(
      new ActionRowBuilder<TextInputBuilder>({
        components: [
          new TextInputBuilder({ customId: DiscordField.Name, label: 'Message name', style: TextInputStyle.Short }),
        ],
      }),
      new ActionRowBuilder<TextInputBuilder>({
        components: [
          new TextInputBuilder({
            customId: DiscordField.Message,
            label: 'Message content',
            style: TextInputStyle.Paragraph,
          }),
        ],
      }),
    );

    return interaction.showModal(modal);
  }

  @Slash({ name: 'message-edit', description: 'Edit a message' })
  async handleMessageEdit(
    @SlashOption({
      name: 'name',
      description: 'The name of the message to edit',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: true,
    })
    messageName: string,
    interaction: CommandInteraction | AutocompleteInteraction,
  ) {
    if (interaction.isAutocomplete()) {
      const value = interaction.options.getFocused(true).value;
      const message = await this.service.getMessages(value);
      return interaction.respond(message);
    }

    if (!(await authGuard(interaction))) {
      return;
    }

    const message = await this.service.getMessage(messageName);

    if (!message) {
      return interaction.reply({ content: 'Message could not be found', ephemeral: true });
    }

    const modal = new ModalBuilder({ customId: DiscordModal.Message, title: 'Edit message' }).addComponents(
      new ActionRowBuilder<TextInputBuilder>({
        components: [
          new TextInputBuilder({
            customId: DiscordField.Name,
            label: 'Message name',
            style: TextInputStyle.Short,
            value: message.name,
          }),
        ],
      }),
      new ActionRowBuilder<TextInputBuilder>({
        components: [
          new TextInputBuilder({
            customId: DiscordField.Message,
            label: 'Message content',
            style: TextInputStyle.Paragraph,
            value: message.content,
          }),
        ],
      }),
    );

    return interaction.showModal(modal);
  }

  @Slash({ name: 'message-remove', description: 'Remove an existing message' })
  async handleMessageRemove(
    @SlashOption({
      description: 'The name of the message to remove',
      name: 'name',
      required: true,
      autocomplete: true,
      type: ApplicationCommandOptionType.String,
    })
    name: string,
    interaction: CommandInteraction | AutocompleteInteraction,
  ) {
    if (interaction.isAutocomplete()) {
      const value = interaction.options.getFocused(true).value;
      const message = await this.service.getMessages(value);
      return interaction.respond(message);
    }

    if (!(await authGuard(interaction))) {
      return;
    }

    const { message, isPrivate } = await this.service.removeMessage(name);

    return interaction.reply({ content: message, ephemeral: isPrivate, flags: [MessageFlags.SuppressEmbeds] });
  }

  @ModalComponent({ id: DiscordModal.Message })
  async handleMessageModal(interaction: ModalSubmitInteraction) {
    const name = interaction.fields.getTextInputValue(DiscordField.Name);
    const content = interaction.fields.getTextInputValue(DiscordField.Message);

    await this.service.addOrUpdateMessage({ name, content, author: interaction.user.id });

    await interaction.deferUpdate();
  }
}
