import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  MessageActionRowComponentBuilder,
  ThreadChannel,
} from 'discord.js';
import { ArgsOf, ButtonComponent, Discord, On } from 'discordx';
import { HELP_TEXTS } from '../../commands/slashes.js';
import { CHECKED_ICON, Ids, UNCHECKED_ICON } from '../../constants.js';

const hammerButton = new ButtonBuilder({
  url: 'https://www.amazon.com/s?k=hammer',
  emoji: '🔨',
  label: 'Get A Hammer',
  style: ButtonStyle.Link,
});

const reverseProxyButton = new ButtonBuilder({
  customId: 'reverseProxy',
  label: 'Reverse Proxy',
  style: ButtonStyle.Primary,
});

const submitButton = new ButtonBuilder({
  customId: 'submit',
  label: 'Submit',
  style: ButtonStyle.Success,
  disabled: true,
});

const mainButtonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
  hammerButton,
  reverseProxyButton,
  submitButton,
);

@Discord()
export class HelpTicket {
  @ButtonComponent({ id: 'reverseProxy' })
  reverseProxyHandler(interaction: ButtonInteraction): void {
    interaction.reply({ content: HELP_TEXTS['reverse proxy'] });
  }

  @ButtonComponent({ id: 'submit' })
  async submitHandler(interaction: ButtonInteraction): Promise<void> {
    const thread = interaction.message.channel as ThreadChannel;
    if (thread.appliedTags.find((tag) => tag === Ids.Tags.Ready)) {
      return;
    }

    await interaction.reply(`Successfully submitted, a tag has been added to inform contributors. :white_check_mark:`);
    await thread.setAppliedTags([...thread.appliedTags, Ids.Tags.Ready]);
  }

  @On({ event: 'messageReactionRemove' })
  @On({ event: 'messageReactionAdd' })
  async reactListener([reaction]: ArgsOf<'messageReactionAdd'>) {
    if (reaction.partial) {
      await reaction.fetch();
    }

    if (!reaction.message.author?.bot) {
      return;
    }

    if (reaction.message.channelId !== Ids.Channels.HelpDesk) {
      return;
    }

    const number = reaction.emoji.name!.substring(0, 1);
    const newIcon = reaction.count! > 1 ? CHECKED_ICON : UNCHECKED_ICON;

    const message = reaction.message
      .content!.replace(`${number}. ${UNCHECKED_ICON}`, `${number}. ${newIcon}`)
      .replace(`${number}. ${CHECKED_ICON}`, `${number}. ${newIcon}`);

    if (!message.includes(UNCHECKED_ICON)) {
      mainButtonRow.components[2].setDisabled(false);

      await reaction.message.edit({ content: message, components: [mainButtonRow] });
    } else {
      mainButtonRow.components[2].setDisabled(true);
      const thread = reaction.message.channel as ThreadChannel;
      await thread.setAppliedTags(thread.appliedTags.filter((tag) => tag !== Ids.Tags.Ready));

      await reaction.message.edit({ content: message, components: [mainButtonRow] });
    }
  }
}
