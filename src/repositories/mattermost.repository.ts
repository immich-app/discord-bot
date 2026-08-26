import { Client4, WebSocketClient } from '@mattermost/client';
import { getConfig } from 'src/config';
import {
  IMattermostInterface,
  MattermostEvents,
  type MattermostEventListener,
} from 'src/interfaces/mattermost.interface';
import WebSocket from 'ws';

export class MattermostRepository implements IMattermostInterface {
  #client: Client4;
  #wsClient: WebSocketClient;
  #userId!: string;
  #eventListeners: Partial<{ [K in MattermostEvents]: MattermostEventListener<K>[] }> = {};

  constructor() {
    const { mattermost } = getConfig();

    globalThis.WebSocket = WebSocket as never;
    this.#client = new Client4();
    this.#client.setUrl(mattermost.domain);
    this.#client.setToken(mattermost.botToken);

    const wsClient = new WebSocketClient();
    wsClient.initialize(this.#client.getWebSocketUrl(), mattermost.botToken);
    this.#wsClient = wsClient;
  }

  async init() {
    const { id } = await this.#client.getMe();
    this.#userId = id;

    this.#wsClient.addMessageListener(async (msg) => {
      // I have to cast the type safety away since the union type becomes too complex for TS
      const listeners = (this.#eventListeners[msg.event] ?? []) as ((msg: unknown) => unknown)[];
      await Promise.all(listeners.map((listener) => listener(msg)));
    });
  }

  registerEventListener<T extends MattermostEvents>(event: T, listener: MattermostEventListener<T>) {
    if (!this.#eventListeners[event]) {
      this.#eventListeners[event] = [];
    }
    this.#eventListeners[event].push(listener);
  }

  async send({ channelId, message, props }: { channelId: string; message: string; props?: Record<string, unknown> }) {
    await this.#client.createPost({ channel_id: channelId, message, props });
  }

  async reply({ channelId, rootId, message }: { channelId: string; rootId: string; message: string }) {
    await this.#client.createPost({ channel_id: channelId, root_id: rootId, message });
  }

  async updatePost({ postId, message }: { postId: string; message: string }) {
    await this.#client.patchPost({ id: postId, message, props: { remove_link_preview: 'true' } });
  }

  async createEmote(name: string, emoteUrl: string) {
    const emote = await fetch(emoteUrl).then((response) => response.blob());
    await this.#client.createCustomEmoji({ creator_id: this.#userId, name }, new File([emote], name));
  }

  async *streamChannels(teamId?: string) {
    let totalCount: number | undefined;
    let page = 0;
    const pageSize = 100;

    while (true) {
      const { channels, total_count } = await this.#client.getAllChannels(
        page,
        pageSize,
        undefined,
        true,
        true,
        false,
        true,
        false,
        false,
      );

      for (const channel of channels) {
        if (teamId && channel.team_id === teamId) {
          yield channel;
        }
      }

      if (!Number.isSafeInteger(total_count)) {
        break;
      }

      if (totalCount === undefined) {
        totalCount = total_count;
      }

      if (++page * pageSize >= totalCount) {
        break;
      }
    }
  }

  async joinChannel(channelId: string) {
    await this.#client.addToChannel(this.#userId, channelId);
  }
}
