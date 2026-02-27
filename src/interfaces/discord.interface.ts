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
    threadId,
    message,
    crosspost,
    pin,
  }: {
    channelId: DiscordChannel | string;
    threadId?: string;
    message: string | MessageCreateOptions;
    crosspost?: boolean;
    pin?: boolean;
  }): Promise<void>;
  createEmote(name: string, emote: string | Buffer, guildId: string): Promise<GuildEmoji | undefined>;
  getEmotes(guildId: string): Promise<{ identifier: string; name: string | null; url: string; animated: boolean }[]>;
  createThread(
    channelId: string,
    dto: { name: string; message: string; appliedTags?: string[] },
  ): Promise<{ threadId?: string }>;
  updateThread(
    { channelId, threadId }: { channelId: string; threadId: string },
    { name, message, appliedTags }: { name: string; message: string; appliedTags?: string[] },
  ): Promise<void>;
  closeThread(dto: { channelId: string; threadId: string }): Promise<void>;
}
