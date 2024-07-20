import { MessageFlags, ModalSubmitInteraction } from 'discord.js';
import { Discord, ModalComponent } from 'discordx';
import { ENV_MODAL_ID } from 'src/events/helpTicket/util';

@Discord()
export class EnvModal {
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
