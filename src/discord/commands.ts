import { Injectable } from '@nestjs/common';
import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  GuildMember,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  ThreadChannel,
  type CommandInteraction,
} from 'discord.js';
import { Discord, ModalComponent, Slash, SlashChoice, SlashOption } from 'discordx';
import { Constants, DiscordField, DiscordModal } from 'src/constants';
import { DiscordChannel } from 'src/interfaces/discord.interface';
import { DiscordService } from 'src/services/discord.service';
import { RSSService } from 'src/services/rss.service';
import { ScheduledMessageService } from 'src/services/scheduled-message.service';

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
  constructor(
    private service: DiscordService,
    private rssService: RSSService,
    private scheduledMessageService: ScheduledMessageService,
  ) {}

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
    if (!members?.get(interaction.user.id)?.roles.cache.has(Constants.Discord.Roles.Contributor)) {
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
    @SlashOption({
      description: 'Text that will be prepended before the message',
      name: 'text',
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    preface: string | null,
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

    return interaction.reply({
      content: preface ? `${preface} - ${message.content}` : message.content,
      flags: [MessageFlags.SuppressEmbeds],
    });
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

    const message = await this.service.addOrUpdateMessage({ name, content, author: interaction.user.id });

    await interaction.reply(message);
  }

  @Slash({ name: 'emote-add', description: 'Add new emotes to the server' })
  async handleEmoteAdd(
    @SlashChoice('emote', '7tv', 'bttv')
    @SlashOption({
      name: 'source',
      description: 'Where the emote is from',
      type: ApplicationCommandOptionType.String,
      required: true,
    })
    source: '7tv' | 'bttv' | 'emote',
    @SlashOption({
      name: 'id',
      description: 'ID of the emote',
      type: ApplicationCommandOptionType.String,
      required: true,
    })
    id: string,
    @SlashOption({
      name: 'name',
      description: 'Name of the emote. If unspecified uses the one from 7TV/BTTV',
      type: ApplicationCommandOptionType.String,
      required: false,
    })
    name: string | null,
    interaction: CommandInteraction,
  ) {
    let emote;
    switch (source) {
      case '7tv':
        emote = await this.service.create7TvEmote(id, interaction.guildId, name);
        break;
      case 'bttv':
        emote = await this.service.createBttvEmote(id, interaction.guildId, name);
        break;
      case 'emote':
        emote = await this.service.createEmoteFromExistingOne(id, interaction.guildId, name);
    }

    if (!emote) {
      await interaction.reply({ content: `Could not find ${source.toUpperCase()} emote with id ${id}` });
      return;
    }

    await interaction.reply({ content: `Emote \`${emote.toString()}\` successfully added! ${emote.toString()}` });
  }

  @Slash({ name: 'rss-subscribe', description: 'Subscribe to an RSS feed' })
  async handleSubscribeRSSFeed(
    @SlashOption({
      name: 'url',
      description: 'URL pointing to an RSS feed',
      type: ApplicationCommandOptionType.String,
      required: true,
    })
    url: string,
    interaction: CommandInteraction,
  ) {
    try {
      await this.rssService.createRSSFeed(url, interaction.channelId);
      await interaction.reply({ content: `Successfully added ${url}.`, flags: [MessageFlags.SuppressEmbeds] });
    } catch (error) {
      await interaction.reply({
        content: `Could not add ${url}: ${error}`,
        flags: [MessageFlags.Ephemeral, MessageFlags.SuppressEmbeds],
      });
    }
  }

  @Slash({ name: 'rss-unsubscribe', description: 'Unsubscribe from an existing RSS feed' })
  async handleUnsubscribeRSSFeed(
    @SlashOption({
      description: 'URL of the RSS feed to be removed',
      name: 'url',
      required: true,
      autocomplete: true,
      type: ApplicationCommandOptionType.String,
    })
    url: string,
    interaction: CommandInteraction | AutocompleteInteraction,
  ) {
    if (interaction.isAutocomplete()) {
      const value = interaction.options.getFocused(true).value;
      const message = await this.rssService.searchRSSFeeds(value, interaction.channelId);
      return interaction.respond(message);
    }

    await this.rssService.removeRSSFeed(url, interaction.channelId);

    return interaction.reply({ content: `Successfully removed ${url}.`, flags: [MessageFlags.SuppressEmbeds] });
  }

  @Slash({ name: 'fourthwall', description: 'Fourthwall related commmands' })
  async handleFourthwall(
    @SlashChoice('update')
    @SlashOption({
      name: 'action',
      description: 'update: Updates Fourthwall orders',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    action: 'update',
    @SlashOption({
      name: 'id',
      description: 'Id of a specific order to update',
      type: ApplicationCommandOptionType.String,
      required: false,
    })
    id: string | null,
    interaction: CommandInteraction,
  ) {
    switch (action) {
      case 'update': {
        await this.service.updateFourthwallOrders(id);
        return interaction.reply({
          content: 'Successfully updated Fourthwall orders',
          flags: [MessageFlags.Ephemeral],
        });
      }
    }
  }

  @Slash({ name: 'emote-sync', description: 'Syncs Discord emotes to Zulip' })
  async handleEmoteSync(interaction: CommandInteraction) {
    await this.service.syncEmotes(interaction);
  }

  @Slash({ name: 'prune', description: 'Deletes all recent messages of a timed out user' })
  async handleCleanUp(
    @SlashOption({
      name: 'user',
      description: 'The timed out user to delete recent messages of',
      type: ApplicationCommandOptionType.User,
      required: true,
    })
    member: GuildMember,
    @SlashOption({
      name: 'timespan',
      description: 'Delete all messages in the past x minutes',
      type: ApplicationCommandOptionType.Number,
      required: false,
    })
    minutes: number = 5,
    interaction: CommandInteraction,
  ) {
    if (!member.isCommunicationDisabled()) {
      await interaction.reply({
        content: `${member.user.toString()} must be timeouted first`,
        flags: [MessageFlags.Ephemeral],
      });
    }

    const deferredInteraction = await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    await this.service.pruneMessages(interaction, member, minutes);

    await deferredInteraction.edit(`Successfully cleaned up ${member.user.toString()}`);
  }

  @Slash({ name: 'schedule-add', description: 'Create a recurring scheduled message' })
  async handleScheduleAdd(
    @SlashOption({
      name: 'name',
      description: 'A unique name for this scheduled message',
      type: ApplicationCommandOptionType.String,
      required: true,
    })
    name: string,
    @SlashOption({
      name: 'cron',
      description: 'Cron expression (e.g. "0 9 * * 1" for every Monday at 9am UTC)',
      type: ApplicationCommandOptionType.String,
      required: true,
    })
    cronExpression: string,
    @SlashOption({
      name: 'message',
      description: 'The message to send (supports role pings like <@&roleId>)',
      type: ApplicationCommandOptionType.String,
      required: true,
    })
    message: string,
    @SlashOption({
      name: 'channel',
      description: 'The channel to send to (defaults to current channel)',
      type: ApplicationCommandOptionType.Channel,
      required: false,
    })
    channel: { id: string } | null,
    interaction: CommandInteraction,
  ) {
    const channelId = channel?.id ?? interaction.channelId;

    try {
      await this.scheduledMessageService.createScheduledMessage({
        name,
        cronExpression,
        message,
        channelId,
        createdBy: interaction.user.id,
      });

      return interaction.reply({
        content: `Scheduled message \`${name}\` created with cron \`${cronExpression}\` in <#${channelId}>`,
        flags: [MessageFlags.Ephemeral],
      });
    } catch (error) {
      return interaction.reply({
        content: `Failed to create scheduled message: ${error}`,
        flags: [MessageFlags.Ephemeral],
      });
    }
  }

  @Slash({ name: 'schedule-remove', description: 'Remove a scheduled message' })
  async handleScheduleRemove(
    @SlashOption({
      name: 'name',
      description: 'The name of the scheduled message to remove',
      type: ApplicationCommandOptionType.String,
      required: true,
      autocomplete: true,
    })
    name: string,
    interaction: CommandInteraction | AutocompleteInteraction,
  ) {
    if (interaction.isAutocomplete()) {
      const value = interaction.options.getFocused(true).value;
      const results = await this.scheduledMessageService.getScheduledMessages(value);
      return interaction.respond(results);
    }

    const { message, isPrivate } = await this.scheduledMessageService.removeScheduledMessage(name);
    return interaction.reply({ content: message, ephemeral: isPrivate });
  }

  @Slash({ name: 'schedule-list', description: 'List all scheduled messages' })
  async handleScheduleList(interaction: CommandInteraction) {
    const messages = await this.scheduledMessageService.listScheduledMessages();

    if (messages.length === 0) {
      return interaction.reply({ content: 'No scheduled messages found.', flags: [MessageFlags.Ephemeral] });
    }

    const list = messages
      .map((m) => `- **${m.name}** — \`${m.cronExpression}\` in <#${m.channelId}>\n  ${m.message}`)
      .join('\n');

    return interaction.reply({ content: `**Scheduled Messages:**\n${list}`, flags: [MessageFlags.Ephemeral] });
  }
}
