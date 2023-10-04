import {
  ApplicationCommandOptionType,
  MessageFlags,
  type CommandInteraction,
} from 'discord.js';
import { Discord, Slash, SlashChoice, SlashOption } from 'discordx';

const docsDomain = 'https://docs.immich.app/docs';

const linkCommands: Record<string, string> = {
  'reverse proxy': `${docsDomain}/administration/reverse-proxy`,
  database: `${docsDomain}/guides/database-queries`,
  upgrade: `${docsDomain}/install/docker-compose#step-4---upgrading`,
  libraries: `${docsDomain}/features/libraries`,
  sidecar: `${docsDomain}/features/xmp-sidecars`,
  docker: `${docsDomain}/guides/docker-help`,
  backup: `${docsDomain}/administration/backup-and-restore`,
  github: 'https://github.com/immich-app/immich'
};
const helpTexts: Record<string, string> = {
  'help ticket':
    'Please open a <#1049703391762321418> ticket with more information and we can help you troubleshoot the issue.',
  'reverse proxy': `This sounds like it could be a reverse proxy issue. Here's a link to the relevant documentation page: ${docsDomain}/administration/reverse-proxy.`,
};

@Discord()
export class Commands {
  @Slash({ description: 'Links to Immich pages' })
  link(
    @SlashChoice(
      ...Object.keys(linkCommands),
    )
    @SlashOption({
      description: 'Which docs do you need?',
      name: 'type',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    name: string,
    interaction: CommandInteraction,
  ): void {
    interaction.reply({
      content: linkCommands[name],
      flags: [MessageFlags.SuppressEmbeds],
    });
  }

  @Slash({ description: 'Text blocks for reoccurring questions' })
  messages(
    @SlashChoice('help ticket', 'reverse proxy')
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
    try {
      const response = await (
        await fetch('https://api.github.com/repos/immich-app/immich')
      ).json();
      interaction.reply(`Stars ⭐: ${response['stargazers_count']}`);
    } catch (error) {
      interaction.reply("Couldn't fetch stars count from github api");
    }
  }

  @Slash({ description: 'Immich forks' })
  async forks(interaction: CommandInteraction) {
    try {
      const response = await (
        await fetch('https://api.github.com/repos/immich-app/immich')
      ).json();
      interaction.reply(`Forks: ${response['forks_count']}`);
    } catch (error) {
      interaction.reply("Couldn't fetch forks count from github api");
    }
  }
}
