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

const COMPOSE_MODAL_BASE_ID = 'composeModal';

@Discord()
export class ComposeModal {
  @ButtonComponent({ id: /^compose.*/ })
  async composeHandler(interaction: ButtonInteraction): Promise<void> {
    const channelId = interaction.customId.split('_')[1];
    const modal = new ModalBuilder({ customId: `${COMPOSE_MODAL_BASE_ID}_${channelId}`, title: 'docker-compose.yml' });

    const compose = new TextInputBuilder({
      customId: 'compose',
      label: 'docker-compose.yml',
      style: TextInputStyle.Paragraph,
    });

    const row = new ActionRowBuilder<TextInputBuilder>({ components: [compose] });

    modal.addComponents(row);

    await interaction.showModal(modal);
  }

  @ModalComponent({ id: /^composeModal.*$/ })
  async composeModal(interaction: ModalSubmitInteraction): Promise<void> {
    const channelId = interaction.customId.split('_')[1];
    const helpDeskThread = (await interaction.client.channels.fetch(channelId)) as ThreadChannel;
    const compose = interaction.fields.getTextInputValue('compose');

    await helpDeskThread.send({ files: [{ attachment: Buffer.from(compose), name: 'docker-compose.yml' }] });
    await interaction.reply({ ephemeral: true, content: 'Successfully submitted your docker compose file' });
  }
}
