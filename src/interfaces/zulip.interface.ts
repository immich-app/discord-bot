export const IZulipInterface = 'IZulipInterface';

export type ZulipConfig = {
  bot: { username: string; apiKey: string };
  user: { username: string; apiKey: string };
  realm: string;
};
export type MessagePayload = { stream: string | number; topic?: string; content: string };

export interface IZulipInterface {
  init(config: ZulipConfig): Promise<void>;
  sendMessage(payload: MessagePayload): Promise<void>;
  createEmote(name: string, emoteUrl: string): Promise<void>;
}
