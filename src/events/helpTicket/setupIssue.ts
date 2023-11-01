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
  SETUP_ISSUE_BUTTON_ID,
  getComposeButton,
  getDescriptionInput,
  getEnvButton,
  getTitleInput,
  helpDeskWelcomeMessage,
} from './util.js';
import { Ids } from '../../constants.js';

@Discord()
export class SetupIssue {
  @ButtonComponent({ id: SETUP_ISSUE_BUTTON_ID })
  async handleSetupIssueClick(interaction: ButtonInteraction): Promise<void> {
    const modal = new ModalBuilder({ customId: 'setupIssueModal', title: 'Basic information about your issue' });

    const rowOne = new ActionRowBuilder<TextInputBuilder>({ components: [getTitleInput()] });
    const rowTwo = new ActionRowBuilder<TextInputBuilder>({ components: [getDescriptionInput()] });

    modal.addComponents(rowOne, rowTwo);

    await interaction.showModal(modal);
  }

  @ModalComponent()
  async handleSetupIssueModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const helpDeskChannel = (await interaction.client.channels.fetch(Ids.Channels.HelpDesk)) as ForumChannel;
    const channel = await helpDeskChannel.threads.create({
      name: `[Setup] ${interaction.fields.getTextInputValue('titleInput')}`,
      message: { content: interaction.fields.getTextInputValue('descriptionInput') },
      appliedTags: [Ids.Tags.Usage],
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