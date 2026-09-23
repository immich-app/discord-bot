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
  /** ID to display name. */
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
  categoryId: string | null;
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

export type DiscordTeamMember = { displayName: string; avatarUrl: string; roleIds: string[] };

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
  /** `undefined` when the channel does not exist or is not in a guild. */
  getMirrorChannel(channelId: string): Promise<DiscordMirrorChannel | undefined>;
  /** Finds or creates the bot's webhook in the channel; a no-op once found. */
  ensureMirrorWebhook(channelId: string): Promise<void>;
  sendMirrorMessage(message: DiscordMirrorSend): Promise<DiscordMirrorSent>;
  /** Always sends allowedMentions { parse: [], users: [] }. */
  editMirrorMessage(target: DiscordMirrorTarget, edit: { content: string; suppressEmbeds: boolean }): Promise<void>;
  /** Through the webhook; through the bot (Manage Messages) when the target's webhook is gone or replaced. */
  deleteMirrorMessage(target: DiscordMirrorTarget): Promise<void>;
  startMirrorThread(channelId: string, messageId: string, name: string): Promise<string>;
  renameMirrorThread(threadId: string, name: string): Promise<void>;
  unarchiveMirrorThread(threadId: string): Promise<void>;
  /** `undefined` when the guild is not cached or the user is not a member of it. */
  getTeamMember(guildId: string, userId: string): Promise<DiscordTeamMember | undefined>;
  /** Mirror candidates only, oldest first; `channelId` may be a thread. */
  fetchMirrorMessagesAfter(channelId: string, afterId: string, limit: number): Promise<DiscordSourceMessage[]>;
}
