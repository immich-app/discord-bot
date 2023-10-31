import {
  ButtonInteraction,
  ModalBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  ModalSubmitInteraction,
  ForumChannel,
  MessageActionRowComponentBuilder,
} from 'discord.js';
import { ButtonComponent, Discord, ModalComponent } from 'discordx';
import {
  HELP_DESK_CHANNEL_ID,
  SETUP_TAG_ID,
  getComposeButton,
  getDescriptionInput,
  getEnvButton,
  getTitleInput,
  helpDeskWelcomeMessage,
} from './util.js';

@Discord()
export class InstallIssue {
  @ButtonComponent({ id: 'installIssue' })
  async installIssueHandler(interaction: ButtonInteraction): Promise<void> {
    const modal = new ModalBuilder({ customId: 'installIssueModal', title: 'Basic information about your issue' });

    const rowOne = new ActionRowBuilder<TextInputBuilder>({ components: [getTitleInput()] });
    const rowTwo = new ActionRowBuilder<TextInputBuilder>({ components: [getDescriptionInput()] });

    modal.addComponents(rowOne, rowTwo);

    await interaction.showModal(modal);
  }

  @ModalComponent()
  async installIssueModal(interaction: ModalSubmitInteraction): Promise<void> {
    const helpDeskChannel = (await interaction.client.channels.fetch(HELP_DESK_CHANNEL_ID)) as ForumChannel;
    const channel = await helpDeskChannel.threads.create({
      name: `[Installation] ${interaction.fields.getTextInputValue('titleInput')}`,
      message: { content: interaction.fields.getTextInputValue('descriptionInput') },
      appliedTags: [SETUP_TAG_ID],
    });
    const buttonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      getComposeButton(channel.id),
      getEnvButton(channel.id),
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
