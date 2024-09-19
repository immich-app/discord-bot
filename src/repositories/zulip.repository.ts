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
};

export class ZulipRepository implements IZulipInterface {
  private logger = new Logger(ZulipRepository.name);
  private zulip: Zulip = {} as Zulip;

  async init(config: ZulipConfig) {
    this.zulip = await zulip(config);
  }

  async sendMessage({ stream, content, topic }: MessagePayload) {
    const response = await this.zulip.messages.send({ to: stream, type: 'stream', topic, content });
    this.logger.debug(response);
  }
}
