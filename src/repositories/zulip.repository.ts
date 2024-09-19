import { Logger } from '@nestjs/common';
import { IZulipInterface, MessagePayload, type ZulipConfig } from 'src/interfaces/zulip.interface';
// @ts-expect-error: that stupid sdk does not have types
import zulip from 'zulip-js';

export class ZulipRepository implements IZulipInterface {
  private logger = new Logger(ZulipRepository.name);
  private zulip: any;

  constructor() {}

  async init(config: ZulipConfig) {
    this.zulip = await zulip(config);
  }

  async sendMessage({ stream, content, topic }: MessagePayload) {
    const response = await this.zulip.messages.send({ to: stream, type: 'stream', topic, content });
    this.logger.debug(response);
  }
}
