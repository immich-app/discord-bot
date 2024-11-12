import { Logger } from '@nestjs/common';
import { ITwitterInterface } from 'src/interfaces/twitter.interface';
import { TwitterApi } from 'twitter-api-v2';

export class TwitterRepository implements ITwitterInterface {
  private logger = new Logger(TwitterRepository.name);
  private client: TwitterApi;

  constructor() {
    this.client = new TwitterApi();
  }

  login({ bearerToken }: { bearerToken: string }) {
    this.client = new TwitterApi(bearerToken);
  }

  async sendTweet(content: string) {
    try {
      const user = await this.client.currentUserV2();
      this.logger.error(user);
      console.log(await this.client.v2.followers(user.data.id));
      await this.client.v2.tweet(content);
    } catch (e) {
      this.logger.error('Twitter client is not yet authenticated.', e);
    }
  }
}
