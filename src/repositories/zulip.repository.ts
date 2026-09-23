import type { components, paths } from 'src/generated/zulip';
import {
  IZulipInterface,
  MessagePayload,
  type ZulipConfig,
  ZulipEmoji,
  ZulipEvent,
  ZulipEventQueue,
  ZulipMessage,
  ZulipMessagesQuery,
  ZulipMessageUpdate,
  ZulipQueueRegistration,
  ZulipReceivedMessage,
  ZulipSubscription,
  ZulipUser,
} from 'src/interfaces/zulip.interface';
import { createZulipClient, multipart, type ZulipClient, type ZulipClientOptions } from 'src/repositories/zulip.client';

const IMAGE_TIMEOUT_MS = 30_000;
const EMOJI_CODES_TIMEOUT_MS = 30_000;
/** Zulip's default long-poll timeout: a quiet poll gets its heartbeat about this late, so the client adds a margin. */
const DEFAULT_LONGPOLL_TIMEOUT_SECONDS = 90;
const LONGPOLL_MARGIN_MS = 30_000;
export const longpollTimeoutMs = (seconds: number) => seconds * 1000 + LONGPOLL_MARGIN_MS;
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
};

/** Typed as empty by the generated types, but the server requires `notification_settings_null`, false by default. */
const CLIENT_CAPABILITIES: unknown = { notification_settings_null: false, bulk_message_deletion: true };

type Clients = { bot: ZulipClient; user: ZulipClient; events: ZulipClient };

const toEmoji = (codepoints: unknown) => {
  if (typeof codepoints !== 'string' || !/^[\da-f]{1,6}(-[\da-f]{1,6})*$/i.test(codepoints)) {
    return undefined;
  }
  const points = codepoints.split('-').map((hex) => Number.parseInt(hex, 16));
  return points.every((point) => point <= 0x10_ffff) ? String.fromCodePoint(...points) : undefined;
};

const notInitialised = () => new Error('Zulip client not initialised: call init() first');

export class ZulipRepository implements IZulipInterface {
  private clients?: Clients;
  private botIdentity?: Omit<ZulipClientOptions, 'timeoutMs'>;

  async init({ realm, bot, user }: ZulipConfig) {
    this.botIdentity = { realm, ...bot };
    this.clients = {
      bot: createZulipClient(this.botIdentity),
      user: createZulipClient({ realm, ...user }),
      events: createZulipClient({
        ...this.botIdentity,
        timeoutMs: longpollTimeoutMs(DEFAULT_LONGPOLL_TIMEOUT_SECONDS),
      }),
    };
  }

  isInitialised() {
    return this.clients !== undefined;
  }

  /** The bot account posts messages. */
  private get bot() {
    return this.client('bot');
  }

  /** The human account uploads emoji: Zulip answers `This endpoint does not accept bot requests` otherwise. */
  private get user() {
    return this.client('user');
  }

  private get events() {
    return this.client('events');
  }

  private client(identity: keyof Clients) {
    if (!this.clients) {
      throw notInitialised();
    }
    return this.clients[identity];
  }

  private get site() {
    if (!this.botIdentity) {
      throw notInitialised();
    }
    const { realm, username, apiKey } = this.botIdentity;
    return {
      origin: new URL(realm).origin,
      authorization: `Basic ${Buffer.from(`${username}:${apiKey}`).toString('base64')}`,
    };
  }

  async sendMessage({ stream, topic, content }: MessagePayload) {
    const { data } = await this.bot.POST('/messages', { body: { type: 'channel', to: stream, topic, content } });
    return { id: data!.id };
  }

  async getMessage(id: number): Promise<ZulipMessage> {
    // Without `allow_empty_topic_name` Zulip returns the empty topic as the realm's translated display name, not ''.
    const { data } = await this.bot.GET('/messages/{message_id}', {
      params: { path: { message_id: id }, query: { allow_empty_topic_name: true } },
    });
    return { id: data!.message!.id ?? id, topic: data!.message!.subject ?? '' };
  }

  async updateMessage(id: number, { content, topic, propagateMode }: ZulipMessageUpdate) {
    await this.bot.PATCH('/messages/{message_id}', {
      params: { path: { message_id: id } },
      body: { content, topic, propagate_mode: propagateMode },
    });
  }

  /** An undocumented static file, served without authentication. */
  async getEmojiCodes() {
    const { origin } = this.site;
    const response = await fetch(`${origin}/static/generated/emoji/emoji_codes.json`, {
      signal: AbortSignal.timeout(EMOJI_CODES_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Could not fetch the Zulip emoji codes: ${response.status}`);
    }
    const codes = ((await response.json()) as { name_to_codepoint?: unknown } | null)?.name_to_codepoint;
    if (typeof codes !== 'object' || codes === null || Array.isArray(codes)) {
      throw new Error('The Zulip emoji codes have no name_to_codepoint table');
    }
    return Object.fromEntries(
      Object.entries(codes).flatMap(([name, codepoints]) => {
        const emoji = toEmoji(codepoints);
        return emoji === undefined ? [] : [[name, emoji] as const];
      }),
    );
  }

  async listEmoji(): Promise<ZulipEmoji[]> {
    const { data } = await this.bot.GET('/realm/emoji');
    return Object.values(data!.emoji ?? {}).map(({ name, deactivated }) => ({
      name: name ?? '',
      deactivated: deactivated ?? false,
    }));
  }

  async getSubscriptions(): Promise<ZulipSubscription[]> {
    const { data } = await this.bot.GET('/users/me/subscriptions');
    return data!.subscriptions.map(({ stream_id }) => ({ streamId: stream_id ?? 0 }));
  }

  async getOwnUser(): Promise<ZulipUser> {
    const { data } = await this.bot.GET('/users/me');
    if (data?.user_id === undefined) {
      throw new Error('Zulip returned no user ID for the bot');
    }
    return { userId: data.user_id, fullName: data.full_name ?? '' };
  }

  async getMessages({ stream, topic, numBefore }: ZulipMessagesQuery): Promise<ZulipReceivedMessage[]> {
    // `narrow` is typed as a JSON-encoded string by the spec, so it is stringified here rather than by the client.
    const narrow = JSON.stringify([
      { operator: 'channel', operand: stream },
      { operator: 'topic', operand: topic },
    ]);
    const { data } = await this.bot.GET('/messages', {
      params: { query: { anchor: 'newest', num_before: numBefore, num_after: 0, narrow, apply_markdown: false } },
    });
    return (data!.messages ?? []).map(toReceivedMessage);
  }

  async registerQueue(): Promise<ZulipQueueRegistration> {
    const { data } = await this.bot.POST('/register', {
      body: {
        event_types: ['message', 'update_message', 'delete_message'],
        apply_markdown: false,
        client_capabilities: CLIENT_CAPABILITIES as Record<string, never>,
        fetch_event_types: ['subscription'],
      },
    });
    if (!data?.queue_id) {
      throw new Error('Zulip registered no event queue');
    }

    const timeoutSeconds = data.event_queue_longpoll_timeout_seconds;
    if (timeoutSeconds && this.clients && this.botIdentity) {
      this.clients.events = createZulipClient({ ...this.botIdentity, timeoutMs: longpollTimeoutMs(timeoutSeconds) });
    }

    return {
      queue: { queueId: data.queue_id, lastEventId: data.last_event_id ?? -1 },
      subscribedStreamIds: (data.subscriptions ?? []).flatMap(({ stream_id }) =>
        stream_id === undefined ? [] : [stream_id],
      ),
    };
  }

  async getEvents({ queueId, lastEventId }: ZulipEventQueue, signal: AbortSignal): Promise<ZulipEvent[]> {
    const { data } = await this.events.GET('/events', {
      params: { query: { queue_id: queueId, last_event_id: lastEventId } },
      signal,
    });
    return (data!.events ?? []).map(toEvent);
  }

  async deleteQueue(queueId: string) {
    await this.bot.DELETE('/events', { body: { queue_id: queueId } });
  }

  async createEmote(name: string, emoteUrl: string) {
    const user = this.user;
    const emojiName = name.toLowerCase();

    const image = await fetch(emoteUrl, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!image.ok) {
      throw new Error(`Could not fetch emote image ${emoteUrl}: ${image.status}`);
    }

    // Zulip needs a real filename with an extension and the image's content type on the multipart part.
    const contentType = image.headers.get('content-type')?.split(';')[0].trim() || 'application/octet-stream';
    const extension = IMAGE_EXTENSIONS[contentType] ?? new URL(emoteUrl).pathname.match(/\.(\w+)$/)?.[1] ?? 'png';
    const file = new File([await image.arrayBuffer()], `${emojiName}.${extension}`, { type: contentType });

    await user.POST('/realm/emoji/{emoji_name}', {
      params: { path: { emoji_name: emojiName } },
      ...multipart({ filename: file }),
    });
  }
}

type RawEvent = NonNullable<paths['/events']['get']['responses'][200]['content']['application/json']['events']>[number];

const toReceivedMessage = (message: components['schemas']['MessagesBase']): ZulipReceivedMessage => ({
  id: message.id ?? -1,
  senderId: message.sender_id ?? -1,
  senderEmail: message.sender_email ?? '',
  senderFullName: message.sender_full_name ?? '',
  type: message.type === 'private' ? 'private' : 'stream',
  streamId: message.stream_id,
  topic: message.subject ?? '',
  content: message.content ?? '',
  timestamp: message.timestamp ?? 0,
  movedAt: message.last_moved_timestamp,
});

const toEvent = (event: RawEvent): ZulipEvent => {
  const id = event.id ?? -1;
  if (event.type === 'message' && event.message) {
    return { id, type: 'message', message: toReceivedMessage(event.message) };
  }
  if (event.type === 'update_message') {
    return {
      id,
      type: 'update_message',
      update: {
        userId: event.user_id,
        renderingOnly: event.rendering_only,
        messageId: event.message_id,
        messageIds: event.message_ids,
        streamId: event.stream_id,
        newStreamId: event.new_stream_id,
        origTopic: event.orig_subject,
        topic: event.subject,
        propagateMode: event.propagate_mode,
        content: event.content,
      },
    };
  }
  if (event.type === 'delete_message') {
    const { message_ids, message_id } = event;
    return {
      id,
      type: 'delete_message',
      deletion: {
        messageIds: message_ids ?? (message_id === undefined ? [] : [message_id]),
        streamId: event.stream_id,
        topic: event.topic,
      },
    };
  }
  return { id, type: event.type ?? 'unknown' };
};
