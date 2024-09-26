export const IZulipInterface = 'IZulipInterface';

export type ZulipConfig = { username: string; apiKey: string; realm: string };
export type MessagePayload = { stream: string | number; topic?: string; content: string };

export interface IZulipInterface {
  init(config: ZulipConfig): Promise<void>;
  sendMessage(payload: MessagePayload): Promise<void>;
}
