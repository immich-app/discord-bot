import { ButtonBuilder, ButtonStyle, TextInputBuilder, TextInputStyle } from 'discord.js';
import { UNCHECKED_ICON } from '../../constants';

export const LOGS_BUTTON_BASE_ID = 'logs';
export const COMPOSE_BUTTON_BASE_ID = 'compose';
export const ENV_BUTTON_BASE_ID = 'env';

export const INSTALL_ISSUE_BUTTON_ID = 'installIssue';
export const SETUP_ISSUE_BUTTON_ID = 'setupIssue';
export const BUG_BUTTON_ID = 'bug';

export const getTitleInput = () =>
  new TextInputBuilder({ customId: 'titleInput', label: 'Title of the ticket', style: TextInputStyle.Short });
export const getDescriptionInput = () =>
  new TextInputBuilder({
    customId: 'descriptionInput',
    label: 'Please provide a short description',
    style: TextInputStyle.Paragraph,
  });

export const helpDeskWelcomeMessage = (user: string) => `:wave: Hey <@${user}>

Thanks for reaching out to us.
To make it easier for us to help you, please follow the troubleshooting steps below and then provide us with as much information as possible about your issue.
This will save us time we can instead invest in making Immich even better <:immich:991481316950425643>

1. ${UNCHECKED_ICON} turn it off and on again
2. ${UNCHECKED_ICON} pray to the Immich-gods
3. ${UNCHECKED_ICON} try it without a reverse proxy
4. ${UNCHECKED_ICON} did you apply a :hammer:?

For further information on how to do this, check out the buttons below.`;

export function getLogsButton(id: string) {
  return new ButtonBuilder({
    customId: `${LOGS_BUTTON_BASE_ID}_${id}`,
    label: 'Logs',
    style: ButtonStyle.Secondary,
  });
}

export function getComposeButton(id: string) {
  return new ButtonBuilder({
    customId: `${COMPOSE_BUTTON_BASE_ID}_${id}`,
    label: 'docker compose',
    style: ButtonStyle.Secondary,
  });
}

export function getEnvButton(id: string) {
  return new ButtonBuilder({
    customId: `${ENV_BUTTON_BASE_ID}_${id}`,
    label: '.env',
    style: ButtonStyle.Secondary,
  });
}
