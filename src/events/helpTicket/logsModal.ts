import {
  ButtonInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalSubmitInteraction,
} from 'discord.js';
import { ButtonComponent, Discord, ModalComponent } from 'discordx';

const LOGS_MODAL_BASE_ID = 'logsModal';

@Discord()
export class LogsModal {
  @ButtonComponent({ id: /^logs.*$/ })
  async logHandler(interaction: ButtonInteraction): Promise<void> {
    const channelId = interaction.customId.split('_')[1];
    const modal = new ModalBuilder({ customId: `${LOGS_MODAL_BASE_ID}_${channelId}`, title: 'Logs' });

    const logsSource = new TextInputBuilder({
      customId: 'logsSource',
      label: 'Where do those logs belong to?',
      style: TextInputStyle.Short,
      placeholder: 'immich_server',
    });

    const logs = new TextInputBuilder({ customId: 'logs', label: 'Logs', style: TextInputStyle.Paragraph });

    const rowOne = new ActionRowBuilder<TextInputBuilder>({ components: [logsSource] });
    const rowTwo = new ActionRowBuilder<TextInputBuilder>({ components: [logs] });

    modal.addComponents(rowOne, rowTwo);

    await interaction.showModal(modal);
  }

  @ModalComponent({ id: /^logsModal.*$/ })
  async logsModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [logsSource, logs] = ['logsSource', 'logs'].map((id) => interaction.fields.getTextInputValue(id));

    await interaction.channel?.send({ files: [{ attachment: Buffer.from(logs), name: `${logsSource}.txt` }] });
    // await interaction.reply({ ephemeral: true, content: 'Successfully submitted logs' });
  }
}
