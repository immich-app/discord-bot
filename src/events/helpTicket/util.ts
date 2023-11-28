import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { DOCS_DOMAIN, IMMICH_REPOSITORY, UNCHECKED_ICON } from '../../constants.js';

export const LOGS_BUTTON_ID = 'logs';
export const COMPOSE_BUTTON_ID = 'compose';
export const ENV_BUTTON_ID = 'env';

export const LOGS_MODAL_ID = 'logsModal';
export const COMPOSE_MODAL_ID = 'composeModal';
export const ENV_MODAL_ID = 'envModal';

export const helpDeskWelcomeMessage = (user: string) => `:wave: Hey <@${user}>,

Thanks for reaching out to us. Please follow the recommended actions below; this will help us be more effective in our support effort and leave more time for building Immich <:immich:991481316950425643>.

## References
- __Container Logs:__ \`docker compose logs\` [docs](${DOCS_DOMAIN}/guides/docker-help#logs)
- __Container Status__:  \`docker compose ps\` [docs](https://immich.app/docs/guides/docker-help#containers)
- __Reverse Proxy:__ ${DOCS_DOMAIN}/administration/reverse-proxy
- __Typesense:__ You can't fix this. Just wait until we get rid of it. Sorry.

## Checklist
1. ${UNCHECKED_ICON} I have verified I'm on the latest release (note that mobile app releases may take some time).
2. ${UNCHECKED_ICON} I have read applicable [release notes](${IMMICH_REPOSITORY}/releases/latest).
3. ${UNCHECKED_ICON} I have reviewed the [FAQs](${DOCS_DOMAIN}/FAQ) for known issues.
4. ${UNCHECKED_ICON} I have reviewed [Github](${IMMICH_REPOSITORY}/issues) for known issues.
5. ${UNCHECKED_ICON} I have tried accessing Immich via local ip (without a custom reverse proxy).
6. ${UNCHECKED_ICON} I have uploaded the relevant logs, docker compose, and .env files using the buttons below or the \`/upload\` command.
7. ${UNCHECKED_ICON} I have tried an incognito window, cleared mobile app cache, logged out and back in, different browsers, etc., as applicable.

(an item can be marked as "complete" by reacting with the appropriate number)

If this ticket can be closed you can use the \`/close\` command, and re-open it later if needed.`;

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
