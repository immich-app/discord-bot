export const IZulipInterface = 'IZulipInterface';

export type ZulipConfig = {
  bot: { username: string; apiKey: string };
  user: { username: string; apiKey: string };
  realm: string;
};
export type MessagePayload = { stream: string | number; topic?: string; content: string };

/** `streamId` is undefined for a direct message. */
export type ZulipMessage = { id: number; topic: string; streamId?: number; senderFullName?: string };

/** Zulip cannot change content and topic in one request, so a caller sends one or the other. */
export type ZulipMessageUpdate = {
  content?: string;
  topic?: string;
  propagateMode?: 'change_one' | 'change_later' | 'change_all';
  /** Left to the server's default when undefined. */
  sendNotificationToOldThread?: boolean;
  sendNotificationToNewThread?: boolean;
};

export type ZulipEmoji = { name: string; deactivated: boolean };

export type ZulipSubscription = { streamId: number };

export type ZulipUser = { userId: number; fullName: string };

export type ZulipMessagesQuery = { stream: number; topic: string; numBefore: number };

export type ZulipStreamPageQuery = { stream: number; before?: number; count: number; excludeSenderId?: number };

export type ZulipEventQueue = { queueId: string; lastEventId: number };

export type ZulipQueueRegistration = { queue: ZulipEventQueue; subscribedStreamIds: number[] };

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
  /** Set once the message has been moved to another topic or stream. */
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

export type ZulipMessageEvent = {
  id: number;
  type: 'message';
  message: ZulipReceivedMessage;
  update?: undefined;
  deletion?: undefined;
};

export type ZulipUpdateEvent = {
  id: number;
  type: 'update_message';
  update: ZulipMessageUpdated;
  message?: undefined;
  deletion?: undefined;
};

export type ZulipDeleteEvent = {
  id: number;
  type: 'delete_message';
  deletion: ZulipMessagesDeleted;
  message?: undefined;
  update?: undefined;
};

/** Zulip also sends `heartbeat` events; the loop must acknowledge every event's ID, whatever its type. */
export type ZulipEvent =
  | ZulipMessageEvent
  | ZulipUpdateEvent
  | ZulipDeleteEvent
  | { id: number; type: string; message?: undefined; update?: undefined; deletion?: undefined };

/** A download the repository will not make, or whose answer it will not use. */
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
  getMessage(id: number): Promise<ZulipMessage>;
  updateMessage(id: number, update: ZulipMessageUpdate): Promise<void>;
  createEmote(name: string, emoteUrl: string): Promise<void>;
  listEmoji(): Promise<ZulipEmoji[]>;
  getSubscriptions(): Promise<ZulipSubscription[]>;
  getOwnUser(): Promise<ZulipUser>;
  getMessages(query: ZulipMessagesQuery): Promise<ZulipReceivedMessage[]>;
  registerQueue(): Promise<ZulipQueueRegistration>;
  getEvents(queue: ZulipEventQueue, signal: AbortSignal): Promise<ZulipEvent[]>;
  deleteQueue(queueId: string): Promise<void>;
  deleteMessage(id: number): Promise<void>;
  uploadFile(file: File): Promise<{ url: string; filename: string }>;
  /**
   * Resolves to `undefined` when the file is larger than `maxBytes`; rejects with `ZulipUploadRefused` for anything
   * but a plain `/user_uploads/` path, and for an answer that is not the file.
   */
  downloadUpload(path: string, maxBytes: number): Promise<File | undefined>;
  /** Up to `count` messages of the stream before `before`, or the newest ones, oldest first, as raw markdown. */
  getStreamMessagesBefore(query: ZulipStreamPageQuery): Promise<ZulipReceivedMessage[]>;
  /** Emoji name to its Unicode string, from the realm's static emoji table. */
  getEmojiCodes(): Promise<Record<string, string>>;
}
