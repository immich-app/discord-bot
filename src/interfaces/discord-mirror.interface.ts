import { IDiscordInterface } from 'src/interfaces/discord.interface';

export const IDiscordMirrorInterface = 'IDiscordMirrorInterface';

export type DiscordSourceMessage = {
  id: string;
  guildId: string;
  /** The pair's channel: the parent of the thread when the message is in one. */
  channelId: string;
  threadId: string | null;
  threadName: string | null;
  /** The names of the tags applied to the forum post the message is in. */
  threadTags?: string[];
  createdTimestamp: number;
  jumpUrl: string;
  /** `bot` is set for a bot or a webhook. */
  author: { id: string; username: string; displayName: string; bot?: boolean };
  silent: boolean;
  content: string;
  mentions: { users: Record<string, string>; roles: Record<string, string>; channels: Record<string, string> };
  attachments: { id: string; name: string; url: string; size: number; contentType: string | null; spoiler: boolean }[];
  stickers: string[];
  poll: string | null;
  forwarded: string[];
  /** The embeds a bot or webhook wrote itself, never link previews. */
  embeds?: DiscordMirrorEmbed[];
  /** `authorDisplayName` and `content` are `null` when the replied-to message is not cached. */
  replyTo: { messageId: string; authorDisplayName: string | null; content: string | null } | null;
};

export type DiscordMirrorEmbed = {
  title: string | null;
  url: string | null;
  description: string | null;
  fields: { name: string; value: string }[];
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

/** `id` is set for a custom emote, whose name `name` is; otherwise `name` is the Unicode emoji. */
export type DiscordReactionEmoji = { id: string | null; name: string | null; animated: boolean };

/** `count` includes the bot's own reaction, which `me` says it has. */
export type DiscordMirrorReaction = { emoji: DiscordReactionEmoji; count: number; me: boolean };

export type DiscordTeamMember = { displayName: string; avatarUrl: string; roleIds: string[] };

/** `createdTimestamp` is when the thread was made, which for a thread started from a message is not its ID's time. */
export type DiscordMirrorThread = { id: string; createdTimestamp: number };

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
  | 'unknown-emoji'
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
  /** Whether the mirror posts through this webhook, or did through one it replaced. */
  isOwnMirrorWebhook(webhookId: string): boolean;
  getMirrorChannel(channelId: string): Promise<DiscordMirrorChannel | undefined>;
  ensureMirrorWebhook(channelId: string): Promise<void>;
  sendMirrorMessage(message: DiscordMirrorSend): Promise<DiscordMirrorSent>;
  /** Always sends allowedMentions { parse: [], users: [] }; `files` are added to the attachments the message has. */
  editMirrorMessage(
    target: DiscordMirrorTarget,
    edit: { content: string; suppressEmbeds: boolean; files?: File[] },
  ): Promise<void>;
  countMirrorAttachments(target: DiscordMirrorTarget): Promise<number>;
  /** Through the webhook; through the bot (Manage Messages) when the target's webhook is gone or replaced. */
  deleteMirrorMessage(target: DiscordMirrorTarget): Promise<void>;
  startMirrorThread(channelId: string, messageId: string, name: string): Promise<string>;
  renameMirrorThread(threadId: string, name: string): Promise<void>;
  unarchiveMirrorThread(threadId: string): Promise<void>;
  archiveMirrorThread(threadId: string): Promise<void>;
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
  getMirrorReactions(target: DiscordMirrorTarget): Promise<DiscordMirrorReaction[]>;
  /** As the bot; adding a reaction it has, or removing one it has not, changes nothing. */
  addMirrorReaction(target: DiscordMirrorTarget, emoji: DiscordReactionEmoji): Promise<void>;
  removeMirrorReaction(target: DiscordMirrorTarget, emoji: DiscordReactionEmoji): Promise<void>;
  /** The public threads of a channel or posts of a forum that are active, and the most recently archived ones. */
  listMirrorThreads(channelId: string): Promise<DiscordMirrorThread[]>;
  /** Any message, whoever sent it; `undefined` when there is none. `channelId` may be a thread. */
  fetchMirrorMessage(channelId: string, messageId: string): Promise<DiscordSourceMessage | undefined>;
  /** `channelId` may be a thread. */
  fetchMirrorMessagesBefore(channelId: string, beforeId: string | undefined, limit: number): Promise<DiscordMirrorPage>;
}
