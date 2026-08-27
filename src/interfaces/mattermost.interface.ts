import type { Client4, WebSocketEvents, WebSocketMessage } from '@mattermost/client';

export const IMattermostInterface = 'IMattermostInterface';

export type MattermostEvents = WebSocketEvents;
export type MattermostEventListener<T extends MattermostEvents> = (msg: WebSocketMessage & { event: T }) => unknown;
export type MattermostEventMessage<T extends MattermostEvents> = WebSocketMessage & {
  event: T;
};
export type Post = Awaited<ReturnType<Client4['createPost']>>;

export interface IMattermostInterface {
  init: () => Promise<void>;
  registerEventListener: <T extends MattermostEvents>(event: T, listener: MattermostEventListener<T>) => void;
  send: (post: { channelId: string; message: string; props?: Record<string, unknown> }) => Promise<void>;
  reply: (reply: { channelId: string; rootId: string; message: string }) => Promise<void>;
  updatePost: (post: { postId: string; message: string }) => Promise<void>;
  createEmote: (name: string, emoteUrl: string) => Promise<void>;
  streamChannels: (
    teamId?: string,
  ) => AsyncGenerator<Awaited<ReturnType<Client4['getAllChannels']>>['channels'][number]>;
  joinChannel: (channelId: string) => Promise<void>;
}
