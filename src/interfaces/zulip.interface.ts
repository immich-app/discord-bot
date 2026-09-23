export const IZulipInterface = 'IZulipInterface';

export type ZulipConfig = {
  bot: { username: string; apiKey: string };
  user: { username: string; apiKey: string };
  realm: string;
};
export type MessagePayload = { stream: string | number; topic?: string; content: string };

/** `code` is the Unicode code points in hex joined by `-` (`1f1e9-1f1ea`) for a Unicode emoji, the ID of a realm emoji. */
export type ZulipReactionEmoji = {
  name: string;
  code: string;
  type: 'unicode_emoji' | 'realm_emoji' | 'zulip_extra_emoji';
};

export type ZulipReaction = ZulipReactionEmoji & { userId: number };

export type ZulipMessage = {
  id: number;
  topic: string;
  streamId?: number;
  senderFullName?: string;
  reactions?: ZulipReaction[];
};

/** Zulip cannot change content and topic in one request, so a caller sends one or the other. */
export type ZulipMessageUpdate = {
  content?: string;
  topic?: string;
  propagateMode?: 'change_one' | 'change_later' | 'change_all';
  /** Left to the server's default when undefined. */
  sendNotificationToOldThread?: boolean;
  sendNotificationToNewThread?: boolean;
};

export type ZulipEmoji = { id: string; name: string; deactivated: boolean };

/** `unicode` is a built-in emoji name to its Unicode string, `names` a code point sequence (`1f44d`) to its name. */
export type ZulipEmojiCodes = { unicode: Record<string, string>; names: Record<string, string> };

export type ZulipSubscription = { streamId: number };

export type ZulipUser = { userId: number; fullName: string };

/** Zulip's roles: 100 owner, 200 administrator, 300 moderator, 400 member, 600 guest. */
export type ZulipUserDetails = ZulipUser & { role: number };

export type ZulipStream = { streamId: number; name: string; inviteOnly: boolean };

export type ZulipMessagesQuery = { stream: number; topic: string; numBefore: number };

export type ZulipStreamPageQuery = { stream: number; before?: number; count: number; excludeSenderId?: number };

export type ZulipEventQueue = { queueId: string; lastEventId: number };

/** `emptyTopicName` is how events and `GET /messages` name the empty topic, since the bot does not ask for `''`. */
export type ZulipQueueRegistration = { queue: ZulipEventQueue; subscribedStreamIds: number[]; emptyTopicName?: string };

export type ZulipReceivedMessage = {
  id: number;
  senderId: number;
  senderEmail: string;
  senderFullName: string;
  type: 'stream' | 'private';
  streamId?: number;
  topic: string;
  content: string;
  /** Seconds since the epoch. */
  timestamp: number;
  movedAt?: number;
};

export type ZulipMessageUpdated = {
  /** `null` for an update the server made itself, such as a link preview. */
  userId: number | null;
  renderingOnly: boolean;
  messageId: number;
  messageIds: number[];
  streamId?: number;
  newStreamId?: number;
  origTopic?: string;
  topic?: string;
  propagateMode?: 'change_one' | 'change_later' | 'change_all';
  content?: string;
};

export type ZulipMessagesDeleted = { messageIds: number[]; streamId?: number; topic?: string };

/** Carries no stream: only the message ID says where it is. */
export type ZulipReactionChanged = {
  op: 'add' | 'remove';
  userId: number;
  messageId: number;
  emoji: ZulipReactionEmoji;
};

type NoPayload = { message?: undefined; update?: undefined; deletion?: undefined; reaction?: undefined };

export type ZulipMessageEvent = Omit<NoPayload, 'message'> & {
  id: number;
  type: 'message';
  message: ZulipReceivedMessage;
};

export type ZulipUpdateEvent = Omit<NoPayload, 'update'> & {
  id: number;
  type: 'update_message';
  update: ZulipMessageUpdated;
};

export type ZulipDeleteEvent = Omit<NoPayload, 'deletion'> & {
  id: number;
  type: 'delete_message';
  deletion: ZulipMessagesDeleted;
};

export type ZulipReactionEvent = Omit<NoPayload, 'reaction'> & {
  id: number;
  type: 'reaction';
  reaction: ZulipReactionChanged;
};

/** Zulip also sends `heartbeat` events; the loop must acknowledge every event's ID, whatever its type. */
export type ZulipEvent =
  | ZulipMessageEvent
  | ZulipUpdateEvent
  | ZulipDeleteEvent
  | ZulipReactionEvent
  | (NoPayload & { id: number; type: string });

export class ZulipUploadRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZulipUploadRefused';
  }
}

export interface IZulipInterface {
  init(config: ZulipConfig): Promise<void>;
  isInitialised(): boolean;
  /** Resolves to the new message's ID; rejects on any Zulip error. */
  sendMessage(payload: MessagePayload): Promise<{ id: number }>;
  sendDirectMessage(userIds: number[], content: string): Promise<{ id: number }>;
  getMessage(id: number): Promise<ZulipMessage>;
  updateMessage(id: number, update: ZulipMessageUpdate): Promise<void>;
  createEmote(name: string, emoteUrl: string): Promise<void>;
  listEmoji(): Promise<ZulipEmoji[]>;
  getSubscriptions(): Promise<ZulipSubscription[]>;
  getOwnUser(): Promise<ZulipUser>;
  getUser(userId: number): Promise<ZulipUserDetails>;
  /** Rejects when the stream does not exist or the bot cannot see it. */
  getStream(streamId: number): Promise<ZulipStream>;
  getMessages(query: ZulipMessagesQuery): Promise<ZulipReceivedMessage[]>;
  registerQueue(): Promise<ZulipQueueRegistration>;
  getEvents(queue: ZulipEventQueue, signal: AbortSignal): Promise<ZulipEvent[]>;
  deleteQueue(queueId: string): Promise<void>;
  deleteMessage(id: number): Promise<void>;
  uploadFile(file: File, signal?: AbortSignal): Promise<{ url: string; filename: string }>;
  /**
   * Resolves to `undefined` when the file is larger than `maxBytes`; rejects with `ZulipUploadRefused` for anything
   * but a plain `/user_uploads/` path, and for an answer that is not the file.
   */
  downloadUpload(path: string, maxBytes: number, signal?: AbortSignal): Promise<File | undefined>;
  /** Oldest first, as raw markdown. */
  getStreamMessagesBefore(query: ZulipStreamPageQuery): Promise<ZulipReceivedMessage[]>;
  /** As raw markdown; a message that is gone, or that the bot cannot read, is left out. */
  getMessagesByIds(ids: number[]): Promise<ZulipReceivedMessage[]>;
  /** From the realm's static emoji table. */
  getEmojiCodes(): Promise<ZulipEmojiCodes>;
  /** Rejects with `REACTION_ALREADY_EXISTS` when the bot has that reaction already. */
  addReaction(messageId: number, emoji: ZulipReactionEmoji): Promise<void>;
  /** Rejects with `REACTION_DOES_NOT_EXIST` when the bot has no such reaction. */
  removeReaction(messageId: number, emoji: ZulipReactionEmoji): Promise<void>;
}
