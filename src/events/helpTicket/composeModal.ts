import { MessageFlags, ModalSubmitInteraction } from 'discord.js';
import { Discord, ModalComponent } from 'discordx';
import { COMPOSE_MODAL_ID } from './util.js';

@Discord()
export class ComposeModal {
  @ModalComponent({ id: COMPOSE_MODAL_ID })
  async handleComposeModal(interaction: ModalSubmitInteraction): Promise<void> {
    const compose = interaction.fields.getTextInputValue('compose');

    await interaction.channel?.send({
      content: `${interaction.user} uploaded`,
      files: [{ attachment: Buffer.from(compose), name: 'docker-compose.yml' }],
      flags: [MessageFlags.SuppressNotifications],
    });
    await interaction.deferUpdate();
  }
}
