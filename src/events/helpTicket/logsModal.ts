import { MessageFlags, ModalSubmitInteraction } from 'discord.js';
import { Discord, ModalComponent } from 'discordx';
import { LOGS_MODAL_ID } from './util.js';

@Discord()
export class LogsModal {
  @ModalComponent({ id: LOGS_MODAL_ID })
  async handleLogsModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [logsSource, logs] = ['logsSource', 'logs'].map((id) => interaction.fields.getTextInputValue(id));

    await interaction.channel?.send({
      content: `${interaction.user} uploaded`,
      files: [{ attachment: Buffer.from(logs), name: `${logsSource}.txt` }],
      flags: [MessageFlags.SuppressNotifications],
    });
    await interaction.deferUpdate();
  }
}
