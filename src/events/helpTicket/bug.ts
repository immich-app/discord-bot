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
  HELP_DESK_CHANNEL_ID,
  QUESTION_TAG_ID,
  getComposeButton,
  getDescriptionInput,
  getEnvButton,
  getLogsButton,
  getTitleInput,
  helpDeskWelcomeMessage,
} from './util.js';

@Discord()
export class Bug {
  @ButtonComponent({ id: 'bug' })
  async bugHandler(interaction: ButtonInteraction): Promise<void> {
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
  async bugModal(interaction: ModalSubmitInteraction): Promise<void> {
    const helpDeskChannel = (await interaction.client.channels.fetch(HELP_DESK_CHANNEL_ID)) as ForumChannel;
    const channel = await helpDeskChannel.threads.create({
      name: `[Bug] ${interaction.fields.getTextInputValue('titleInput')}`,
      message: { content: interaction.fields.getTextInputValue('descriptionInput') },
      appliedTags: [QUESTION_TAG_ID],
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
