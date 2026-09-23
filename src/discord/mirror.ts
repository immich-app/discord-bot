import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, TextBasedChannel } from 'discord.js';
import { ArgsOf, Discord, On } from 'discordx';
import { isMirrorCandidate, mirrorLocation, toDiscordSourceMessage } from 'src/mirror/discord-message';
import { MirrorService } from 'src/services/mirror.service';

const parentOf = (channel: TextBasedChannel | null) =>
  channel && !channel.isDMBased() ? mirrorLocation(channel).channelId : undefined;

/**
 * Priority 0 runs these before every other handler of the same event, so the mirror enqueues in emission order.
 * discordx swallows handler errors, so each handler logs its own.
 */
@Discord()
@Injectable()
export class DiscordMirrorEvents {
  private logger = new Logger(DiscordMirrorEvents.name);

  constructor(private mirror: MirrorService) {}

  @On({ event: 'messageCreate', priority: 0 })
  onMessageCreate([message]: ArgsOf<'messageCreate'>) {
    this.handle('messageCreate', () => {
      if (isMirrorCandidate(message) && this.mirror.handlesChannel(mirrorLocation(message.channel).channelId)) {
        this.mirror.onDiscordMessage(toDiscordSourceMessage(message));
      }
    });
  }

  @On({ event: 'messageUpdate', priority: 0 })
  onMessageUpdate([, message]: ArgsOf<'messageUpdate'>) {
    this.handle('messageUpdate', () => {
      if (isMirrorCandidate(message) && this.mirror.handlesChannel(mirrorLocation(message.channel).channelId)) {
        this.mirror.onDiscordMessageEdited(toDiscordSourceMessage(message));
      }
    });
  }

  @On({ event: 'messageDelete', priority: 0 })
  onMessageDelete([message]: ArgsOf<'messageDelete'>) {
    this.handle('messageDelete', () => {
      const channelId = parentOf(message.channel);
      if (channelId && this.mirror.handlesChannel(channelId)) {
        this.mirror.onDiscordMessagesDeleted(channelId, [message.id]);
      }
    });
  }

  @On({ event: 'messageDeleteBulk', priority: 0 })
  onMessageDeleteBulk([messages, channel]: ArgsOf<'messageDeleteBulk'>) {
    this.handle('messageDeleteBulk', () => {
      const channelId = parentOf(channel);
      if (channelId && this.mirror.handlesChannel(channelId)) {
        this.mirror.onDiscordMessagesDeleted(channelId, [...messages.keys()]);
      }
    });
  }

  @On({ event: 'threadUpdate', priority: 0 })
  onThreadUpdate([oldThread, newThread]: ArgsOf<'threadUpdate'>) {
    this.handle('threadUpdate', () => {
      const { parentId } = newThread;
      if (
        oldThread.name !== newThread.name &&
        newThread.type !== ChannelType.PrivateThread &&
        parentId &&
        this.mirror.handlesChannel(parentId)
      ) {
        this.mirror.onDiscordThreadRenamed({ channelId: parentId, threadId: newThread.id, name: newThread.name });
      }
    });
  }

  @On({ event: 'threadDelete', priority: 0 })
  onThreadDelete([thread]: ArgsOf<'threadDelete'>) {
    this.handle('threadDelete', () => {
      if (thread.parentId && this.mirror.handlesChannel(thread.parentId)) {
        this.mirror.onDiscordThreadDeleted({ channelId: thread.parentId, threadId: thread.id });
      }
    });
  }

  @On({ event: 'shardReady' })
  onShardReady() {
    void this.mirror
      .onDiscordReady()
      .catch((error) => this.logger.error('The Discord-Zulip mirror could not check its Discord channels', error));
  }

  @On({ event: 'shardReconnecting' })
  onShardReconnecting() {
    this.handle('shardReconnecting', () => this.mirror.onDiscordDisconnected());
  }

  @On({ event: 'shardDisconnect' })
  onShardDisconnect() {
    this.handle('shardDisconnect', () => this.mirror.onDiscordDisconnected());
  }

  @On({ event: 'shardResume' })
  onShardResume() {
    this.handle('shardResume', () => this.mirror.onDiscordResumed());
  }

  private handle(event: string, run: () => void) {
    try {
      run();
    } catch (error) {
      this.logger.error(`The Discord-Zulip mirror failed on ${event}`, error);
    }
  }
}
