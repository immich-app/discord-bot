import { IDiscordInterface } from 'src/interfaces/discord.interface';

export const IDiscordMirrorInterface = 'IDiscordMirrorInterface';

export type DiscordSourceMessage = {
  id: string;
  guildId: string;
  /** The pair's channel: the parent of the thread when the message is in one. */
  channelId: string;
  threadId: string | null;
  threadName: string | null;
  createdTimestamp: number;
  jumpUrl: string;
  author: { id: string; username: string; displayName: string };
  silent: boolean;
  content: string;
  mentions: { users: Record<string, string>; roles: Record<string, string>; channels: Record<string, string> };
  attachments: { id: string; name: string; url: string; size: number; contentType: string | null; spoiler: boolean }[];
  stickers: string[];
  poll: string | null;
  forwarded: string[];
  /** `authorDisplayName` and `content` are `null` when the replied-to message is not cached. */
  replyTo: { messageId: string; authorDisplayName: string | null; content: string | null } | null;
};

export type DiscordMirrorChannel = {
  id: string;
  guildId: string;
  name: string;
  kind: 'text' | 'forum' | 'other';
  everyoneCanView: boolean;
  missingPermissions: string[];
};

export type DiscordMirrorSend = {
  channelId: string;
  threadId?: string;
  threadName?: string;
  username: string;
  avatarUrl?: string;
  content: string;
  files?: File[];
  pingUserIds: string[];
  suppressEmbeds: boolean;
};

/** `channelId` is where the message lives: the thread, or the new forum post for a `threadName` send. */
export type DiscordMirrorSent = { messageId: string; channelId: string; webhookId: string };

export type DiscordMirrorTarget = {
  channelId: string;
  threadId: string | null;
  messageId: string;
  webhookId: string | null;
};

export type DiscordMirrorNotice = { messageId: string; pinned: boolean };

export type DiscordTeamMember = { displayName: string; avatarUrl: string; roleIds: string[] };

/** `messages` holds the mirror candidates of the page, oldest first; `oldestId` is the oldest message of any kind. */
export type DiscordMirrorPage = { messages: DiscordSourceMessage[]; oldestId: string | null; full: boolean };

export type DiscordMirrorErrorKind =
  | 'unknown-webhook'
  | 'unknown-message'
  | 'unknown-channel'
  | 'archived'
  | 'locked'
  | 'forbidden'
  | 'max-webhooks'
  | 'too-large'
  | 'forum'
  | 'replaced-webhook'
  | 'unavailable'
  | 'unreachable'
  | 'other';

export class DiscordMirrorError extends Error {
  constructor(
    readonly kind: DiscordMirrorErrorKind,
    readonly code?: number,
    message?: string,
  ) {
    super(message ?? kind);
    this.name = 'DiscordMirrorError';
  }
}

export interface IDiscordMirrorInterface extends Pick<IDiscordInterface, 'getEmotes'> {
  isReady(): boolean;
  getMirrorChannel(channelId: string): Promise<DiscordMirrorChannel | undefined>;
  ensureMirrorWebhook(channelId: string): Promise<void>;
  sendMirrorMessage(message: DiscordMirrorSend): Promise<DiscordMirrorSent>;
  /** Always sends allowedMentions { parse: [], users: [] }. */
  editMirrorMessage(target: DiscordMirrorTarget, edit: { content: string; suppressEmbeds: boolean }): Promise<void>;
  /** Through the webhook; through the bot (Manage Messages) when the target's webhook is gone or replaced. */
  deleteMirrorMessage(target: DiscordMirrorTarget): Promise<void>;
  startMirrorThread(channelId: string, messageId: string, name: string): Promise<string>;
  renameMirrorThread(threadId: string, name: string): Promise<void>;
  unarchiveMirrorThread(threadId: string): Promise<void>;
  getTeamMember(guildId: string, userId: string): Promise<DiscordTeamMember | undefined>;
  /**
   * As the bot and pinging nobody: a message in a text channel, a post named `title` in a forum, whose ID is then
   * the `messageId`. A pin that fails leaves `pinned` false.
   */
  sendMirrorNotice(
    channelId: string,
    notice: { title: string; content: string },
    pin: boolean,
  ): Promise<DiscordMirrorNotice>;
  unpinMirrorNotice(channelId: string, messageId: string): Promise<void>;
  /** `channelId` may be a thread. */
  fetchMirrorMessagesBefore(channelId: string, beforeId: string | undefined, limit: number): Promise<DiscordMirrorPage>;
}
