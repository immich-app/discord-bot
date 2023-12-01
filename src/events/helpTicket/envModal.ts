import { ButtonInteraction, MessageFlags, ModalSubmitInteraction } from 'discord.js';
import { ButtonComponent, Discord, ModalComponent } from 'discordx';
import { ENV_BUTTON_ID, ENV_MODAL_ID, getEnvUploadModal } from './util.js';

@Discord()
export class EnvModal {
  @ButtonComponent({ id: ENV_BUTTON_ID })
  async handleEnvButton(interaction: ButtonInteraction): Promise<void> {
    await interaction.showModal(getEnvUploadModal());
  }

  @ModalComponent({ id: ENV_MODAL_ID })
  async handleEnvModal(interaction: ModalSubmitInteraction): Promise<void> {
    const env = interaction.fields.getTextInputValue('env');

    await interaction.channel?.send({
      content: `${interaction.user} uploaded`,
      files: [{ attachment: Buffer.from(env), name: 'env.txt' }],
      flags: [MessageFlags.SuppressNotifications],
    });
    await interaction.deferUpdate();
  }
}
