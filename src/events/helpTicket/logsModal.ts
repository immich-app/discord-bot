import { ButtonInteraction, MessageFlags, ModalSubmitInteraction } from 'discord.js';
import { ButtonComponent, Discord, ModalComponent } from 'discordx';
import { LOGS_BUTTON_ID, LOGS_MODAL_ID, getLogsUploadModel } from './util.js';

@Discord()
export class LogsModal {
  @ButtonComponent({ id: LOGS_BUTTON_ID })
  async logHandler(interaction: ButtonInteraction): Promise<void> {
    await interaction.showModal(getLogsUploadModel());
  }

  @ModalComponent({ id: LOGS_MODAL_ID })
  async logsModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [logsSource, logs] = ['logsSource', 'logs'].map((id) => interaction.fields.getTextInputValue(id));

    await interaction.channel?.send({
      content: `${interaction.user} uploaded`,
      files: [{ attachment: Buffer.from(logs), name: `${logsSource}.txt` }],
      flags: [MessageFlags.SuppressNotifications],
    });
    await interaction.deferUpdate();
  }
}
