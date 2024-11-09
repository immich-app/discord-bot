import { Message, MessageCreateOptions } from 'discord.js';

export const IDiscordInterface = 'IDiscordInterface';

export enum DiscordChannel {
  HelpDesk = '1049703391762321418',
  General = '994044917355663450',
  BotSpam = '1159083520027787307',
  GithubStatus = '1240662502912692236',
  Stripe = '1263492970691297300',
  SupportCrew = '1184258493948117084',
  QQ = '1157429449671856148',
  PullRequests = '991483093179445350',
  IssuesAndDiscussions = '991483015958106202',
  Releases = '991477056791658567',
}

export enum DiscordEvents {
  Ready = 'ready',
  MessageCreate = 'messageCreate',
  InteractionCreate = 'interactionCreate',
  Error = 'error',
}

export interface IDiscordInterface {
  login(token: string): Promise<void>;
  sendMessage(channel: DiscordChannel, message: string | MessageCreateOptions): Promise<Message | undefined>;
}
