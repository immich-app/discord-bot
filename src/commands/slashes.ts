import { ApplicationCommandOptionType, MessageFlags, type CommandInteraction } from 'discord.js';
import { Discord, Slash, SlashChoice, SlashOption } from 'discordx';
import { DOCS_DOMAIN, IMMICH_REPOSITORY, GITHUB_API_DOMAIN } from '../constants.js';
import { DateTime } from 'luxon';

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
const helpTexts: Record<string, string> = {
  'help ticket':
    'Please open a <#1049703391762321418> ticket with more information and we can help you troubleshoot the issue.',
  'reverse proxy': `This sounds like it could be a reverse proxy issue. Here's a link to the relevant documentation page: ${DOCS_DOMAIN}/administration/reverse-proxy.`,
  'feature request':
    "For ideas or features you'd like Immich to have, feel free to [open a feature request in the Github discussions](https://github.com/immich-app/immich/discussions/new?category=feature-request). However, please make sure to search for similar requests first to avoid duplicates. ",
};

const _star_history: Record<string, number | undefined> = {};
const _fork_history: Record<string, number | undefined> = {};

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
    @SlashChoice(...Object.keys(helpTexts))
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
      content: helpTexts[name],
      flags: [MessageFlags.SuppressEmbeds],
    });
  }

  @Slash({ description: 'Immich stars' })
  async stars(interaction: CommandInteraction) {
    const lastStarsCount = _star_history[interaction.channelId];

    try {
      const response = await (await fetch(GITHUB_API_DOMAIN)).json();
      const starsCount = response['stargazers_count'] as number;
      const delta = lastStarsCount && starsCount - lastStarsCount;
      const formattedDelta = delta && Intl.NumberFormat(undefined, { signDisplay: 'always' }).format(delta);

      interaction.reply(
        `Stars ⭐: ${response['stargazers_count']}${
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
      const response = await (await fetch(GITHUB_API_DOMAIN)).json();
      const forksCount = response['forks_count'] as number;
      const delta = lastForksCount && forksCount - lastForksCount;
      const formattedDelta = delta && Intl.NumberFormat(undefined, { signDisplay: 'always' }).format(delta);

      interaction.reply(
        `Forks: ${response['forks_count']}${
          formattedDelta ? ` (${formattedDelta} forks since the last call in this channel)` : ''
        }`,
      );

      _fork_history[interaction.channelId] = forksCount;
    } catch (error) {
      interaction.reply("Couldn't fetch forks count from github api");
    }
  }

  @Slash({ description: 'Immich age' })
  async age(interaction: CommandInteraction) {
    const birthday = DateTime.fromObject({ year: 2022, month: 2, day: 3 });
    const age = DateTime.now().diff(birthday, ['years', 'months']);

    if (age.months === 0) {
      await interaction.reply(
        `Immich is ${age.years} ${age.years > 1 ? 'years' : 'year'} old. <:immich:991481316950425643>`,
      );
    } else if (age.months === 6) {
      await interaction.reply(`Immich is ${age.years}.5 years old. <:immich:991481316950425643>`);
    } else {
      await interaction.reply(
        `Immich is ${age.years} ${age.years > 1 ? 'years' : 'year'} and ${Math.floor(age.months)} ${
          age.months > 1 ? 'months' : 'month'
        } old. <:immich:991481316950425643>`,
      );
    }
  }
}
