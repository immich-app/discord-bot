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

  async createEmote(name: string, emote: string) {
    await this.zulipUser.callEndpoint(`/realm/emoji/${name.toLowerCase()}`, 'POST', { files: [emote] });
  }
}
