import {
  ApplicationCommandOptionType,
  MessageFlags,
  type CommandInteraction,
  AutocompleteInteraction,
  ThreadChannel,
} from 'discord.js';
import { Discord, Slash, SlashChoice, SlashOption } from 'discordx';
import { DOCS_DOMAIN, IMMICH_REPOSITORY, IMMICH_REPOSITORY_BASE_OPTIONS, Ids } from '../constants.js';
import { DateTime } from 'luxon';
import { Octokit } from '@octokit/rest';

const linkCommands: Record<string, string> = {
  'reverse proxy': `${DOCS_DOMAIN}/administration/reverse-proxy`,
  database: `${DOCS_DOMAIN}/guides/database-queries`,
  upgrade: `${DOCS_DOMAIN}/install/docker-compose#step-4---upgrading`,
  libraries: `${DOCS_DOMAIN}/features/libraries`,
  'xmp sidecar': `${DOCS_DOMAIN}/features/xmp-sidecars`,
  docker: `${DOCS_DOMAIN}/guides/docker-help`,
  backup: `${DOCS_DOMAIN}/administration/backup-and-restore`,
  github: IMMICH_REPOSITORY,
  cli: `${DOCS_DOMAIN}/features/bulk-upload`,
  'google-takeout': `${IMMICH_REPOSITORY}/discussions/1340`,
};
export const HELP_TEXTS: Record<string, string> = {
  'help ticket': `Please open a <#${Ids.Channels.HelpDesk}> ticket with more information and we can help you troubleshoot the issue.`,
  'reverse proxy': `This sounds like it could be a reverse proxy issue. Here's a link to the relevant documentation page: ${DOCS_DOMAIN}/administration/reverse-proxy.`,
  'feature request':
    "For ideas or features you'd like Immich to have, feel free to [open a feature request in the Github discussions](https://github.com/immich-app/immich/discussions/new?category=feature-request). However, please make sure to search for similar requests first to avoid duplicates. ",
};

const _star_history: Record<string, number | undefined> = {};
const _fork_history: Record<string, number | undefined> = {};

const octokit = new Octokit();

@Discord()
export class Commands {
  @Slash({ description: 'Links to Immich pages' })
  link(
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
  ): void {
    interaction.reply({
      content: message ? `${message}: ${linkCommands[name]}` : linkCommands[name],
      flags: [MessageFlags.SuppressEmbeds],
    });
  }

  @Slash({ description: 'Text blocks for reoccurring questions' })
  messages(
    @SlashChoice(...Object.keys(HELP_TEXTS))
    @SlashOption({
      description: 'Which message do you need',
      name: 'type',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    name: string,
    interaction: CommandInteraction,
  ) {
    interaction.reply({
      content: HELP_TEXTS[name],
      flags: [MessageFlags.SuppressEmbeds],
    });
  }

  @Slash({ description: 'Immich stars' })
  async stars(interaction: CommandInteraction) {
    const lastStarsCount = _star_history[interaction.channelId];

    try {
      const starsCount = await octokit.rest.repos
        .get(IMMICH_REPOSITORY_BASE_OPTIONS)
        .then((repo) => repo.data.stargazers_count);
      const delta = lastStarsCount && starsCount - lastStarsCount;
      const formattedDelta = delta && Intl.NumberFormat(undefined, { signDisplay: 'always' }).format(delta);

      interaction.reply(
        `Stars ⭐: ${starsCount}${
          formattedDelta ? ` (${formattedDelta} stars since the last call in this channel)` : ''
        }`,
      );

      _star_history[interaction.channelId] = starsCount;
    } catch (error) {
      interaction.reply("Couldn't fetch stars count from github api");
    }
  }

  @Slash({ description: 'Immich forks' })
  async forks(interaction: CommandInteraction) {
    const lastForksCount = _fork_history[interaction.channelId];

    try {
      const forksCount = await octokit.rest.repos
        .get(IMMICH_REPOSITORY_BASE_OPTIONS)
        .then((repo) => repo.data.forks_count);
      const delta = lastForksCount && forksCount - lastForksCount;
      const formattedDelta = delta && Intl.NumberFormat(undefined, { signDisplay: 'always' }).format(delta);

      interaction.reply(
        `Forks: ${forksCount}${formattedDelta ? ` (${formattedDelta} forks since the last call in this channel)` : ''}`,
      );

      _fork_history[interaction.channelId] = forksCount;
    } catch (error) {
      interaction.reply("Couldn't fetch forks count from github api");
    }
  }

  @Slash({ description: 'Immich age' })
  age(interaction: CommandInteraction) {
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

    return interaction.reply(`Immich is ${age} old. <:immich:991481316950425643>`);
  }

  @Slash({ description: 'Search for PRs and Issues by title' })
  search(
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
              value: `${item.pull_request ? '[PR]' : '[Issue]'} ([#${item.number}](${item.url}))`,
            };
          }),
        );
      },
    })
    content: string,
    interaction: CommandInteraction,
  ) {
    return interaction.reply({ content, flags: [MessageFlags.SuppressEmbeds] });
  }

  @Slash({ name: 'tags', description: 'Returns the currently set tags' })
  async getTagIds(interaction: CommandInteraction) {
    const members = interaction.guild?.members.cache;
    if (!members?.get(interaction.user.id)?.roles.cache.has(Ids.Roles.Contributor)) {
      return;
    }

    const channel = interaction.channel;
    if (channel instanceof ThreadChannel) {
      await interaction.reply(channel.appliedTags.join(', '));
    }
  }
}
