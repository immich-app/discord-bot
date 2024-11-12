export const ITwitterInterface = 'ITwitterInterface';

export interface ITwitterInterface {
  sendTweet(content: string): Promise<void>;
  login({ bearerToken }: { bearerToken: string }): void;
}
