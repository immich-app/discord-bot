import {
  ApplicationCommandOptionType,
  MessageFlags,
  type CommandInteraction,
  AutocompleteInteraction,
  ThreadChannel,
} from 'discord.js';
import { Discord, Slash, SlashChoice, SlashOption } from 'discordx';
import { IMMICH_REPOSITORY_BASE_OPTIONS, Constants } from '../constants.js';
import { DateTime } from 'luxon';
import { Octokit } from '@octokit/rest';
import { getIssueOrPr } from '../utils.js';

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

const _star_history: Record<string, number | undefined> = {};
const _fork_history: Record<string, number | undefined> = {};

const octokit = new Octokit();

@Discord()
export class Commands {
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
    const lastStarsCount = _star_history[interaction.channelId];

    try {
      const starsCount = await octokit.rest.repos
        .get(IMMICH_REPOSITORY_BASE_OPTIONS)
        .then((repo) => repo.data.stargazers_count);
      const delta = lastStarsCount && starsCount - lastStarsCount;
      const formattedDelta = delta && Intl.NumberFormat(undefined, { signDisplay: 'always' }).format(delta);

      await interaction.reply(
        `Stars ⭐: ${starsCount}${
          formattedDelta ? ` (${formattedDelta} stars since the last call in this channel)` : ''
        }`,
      );

      _star_history[interaction.channelId] = starsCount;
    } catch (error) {
      await interaction.reply("Couldn't fetch stars count from github api");
    }
  }

  @Slash({ name: 'forks', description: 'Immich forks' })
  async handleForks(interaction: CommandInteraction) {
    const lastForksCount = _fork_history[interaction.channelId];

    try {
      const forksCount = await octokit.rest.repos
        .get(IMMICH_REPOSITORY_BASE_OPTIONS)
        .then((repo) => repo.data.forks_count);
      const delta = lastForksCount && forksCount - lastForksCount;
      const formattedDelta = delta && Intl.NumberFormat(undefined, { signDisplay: 'always' }).format(delta);

      await interaction.reply(
        `Forks: ${forksCount}${formattedDelta ? ` (${formattedDelta} forks since the last call in this channel)` : ''}`,
      );

      _fork_history[interaction.channelId] = forksCount;
    } catch (error) {
      await interaction.reply("Couldn't fetch forks count from github api");
    }
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
      autocomplete: async (interaction: AutocompleteInteraction) => {
        const value = interaction.options.getFocused(true).value;
        if (!value) {
          return interaction.respond([]);
        }

        try {
          const result = await octokit.rest.search
            .issuesAndPullRequests({
              q: `repo:immich-app/immich in:title ${value}`,
              per_page: 5,
              page: 1,
              sort: 'updated',
              order: 'desc',
            })
            .then((response) => response.data);
          return interaction.respond(
            result.items.map((item) => {
              const name = `${item.pull_request ? '[PR]' : '[Issue]'} (${item.number}) ${item.title}`;
              return {
                name: name.length > 100 ? name.substring(0, 97) + '...' : name,
                value: String(item.number),
              };
            }),
          );
        } catch (error) {
          console.log('Could not fetch search results from GitHub');
          return interaction.respond([]);
        }
      },
    })
    id: string,
    interaction: CommandInteraction,
  ) {
    const content = await getIssueOrPr(octokit, id);
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
