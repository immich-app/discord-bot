import { MessageCreateOptions } from 'discord.js';

export const IDiscordInterface = 'IDiscordInterface';

export enum DiscordChannel {
  HelpDesk = '1049703391762321418',
  General = '994044917355663450',
  BotSpam = '1159083520027787307',
  GithubStatus = '1240662502912692236',
  Stripe = '1263492970691297300',
}

export enum DiscordEvents {
  Ready = 'ready',
  MessageCreate = 'messageCreate',
  InteractionCreate = 'interactionCreate',
  Error = 'error',
}

export interface IDiscordInterface {
  once(event: 'ready', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  login(token: string): Promise<void>;
  initApplicationCommands(): Promise<void>;
  sendMessage(channel: DiscordChannel, message: string | MessageCreateOptions): Promise<void>;
}
