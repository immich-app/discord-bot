import { IZulipInterface, MessagePayload, type ZulipConfig } from 'src/interfaces/zulip.interface';
import { createZulipClient, multipart, type ZulipClient } from 'src/repositories/zulip.client';

const IMAGE_TIMEOUT_MS = 30_000;
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
};

export class ZulipRepository implements IZulipInterface {
  private clients?: { bot: ZulipClient; user: ZulipClient };

  async init({ realm, bot, user }: ZulipConfig) {
    this.clients = {
      bot: createZulipClient({ realm, ...bot }),
      user: createZulipClient({ realm, ...user }),
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

  private client(identity: 'bot' | 'user') {
    if (!this.clients) {
      throw new Error('Zulip client not initialised: call init() first');
    }
    return this.clients[identity];
  }

  async sendMessage({ stream, topic, content }: MessagePayload) {
    const { data } = await this.bot.POST('/messages', { body: { type: 'channel', to: stream, topic, content } });
    return { id: data!.id };
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
