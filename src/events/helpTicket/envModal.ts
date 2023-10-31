import {
  ButtonInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalSubmitInteraction,
  ThreadChannel,
} from 'discord.js';
import { ButtonComponent, Discord, ModalComponent } from 'discordx';

const ENV_MODAL_BASE_ID = 'envModal';

@Discord()
export class EnvModal {
  @ButtonComponent({ id: /^env.*/ })
  async envHandler(interaction: ButtonInteraction): Promise<void> {
    const channelId = interaction.customId.split('_')[1];
    const modal = new ModalBuilder({ customId: `${ENV_MODAL_BASE_ID}_${channelId}`, title: '.env' });

    const env = new TextInputBuilder({ customId: 'env', label: '.env', style: TextInputStyle.Paragraph });

    const row = new ActionRowBuilder<TextInputBuilder>({ components: [env] });

    modal.addComponents(row);

    await interaction.showModal(modal);
  }

  @ModalComponent({ id: /^envModal.*$/ })
  async envModal(interaction: ModalSubmitInteraction): Promise<void> {
    const channelId = interaction.customId.split('_')[1];
    const helpDeskThread = (await interaction.client.channels.fetch(channelId)) as ThreadChannel;
    const env = interaction.fields.getTextInputValue('env');

    await helpDeskThread.send(`\`\`\`\n${env}\n\`\`\``);
    await interaction.reply({ ephemeral: true, content: 'Successfully submitted your env file' });
  }
}
