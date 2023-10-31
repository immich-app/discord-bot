import { ButtonBuilder, ButtonStyle, TextInputBuilder, TextInputStyle } from 'discord.js';

export const LOGS_BUTTON_BASE_ID = 'logs';
export const COMPOSE_BUTTON_BASE_ID = 'compose';
export const ENV_BUTTON_BASE_ID = 'env';

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

1. :blue_square: turn it off and on again
2. :blue_square: pray to the Immich-gods
3. :blue_square: try it without a reverse proxy
4. :blue_square: did you apply a :hammer:?

For further information on how to do this, check out the buttons below.`;

export const HELP_DESK_CHANNEL_ID = '1049703391762321418';

export const QUESTION_TAG_ID = '1049704189686730823';
export const SETUP_TAG_ID = '1049704231692677120';
export const USAGE_TAG_ID = '1049704247517794315';
export const READY_TAG_ID = '1166852154292699207';

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
