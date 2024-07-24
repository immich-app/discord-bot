import { MessageFlags, ModalSubmitInteraction } from 'discord.js';
import { Discord, ModalComponent } from 'discordx';
import { COMPOSE_MODAL_ID, ENV_MODAL_ID, LOGS_MODAL_ID } from 'src/discord/util';

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
