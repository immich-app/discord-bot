import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { Constants } from '../../constants.js';

export const LOGS_BUTTON_ID = 'logs';
export const COMPOSE_BUTTON_ID = 'compose';
export const ENV_BUTTON_ID = 'env';

export const LOGS_MODAL_ID = 'logsModal';
export const COMPOSE_MODAL_ID = 'composeModal';
export const ENV_MODAL_ID = 'envModal';

export const getHelpDeskWelcomeMessage = (user: string, isChecked: boolean[] = []) => {
  const icon = (index: number) => (isChecked[index] ? Constants.Icons.Checked : Constants.Icons.Unchecked);

  const tasks = [
    `I have verified I'm on the latest release(note that mobile app releases may take some time).`,
    `I have read applicable [release notes](${Constants.Urls.Release}).`,
    `I have reviewed the [FAQs](${Constants.Urls.Docs.FAQ}) for known issues.`,
    `I have reviewed [Github](${Constants.Urls.Issues}) for known issues.`,
    'I have tried accessing Immich via local ip (without a custom reverse proxy).',
    'I have uploaded the relevant logs, docker compose, and .env files using the buttons below or the `/upload` command.',
    'I have tried an incognito window, cleared mobile app cache, logged out and back in, different browsers, etc. as applicable',
  ];

  return `:wave: Hey <@${user}>,

Thanks for reaching out to us. Please follow the recommended actions below; this will help us be more effective in our support effort and leave more time for building Immich <:immich:991481316950425643>.

## References
- __Container Logs:__ \`docker compose logs\` [docs](${Constants.Urls.Docs.Logs})
- __Container Status__:  \`docker compose ps\` [docs](${Constants.Urls.Docs.Containers})
- __Reverse Proxy:__ ${Constants.Urls.Docs.ReverseProxy}

## Checklist
${tasks.map((task, index) => `${index + 1}. ${icon(index)} ${task}`).join('\n')}

(an item can be marked as "complete" by reacting with the appropriate number)

If this ticket can be closed you can use the \`/close\` command, and re-open it later if needed.`;
};

export function getLogsButton() {
  return new ButtonBuilder({
    customId: LOGS_BUTTON_ID,
    label: 'Attach logs',
    style: ButtonStyle.Secondary,
  });
}

export function getComposeButton() {
  return new ButtonBuilder({
    customId: COMPOSE_BUTTON_ID,
    label: 'Attach docker-compose.yml',
    style: ButtonStyle.Secondary,
  });
}

export function getEnvButton() {
  return new ButtonBuilder({
    customId: ENV_BUTTON_ID,
    label: 'Attach .env',
    style: ButtonStyle.Secondary,
  });
}

export function getLogsUploadModel() {
  const modal = new ModalBuilder({ customId: LOGS_MODAL_ID, title: 'Logs' });

  const logsSource = new TextInputBuilder({
    customId: 'logsSource',
    label: 'Where do those logs belong to?',
    style: TextInputStyle.Short,
    placeholder: 'immich_server',
  });

  const logs = new TextInputBuilder({ customId: 'logs', label: 'Logs', style: TextInputStyle.Paragraph });

  const rowOne = new ActionRowBuilder<TextInputBuilder>({ components: [logsSource] });
  const rowTwo = new ActionRowBuilder<TextInputBuilder>({ components: [logs] });

  return modal.addComponents(rowOne, rowTwo);
}

export function getComposeUploadModal() {
  const modal = new ModalBuilder({ customId: COMPOSE_MODAL_ID, title: 'docker-compose.yml' });

  const compose = new TextInputBuilder({
    customId: 'compose',
    label: 'docker-compose.yml',
    style: TextInputStyle.Paragraph,
  });

  const row = new ActionRowBuilder<TextInputBuilder>({ components: [compose] });

  return modal.addComponents(row);
}

export function getEnvUploadModal() {
  const modal = new ModalBuilder({ customId: ENV_MODAL_ID, title: '.env' });

  const env = new TextInputBuilder({ customId: 'env', label: '.env', style: TextInputStyle.Paragraph });

  const row = new ActionRowBuilder<TextInputBuilder>({ components: [env] });

  return modal.addComponents(row);
}
