import { ButtonInteraction, ModalSubmitInteraction } from 'discord.js';
import { ButtonComponent, Discord, ModalComponent } from 'discordx';
import { COMPOSE_BUTTON_ID, COMPOSE_MODAL_ID, getComposeUploadModal } from './util.js';

@Discord()
export class ComposeModal {
  @ButtonComponent({ id: COMPOSE_BUTTON_ID })
  async handleComposeButton(interaction: ButtonInteraction): Promise<void> {
    await interaction.showModal(getComposeUploadModal());
  }

  @ModalComponent({ id: COMPOSE_MODAL_ID })
  async handleComposeModal(interaction: ModalSubmitInteraction): Promise<void> {
    const compose = interaction.fields.getTextInputValue('compose');

    await interaction.channel?.send({ files: [{ attachment: Buffer.from(compose), name: 'docker-compose.yml' }] });
  }
}
