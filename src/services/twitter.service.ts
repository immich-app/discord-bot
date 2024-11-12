import { Inject, Injectable } from '@nestjs/common';
import { getConfig } from 'src/config';
import { ITwitterInterface } from 'src/interfaces/twitter.interface';

@Injectable()
export class TwitterService {
  constructor(@Inject(ITwitterInterface) private twitter: ITwitterInterface) {}

  async init() {
    const { twitter } = getConfig();
    if (twitter.bearerToken !== 'dev') {
      this.twitter.login(twitter);
      await this.twitter.sendTweet('Hello World!');
    }
  }
}
