import type { Client4, WebSocketEvents, WebSocketMessage } from '@mattermost/client';

export const IMattermostInterface = 'IMattermostInterface';

export type MattermostEvents = WebSocketEvents;
export type MattermostEventListener<T extends MattermostEvents> = (msg: WebSocketMessage & { event: T }) => unknown;
export type MattermostEventMessage<T extends MattermostEvents> = WebSocketMessage & {
  event: T;
};
export type Post = Awaited<ReturnType<Client4['createPost']>>;
export type Command = Awaited<ReturnType<Client4['addCommand']>>;
export type CommandWebhookRequest<T extends CommandParameters> = {
  channel_id: string;
  channel_name: string;
  command: string;
  team_domain: string;
  team_id: string;
  text: string;
  token: string;
  trigger_id: string;
  user_id: string;
  user_name: string;
} & {
  parameters: {
    [K in T[number]['name']]:
      | ((T[number] & { name: K })['optional'] extends true ? undefined : unknown)
      | (T[number] & { name: K })['type'] extends 'number'
      ? number
      : string;
  };
};

type ParameterType = 'text' | 'userMention' | 'channelMention' | 'number';
export type CommandParameters = Array<{ name: string; type: ParameterType; optional: boolean }>;
type RequiredProps = 'display_name' | 'description' | 'trigger' | 'team_id';
export type CommandCreate<T extends CommandParameters> = Pick<Command, RequiredProps> &
  Partial<Omit<Command, RequiredProps | 'id' | 'req' | 'method' | 'url' | 'auto_complete_hint'>> & { parameters?: T };
export type UserProfile = Awaited<ReturnType<Client4['getMe']>>;

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
  registerCommand: <const T extends CommandParameters = never>(
    command: CommandCreate<T>,
    handler: (data: CommandWebhookRequest<T>) => unknown,
  ) => Promise<void>;
  runCommand: (id: string, data: CommandWebhookRequest<never>) => Promise<unknown>;
}
