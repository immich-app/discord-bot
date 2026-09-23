import { Constants } from 'src/constants';
import { ZULIP_MAX_UNRESOLVED_TOPIC_LENGTH } from 'src/format';
import { MirrorLink } from 'src/schema';

export type EnabledPair = {
  /** The Discord channel ID: a channel is in one link at most, and its conversations are found again by it. */
  key: string;
  kind: 'text' | 'forum';
  discordChannelId: string;
  zulipStreamId: number;
  /** `''` is the empty topic, Zulip's "general chat", and `null` a forum's absence of one. */
  mainTopic: string | null;
  /** Catch-up never reaches back past the moment the link was made. */
  linkedAt: number;
};

export const toEnabledPair = (link: MirrorLink): EnabledPair => ({
  key: link.discordChannelId,
  kind: link.kind,
  discordChannelId: link.discordChannelId,
  zulipStreamId: link.zulipStreamId,
  mainTopic: link.kind === 'text' ? link.mainTopic : null,
  linkedAt: link.createdAt.getTime(),
});

export const mainTopicProblem = (topic: string) =>
  topic.trim() === '' || topic.trim() !== topic || [...topic].length > ZULIP_MAX_UNRESOLVED_TOPIC_LENGTH
    ? `the main topic must be 1 to ${ZULIP_MAX_UNRESOLVED_TOPIC_LENGTH} characters with no surrounding whitespace`
    : undefined;

export const holdsIdentityRole = (guildId: string, roleIds: string[]) =>
  (Constants.Discord.MirrorIdentityRoles[guildId] ?? []).some((roleId) => roleIds.includes(roleId));
