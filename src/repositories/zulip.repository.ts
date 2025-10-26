import { Logger } from '@nestjs/common';
import { IZulipInterface, MessagePayload, type ZulipConfig } from 'src/interfaces/zulip.interface';
// @ts-expect-error: that stupid sdk does not have types
import zulip from 'zulip-js';

type Zulip = {
  messages: {
    send: ({
      to,
      type,
      topic,
      content,
    }: {
      to: string | number;
      type: 'stream' | 'channel' | 'direct';
      topic?: string;
      content: string;
    }) => Promise<string>;
  };
  callEndpoint: (path: string, method: 'GET' | 'POST', params: object) => Promise<void>;
  config: {
    realm: string;
    apiURL: string;
    username: string;
    apiKey: string;
  };
};

export class ZulipRepository implements IZulipInterface {
  private logger = new Logger(ZulipRepository.name);
  private zulip: Zulip = {} as Zulip;
  private zulipUser: Zulip = {} as Zulip;

  async init({ realm, bot, user }: ZulipConfig) {
    this.zulip = await zulip({ realm, ...bot });
    this.zulipUser = await zulip({ realm, ...user });
  }

  async sendMessage({ stream, content, topic }: MessagePayload) {
    const response = await this.zulip.messages.send({ to: stream, type: 'stream', topic, content });
    this.logger.debug(response);
  }

  async createEmote(name: string, emoteUrl: string) {
    const authentication = `Basic ${Buffer.from(`${this.zulipUser.config.username}:${this.zulipUser.config.apiKey}`).toString('base64')}`;
    const emote = await fetch(emoteUrl).then((response) => response.blob());

    const form = new FormData();
    form.append('filename', emote);

    await fetch(`${this.zulipUser.config.apiURL}/realm/emoji/${name.toLowerCase()}`, {
      method: 'POST',
      headers: { Authorization: authentication },
      body: form,
    });
  }
}
