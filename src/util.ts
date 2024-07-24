import { Logger } from '@nestjs/common';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';

type Repos = { discord: IDiscordInterface; logger: Logger };
export const logError = async (message: string, error: unknown, { discord, logger }: Repos) => {
  logger.error(message, error);
  try {
    await discord.sendMessage(DiscordChannel.BotSpam, `${message}: ${error}`);
  } catch (error) {
    console.error('Failed to send error message to bot spam channel', error);
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
