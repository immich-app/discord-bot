import {
  AnyThreadChannel,
  Channel,
  ChannelType,
  GuildTextBasedChannel,
  Message,
  MessageFlags,
  MessageType,
} from 'discord.js';
import { Constants } from 'src/constants';
import { DiscordSourceMessage } from 'src/interfaces/discord-mirror.interface';

const mirroredTypes = new Set<MessageType>([MessageType.Default, MessageType.Reply]);

export const isMirrorCandidate = (message: Message): message is Message<true> =>
  message.inGuild() &&
  Constants.Discord.Servers.includes(message.guildId) &&
  !message.author.bot &&
  message.webhookId === null &&
  !message.system &&
  mirroredTypes.has(message.type) &&
  message.channel.type !== ChannelType.PrivateThread;

export const mirrorLocation = (
  channel: GuildTextBasedChannel,
): { channelId: string; threadId: string | null; threadName: string | null } =>
  channel.isThread()
    ? { channelId: channel.parentId ?? channel.id, threadId: channel.id, threadName: channel.name }
    : { channelId: channel.id, threadId: null, threadName: null };

/** `undefined` outside a forum post. */
export const forumTagNames = (thread: AnyThreadChannel) => {
  const { parent } = thread;
  if (parent?.type !== ChannelType.GuildForum) {
    return undefined;
  }
  return thread.appliedTags.flatMap((id) => parent.availableTags.find((tag) => tag.id === id)?.name ?? []);
};

const displayNameOf = (message: Message) => message.member?.displayName ?? message.author.displayName;

const channelName = (channel: Channel) => ('name' in channel && channel.name ? channel.name : undefined);

const toReplyTo = (message: Message<true>): DiscordSourceMessage['replyTo'] => {
  const messageId = message.reference?.messageId;
  if (message.type !== MessageType.Reply || !messageId) {
    return null;
  }

  const referenced = message.channel.messages.cache.get(messageId);
  return {
    messageId,
    authorDisplayName: referenced ? displayNameOf(referenced) : null,
    content: referenced?.content ?? null,
  };
};

export const toDiscordSourceMessage = (message: Message<true>): DiscordSourceMessage => {
  const { mentions } = message;
  const channels: Record<string, string> = {};
  for (const [id, channel] of mentions.channels) {
    const name = channelName(channel);
    if (name) {
      channels[id] = name;
    }
  }

  const threadTags = message.channel.isThread() ? forumTagNames(message.channel) : undefined;
  return {
    id: message.id,
    guildId: message.guildId,
    ...mirrorLocation(message.channel),
    ...(threadTags ? { threadTags } : {}),
    createdTimestamp: message.createdTimestamp,
    jumpUrl: message.url,
    author: { id: message.author.id, username: message.author.username, displayName: displayNameOf(message) },
    silent: message.flags.has(MessageFlags.SuppressNotifications),
    content: message.content,
    mentions: {
      users: Object.fromEntries(
        mentions.users.map((user, id) => [id, mentions.members?.get(id)?.displayName ?? user.displayName]),
      ),
      roles: Object.fromEntries(mentions.roles.map((role, id) => [id, role.name])),
      channels,
    },
    attachments: message.attachments.map(({ id, name, url, size, contentType, spoiler }) => ({
      id,
      name,
      url,
      size,
      contentType,
      spoiler,
    })),
    stickers: message.stickers.map((sticker) => sticker.name),
    poll: message.poll?.question.text ?? null,
    forwarded: message.messageSnapshots.map((snapshot) => snapshot.content),
    replyTo: toReplyTo(message),
  };
};
