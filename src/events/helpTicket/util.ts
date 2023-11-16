import { ButtonBuilder, ButtonStyle, TextInputBuilder, TextInputStyle } from 'discord.js';
import { DOCS_DOMAIN, UNCHECKED_ICON } from '../../constants.js';

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
To help us better assist you, please follow the recommended actions below.  
This will help us be more effective in our support effort, leaving more time for building Immich <:immich:991481316950425643>.

(an item can be marked as "complete" by reacting with the appropriate number)

1. ${UNCHECKED_ICON} Upload relevant logs, docker compose, and .env files
2. ${UNCHECKED_ICON} Review the [FAQs](${DOCS_DOMAIN}/FAQ) for known issues
3. ${UNCHECKED_ICON} Review Github for known issues (link to github)
4. ${UNCHECKED_ICON} Test directly over ip (without a custom reverse proxy)

For further information on how to do this, check out the buttons below.

If this ticket can be closed you can use the \`/close\` command. 
Note that the ticket can be re-opened later by clicking the respective buttons in the closed message.`;

export function getLogsButton() {
  return new ButtonBuilder({
    customId: LOGS_BUTTON_BASE_ID,
    label: 'Attach logs',
    style: ButtonStyle.Secondary,
  });
}

export function getComposeButton() {
  return new ButtonBuilder({
    customId: COMPOSE_BUTTON_BASE_ID,
    label: 'Attach docker-compose.yml',
    style: ButtonStyle.Secondary,
  });
}

export function getEnvButton() {
  return new ButtonBuilder({
    customId: ENV_BUTTON_BASE_ID,
    label: 'Attach .env',
    style: ButtonStyle.Secondary,
  });
}
