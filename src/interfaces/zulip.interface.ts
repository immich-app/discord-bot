export const IZulipInterface = 'IZulipInterface';

export type ZulipConfig = {
  bot: { username: string; apiKey: string };
  user: { username: string; apiKey: string };
  realm: string;
};
export type MessagePayload = { stream: string | number; topic?: string; content: string };

export type ZulipMessage = { id: number; topic: string };

/** Zulip cannot change content and topic in one request, so a caller sends one or the other. */
export type ZulipMessageUpdate = {
  content?: string;
  topic?: string;
  propagateMode?: 'change_one' | 'change_later' | 'change_all';
};

export type ZulipEmoji = { name: string; deactivated: boolean };

export type ZulipSubscription = { streamId: number };

export type ZulipUser = { userId: number };

export type ZulipEventQueue = { queueId: string; lastEventId: number };

export type ZulipQueueStream = { streamId: number; isPrivate: boolean };

export type ZulipQueueRegistration = { queue: ZulipEventQueue; streams: ZulipQueueStream[] };

export type ZulipReceivedMessage = {
  id: number;
  senderId: number;
  senderEmail: string;
  type: 'stream' | 'private';
  streamId?: number;
  topic: string;
  content: string;
};

export type ZulipMessageEvent = { id: number; type: 'message'; message: ZulipReceivedMessage };

/** Zulip also sends `heartbeat` events; the loop must acknowledge every event's ID, whatever its type. */
export type ZulipEvent = ZulipMessageEvent | { id: number; type: string; message?: undefined };

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
  registerQueue(): Promise<ZulipQueueRegistration>;
  getEvents(queue: ZulipEventQueue, signal: AbortSignal): Promise<ZulipEvent[]>;
  deleteQueue(queueId: string): Promise<void>;
}
