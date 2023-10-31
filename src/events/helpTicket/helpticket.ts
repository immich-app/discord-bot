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
import { READY_TAG_ID } from './util.js';

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
    if (thread.appliedTags.find((tag) => tag === READY_TAG_ID)) {
      return;
    }

    await interaction.reply(`Successfully submitted, a tag has been added to inform contributors. :white_check_mark:`);
    await thread.setAppliedTags([...thread.appliedTags, READY_TAG_ID]);
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

    // if (reaction.message.channelId !== helpDeskChannelId) {
    //   return;
    // }

    const number = reaction.emoji.name!.substring(0, 1);
    const newIcon = reaction.count! > 1 ? ':ballot_box_with_check:' : ':blue_square:';

    let message = reaction.message.content!.replace(`${number}. :blue_square:`, `${number}. ${newIcon}`);
    message = message.replace(`${number}. :ballot_box_with_check:`, `${number}. ${newIcon}`);

    if (!message.includes(':blue_square')) {
      mainButtonRow.components[2].setDisabled(false);

      await reaction.message.edit({ content: message, components: [mainButtonRow] });
    } else {
      mainButtonRow.components[2].setDisabled(true);
      const thread = reaction.message.channel as ThreadChannel;
      await thread.setAppliedTags(thread.appliedTags.filter((tag) => tag !== READY_TAG_ID));

      await reaction.message.edit({ content: message, components: [mainButtonRow] });
    }
  }
}
