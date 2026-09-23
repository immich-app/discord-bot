import { Logger } from '@nestjs/common';
import { GuardFunction } from 'discordx';

export type DiscordErrorHandler = (error: unknown) => Promise<void>;

const logger = new Logger('DiscordErrorGuard');

// discordx drops whatever an @On handler throws, so this global guard is the only place those errors surface.
export const reportErrors =
  (onError: DiscordErrorHandler): GuardFunction =>
  async (_params, _client, next) => {
    try {
      return await next();
    } catch (error) {
      try {
        await onError(error);
      } catch (reportError) {
        logger.error(`Could not report a Discord handler error: ${error}`, reportError);
      }
    }
  };
