import {
  ButtonInteraction,
  ModalBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  ForumChannel,
  MessageActionRowComponentBuilder,
  ModalSubmitInteraction,
} from 'discord.js';
import { ButtonComponent, Discord, ModalComponent } from 'discordx';
import {
  BUG_BUTTON_ID,
  getComposeButton,
  getDescriptionInput,
  getEnvButton,
  getLogsButton,
  getTitleInput,
  helpDeskWelcomeMessage,
} from './util.js';
import { Ids } from '../../constants.js';

@Discord()
export class Bug {
  @ButtonComponent({ id: BUG_BUTTON_ID })
  async handleBugClick(interaction: ButtonInteraction): Promise<void> {
    const modal = new ModalBuilder({
      customId: 'bugModal',
      title: "Basic information about the bug you've found",
    });

    const rowOne = new ActionRowBuilder<TextInputBuilder>({ components: [getTitleInput()] });
    const rowTwo = new ActionRowBuilder<TextInputBuilder>({ components: [getDescriptionInput()] });

    modal.addComponents(rowOne, rowTwo);

    await interaction.showModal(modal);
  }

  @ModalComponent()
  async handleBugModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const helpDeskChannel = (await interaction.client.channels.fetch(Ids.Channels.HelpDesk)) as ForumChannel;
    const channel = await helpDeskChannel.threads.create({
      name: `[Bug] ${interaction.fields.getTextInputValue('titleInput')}`,
      message: { content: interaction.fields.getTextInputValue('descriptionInput') },
      appliedTags: [Ids.Tags.Question],
    });
    const buttonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      getComposeButton(channel.id),
      getEnvButton(channel.id),
      getLogsButton(channel.id),
    );

    const message = await channel.send(helpDeskWelcomeMessage(interaction.user.id));

    await Promise.all([
      async () => {
        await message.react('1️⃣');
        await message.react('2️⃣');
        await message.react('3️⃣');
        await message.react('4️⃣');
      },
      await interaction.reply({
        ephemeral: true,
        content: `A ticket has been opened for you: <#${channel.id}>. Please provide more information by clicking the buttons below and submitting required files.`,
        components: [buttonRow],
      }),
    ]);
  }
}
