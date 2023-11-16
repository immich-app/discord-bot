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
  INSTALL_ISSUE_BUTTON_ID,
  getComposeButton,
  getDescriptionInput,
  getEnvButton,
  getTitleInput,
  helpDeskWelcomeMessage,
} from './util.js';
import { Ids } from '../../constants.js';

const MODAL_ID = 'installIssueModal';

@Discord()
export class InstallIssue {
  @ButtonComponent({ id: INSTALL_ISSUE_BUTTON_ID })
  async handleInstallIssueClick(interaction: ButtonInteraction): Promise<void> {
    const modal = new ModalBuilder({ customId: MODAL_ID, title: 'Basic information about your issue' });

    const rowOne = new ActionRowBuilder<TextInputBuilder>({ components: [getTitleInput()] });
    const rowTwo = new ActionRowBuilder<TextInputBuilder>({ components: [getDescriptionInput()] });

    modal.addComponents(rowOne, rowTwo);

    await interaction.showModal(modal);
  }

  @ModalComponent({ id: MODAL_ID })
  async handleInstallIssueModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const helpDeskChannel = (await interaction.client.channels.fetch(Ids.Channels.HelpDesk)) as ForumChannel;
    const channel = await helpDeskChannel.threads.create({
      name: `[Installation] ${interaction.fields.getTextInputValue('titleInput')}`,
      message: { content: interaction.fields.getTextInputValue('descriptionInput') },
      appliedTags: [Ids.Tags.Setup],
    });

    const buttonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      getComposeButton(),
      getEnvButton(),
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
        content: `A ticket has been opened for you: <#${channel.id}>. Please provide more information there.`,
        components: [buttonRow],
      }),
    ]);
  }
}
