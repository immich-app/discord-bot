import { Constants } from './constants.js';
import type { TextChannel } from 'discord.js';
import { Client } from 'discordx';

export const logError = async (message: string, error: unknown, bot: Client) => {
  console.error(message, error);
  try {
    const botSpamChannel = (await bot.channels.fetch(Constants.Channels.BotSpam)) as TextChannel;
    await botSpamChannel.send(`${message}: ${error}`);
  } catch (error) {
    console.error('Failed to send error message to bot spam channel', error);
  }
};
