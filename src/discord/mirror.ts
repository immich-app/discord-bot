import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Message, PartialMessage, TextBasedChannel } from 'discord.js';
import { ArgsOf, Discord, On } from 'discordx';
import { Constants } from 'src/constants';
import { forumTagNames, isMirrorCandidate, mirrorLocation, toDiscordSourceMessage } from 'src/mirror/discord-message';
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
    if (this.isCandidate(message) && this.mirror.handlesChannel(mirrorLocation(message.channel).channelId)) {
      this.mirror.onDiscordMessage(toDiscordSourceMessage(message));
    }
  }

  @On({ event: 'messageUpdate', priority: 0 })
  onMessageUpdate([, message]: ArgsOf<'messageUpdate'>) {
    if (this.isCandidate(message) && this.mirror.handlesChannel(mirrorLocation(message.channel).channelId)) {
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

  @On({ event: 'messageReactionAdd', priority: 0 })
  onReactionAdd([reaction, user]: ArgsOf<'messageReactionAdd'>) {
    this.reactionsChanged(reaction.message, user.id);
  }

  @On({ event: 'messageReactionRemove', priority: 0 })
  onReactionRemove([reaction, user]: ArgsOf<'messageReactionRemove'>) {
    this.reactionsChanged(reaction.message, user.id);
  }

  @On({ event: 'messageReactionRemoveAll', priority: 0 })
  onReactionRemoveAll([message]: ArgsOf<'messageReactionRemoveAll'>) {
    this.reactionsChanged(message);
  }

  @On({ event: 'messageReactionRemoveEmoji', priority: 0 })
  onReactionRemoveEmoji([reaction]: ArgsOf<'messageReactionRemoveEmoji'>) {
    this.reactionsChanged(reaction.message);
  }

  /** Archiving is left alone: Discord archives a thread on its own once it goes quiet. */
  @On({ event: 'threadUpdate', priority: 0 })
  onThreadUpdate([oldThread, newThread]: ArgsOf<'threadUpdate'>) {
    const { parentId } = newThread;
    if (newThread.type === ChannelType.PrivateThread || !parentId || !this.mirror.handlesChannel(parentId)) {
      return;
    }
    if (oldThread.name !== newThread.name) {
      this.mirror.onDiscordThreadRenamed({ channelId: parentId, threadId: newThread.id, name: newThread.name });
    }
    const tags = forumTagNames(newThread);
    if (tags && oldThread.appliedTags.join() !== newThread.appliedTags.join()) {
      this.mirror.onDiscordThreadTagsChanged({ channelId: parentId, threadId: newThread.id, tags });
    }
  }

  @On({ event: 'threadDelete', priority: 0 })
  onThreadDelete([thread]: ArgsOf<'threadDelete'>) {
    if (thread.parentId && this.mirror.handlesChannel(thread.parentId)) {
      this.mirror.onDiscordThreadDeleted({ channelId: thread.parentId, threadId: thread.id });
    }
  }

  private isCandidate(message: Message): message is Message<true> {
    return isMirrorCandidate(message, (webhookId) => this.mirror.isOwnWebhook(webhookId));
  }

  /** The bot's own reactions are the mirror's, never mirrored back. */
  private reactionsChanged(message: Message | PartialMessage, userId?: string) {
    if (userId === message.client.user.id || !Constants.Discord.Servers.includes(message.guildId ?? '')) {
      return;
    }
    const channelId = parentOf(message.channel);
    if (channelId && this.mirror.handlesChannel(channelId)) {
      this.mirror.onDiscordReactionsChanged(channelId, message.id);
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
