import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, TextBasedChannel } from 'discord.js';
import { ArgsOf, Discord, On } from 'discordx';
import { isMirrorCandidate, mirrorLocation, toDiscordSourceMessage } from 'src/mirror/discord-message';
import { MirrorService } from 'src/services/mirror.service';

const parentOf = (channel: TextBasedChannel | null) =>
  channel && !channel.isDMBased() ? mirrorLocation(channel).channelId : undefined;

/** Priority 0 runs these before every other handler of the same event, so the mirror enqueues in emission order. */
@Discord()
@Injectable()
export class DiscordMirrorEvents {
  private logger = new Logger(DiscordMirrorEvents.name);

  constructor(private mirror: MirrorService) {}

  @On({ event: 'messageCreate', priority: 0 })
  onMessageCreate([message]: ArgsOf<'messageCreate'>) {
    if (isMirrorCandidate(message) && this.mirror.handlesChannel(mirrorLocation(message.channel).channelId)) {
      this.mirror.onDiscordMessage(toDiscordSourceMessage(message));
    }
  }

  @On({ event: 'messageUpdate', priority: 0 })
  onMessageUpdate([, message]: ArgsOf<'messageUpdate'>) {
    if (isMirrorCandidate(message) && this.mirror.handlesChannel(mirrorLocation(message.channel).channelId)) {
      this.mirror.onDiscordMessageEdited(toDiscordSourceMessage(message));
    }
  }

  @On({ event: 'messageDelete', priority: 0 })
  onMessageDelete([message]: ArgsOf<'messageDelete'>) {
    const channelId = parentOf(message.channel);
    if (channelId && this.mirror.handlesChannel(channelId)) {
      this.mirror.onDiscordMessagesDeleted(channelId, [message.id]);
    }
  }

  @On({ event: 'messageDeleteBulk', priority: 0 })
  onMessageDeleteBulk([messages, channel]: ArgsOf<'messageDeleteBulk'>) {
    const channelId = parentOf(channel);
    if (channelId && this.mirror.handlesChannel(channelId)) {
      this.mirror.onDiscordMessagesDeleted(channelId, [...messages.keys()]);
    }
  }

  @On({ event: 'threadUpdate', priority: 0 })
  onThreadUpdate([oldThread, newThread]: ArgsOf<'threadUpdate'>) {
    const { parentId } = newThread;
    if (
      oldThread.name !== newThread.name &&
      newThread.type !== ChannelType.PrivateThread &&
      parentId &&
      this.mirror.handlesChannel(parentId)
    ) {
      this.mirror.onDiscordThreadRenamed({ channelId: parentId, threadId: newThread.id, name: newThread.name });
    }
  }

  @On({ event: 'threadDelete', priority: 0 })
  onThreadDelete([thread]: ArgsOf<'threadDelete'>) {
    if (thread.parentId && this.mirror.handlesChannel(thread.parentId)) {
      this.mirror.onDiscordThreadDeleted({ channelId: thread.parentId, threadId: thread.id });
    }
  }

  /** Not awaited, so the channel checks do not hold up the other `shardReady` handlers; the guard never sees it fail. */
  @On({ event: 'shardReady' })
  onShardReady() {
    void this.mirror
      .onDiscordReady()
      .catch((error) => this.logger.error('The Discord-Zulip mirror could not check its Discord channels', error));
  }

  @On({ event: 'shardReconnecting' })
  onShardReconnecting() {
    this.mirror.onDiscordDisconnected();
  }

  @On({ event: 'shardDisconnect' })
  onShardDisconnect() {
    this.mirror.onDiscordDisconnected();
  }

  @On({ event: 'shardResume' })
  onShardResume() {
    this.mirror.onDiscordResumed();
  }
}
