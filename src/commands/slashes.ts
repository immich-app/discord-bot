import {
  ApplicationCommandOptionType,
  MessageFlags,
  type CommandInteraction,
  AutocompleteInteraction,
  ThreadChannel,
} from 'discord.js';
import { Discord, Slash, SlashChoice, SlashOption } from 'discordx';
import { Constants } from '../constants.js';
import { DateTime } from 'luxon';
import { getForksMessage, getStarsMessage, handleSearchAutocompletion } from '../service.js';
import { BotRepository } from '../repositories/bot.repository.js';

const linkCommands: Record<string, string> = {
  'reverse proxy': Constants.Urls.Docs.ReverseProxy,
  database: Constants.Urls.Docs.Queries,
  upgrade: Constants.Urls.Docs.Upgrade,
  libraries: Constants.Urls.Docs.Libraries,
  'xmp sidecar': Constants.Urls.Docs.Sidecar,
  docker: Constants.Urls.Docs.Docker,
  backup: Constants.Urls.Docs.Backup,
  github: Constants.Urls.ImmichRepo,
  cli: Constants.Urls.Docs.CLI,
  'google-takeout': Constants.Urls.GoogleTakeOut,
  faq: Constants.Urls.Docs.FAQ,
};

export const HELP_TEXTS = {
  'docker logs': `View container logs by running \`docker compose logs\`. For further information refer to ${Constants.Urls.Docs.Docker}`,
  'help ticket': `Please open a <#${Constants.Channels.HelpDesk}> ticket with more information and we can help you troubleshoot the issue.`,
  'reverse proxy': `This sounds like it could be a reverse proxy issue. Here's a link to the relevant documentation page: ${Constants.Urls.Docs.ReverseProxy}.`,
  'feature request': `For ideas or features you'd like Immich to have, feel free to [open a feature request in the Github discussions](${Constants.Urls.FeatureRequest}). However, please make sure to search for similar requests first to avoid duplicates.`,
};

@Discord()
export class Commands {
  constructor(private repository: BotRepository = new BotRepository()) {}

  @Slash({ name: 'link', description: 'Links to Immich pages' })
  handleLink(
    @SlashChoice(...Object.keys(linkCommands))
    @SlashOption({
      description: 'Which docs do you need?',
      name: 'type',
      required: true,
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
    interaction: CommandInteraction,
  ) {
    return interaction.reply({
      content: message ? `${message}: ${linkCommands[name]}` : linkCommands[name],
      flags: [MessageFlags.SuppressEmbeds],
    });
  }

  @Slash({ name: 'messages', description: 'Text blocks for reoccurring questions' })
  handleMessages(
    @SlashChoice(...Object.keys(HELP_TEXTS))
    @SlashOption({
      description: 'Which message do you need',
      name: 'type',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    name: keyof typeof HELP_TEXTS,
    interaction: CommandInteraction,
  ) {
    return interaction.reply({
      content: HELP_TEXTS[name],
      flags: [MessageFlags.SuppressEmbeds],
    });
  }

  @Slash({ name: 'stars', description: 'Immich stars' })
  async handleStars(interaction: CommandInteraction) {
    return interaction.reply(await getStarsMessage(this.repository, interaction.channelId));
  }

  @Slash({ name: 'forks', description: 'Immich forks' })
  async handleForks(interaction: CommandInteraction) {
    return interaction.reply(await getForksMessage(this.repository, interaction.channelId));
  }

  @Slash({ name: 'age', description: 'Immich age' })
  handleAge(interaction: CommandInteraction) {
    const age = DateTime.now()
      .diff(DateTime.fromObject({ year: 2022, month: 2, day: 3, hour: 15, minute: 56 }, { zone: 'UTC' }), [
        'years',
        'months',
        'days',
        'hours',
        'minutes',
        'seconds',
      ])
      .toHuman({ listStyle: 'long', maximumFractionDigits: 0 });

    return interaction.reply(`Immich is ${age} old. ${Constants.Icons.Immich}`);
  }

  @Slash({ name: 'search', description: 'Search for PRs and Issues by title' })
  async handleSearch(
    @SlashOption({
      description: 'Query that applies to title',
      name: 'query',
      required: true,
      type: ApplicationCommandOptionType.String,
      autocomplete: async (interaction: AutocompleteInteraction) =>
        interaction.respond(
          await handleSearchAutocompletion(new BotRepository(), interaction.options.getFocused(true).value),
        ),
    })
    id: string,
    interaction: CommandInteraction,
  ) {
    const content = await this.repository.getIssueOrPr(id);
    return interaction.reply({ content, flags: [MessageFlags.SuppressEmbeds] });
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
}
