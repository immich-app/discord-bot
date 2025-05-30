import { GuildEmoji, MessageCreateOptions } from 'discord.js';

export const IDiscordInterface = 'IDiscordInterface';

export enum DiscordChannel {
  Announcements = '991930592843272342',
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
  sendMessage({
    channelId,
    message,
    crosspost,
  }: {
    channelId: DiscordChannel | string;
    message: string | MessageCreateOptions;
    crosspost?: boolean;
  }): Promise<void>;
  createEmote(name: string, emote: string | Buffer, guildId: string): Promise<GuildEmoji | undefined>;
  getEmotes(guildId: string): Promise<{ identifier: string; name: string | null; url: string }[]>;
}
