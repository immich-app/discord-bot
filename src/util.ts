import { Logger } from '@nestjs/common';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';

type Repos = { discord: IDiscordInterface; logger: Logger };
export const logError = async (message: string, error: unknown, { discord, logger }: Repos) => {
  logger.error(message, error);
  try {
    await discord.sendMessage({ channel: DiscordChannel.BotSpam, message: `${message}: ${error}` });
  } catch (error) {
    logger.error('Failed to send error message to bot spam channel', error);
  }
};

type WithErrorOptions<T> = Repos & {
  message: string;
  method: () => Promise<T>;
  fallbackValue: T;
  discord: IDiscordInterface;
  logger: Logger;
};
export const withErrorLogging = async <T = unknown>(options: WithErrorOptions<T>) => {
  const { message, method, fallbackValue, discord, logger } = options;
  try {
    return await method();
  } catch (error) {
    await logError(message, error, { discord, logger });
    return fallbackValue;
  }
};

export const getTotal = ({ server, client }: { server: number; client: number }) => {
  return '$' + (server * 100 + client * 25).toLocaleString();
};

export const makeLicenseFields = ({ server, client }: { server: number; client: number }) => {
  return [
    {
      name: 'Server licenses',
      value: `$${(server * 100).toLocaleString()} - ${server.toLocaleString()} licenses`,
      inline: true,
    },
    {
      name: 'Client licenses',
      value: `$${(client * 25).toLocaleString()} - ${client.toLocaleString()} licenses`,
      inline: true,
    },
  ];
};

export const shorten = (text: string, maxLength: number = 100) => {
  return text.length > maxLength ? `${text.substring(0, maxLength - 3)}...` : text;
};
