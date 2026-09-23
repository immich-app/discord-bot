import { Constants, MirrorPairConfig, MirrorPairKey } from 'src/constants';
import { ZULIP_MAX_UNRESOLVED_TOPIC_LENGTH } from 'src/format';
import { DiscordChannel } from 'src/interfaces/discord.interface';

export type EnabledPair = {
  key: MirrorPairKey;
  kind: 'text' | 'forum';
  discordChannelId: string;
  zulipStreamId: number;
  mainTopic: string | null;
  public: boolean;
};

export type MirrorConfigReport = {
  enabled: EnabledPair[];
  placeholders: MirrorPairKey[];
  problems: string[];
  teamMembers: Map<number, string>;
};

const SNOWFLAKE = /^\d{17,20}$/;

const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

const internalStreams = () => {
  const { Streams, TeamStreams, Expanders, Commands, RequiredSubscriptions } = Constants.Zulip;
  return new Set<number>([
    ...Object.values(Streams),
    ...Object.values(TeamStreams),
    ...Object.values(Expanders).flat(),
    ...Commands,
    ...RequiredSubscriptions,
  ]);
};

const internalChannels = () => {
  const { DevFocusTopic, ...channels } = Constants.Discord.Channels;
  return new Set<string>(
    [...Object.values(DiscordChannel), ...Object.values(channels)].filter((id) => id !== DevFocusTopic),
  );
};

const shapeProblems = (
  key: MirrorPairKey,
  pair: MirrorPairConfig & { discordChannelId: string; zulipStreamId: number },
) => {
  const problems: string[] = [];
  if (!SNOWFLAKE.test(pair.discordChannelId)) {
    problems.push(`${key}: the Discord channel ID "${pair.discordChannelId}" is not a snowflake, so the pair is off`);
  }
  if (!isPositiveInteger(pair.zulipStreamId)) {
    problems.push(`${key}: the Zulip stream ID ${pair.zulipStreamId} is not a positive integer, so the pair is off`);
  }
  if (pair.kind === 'text') {
    const topic = pair.mainTopic;
    if (topic === undefined) {
      problems.push(`${key}: a text pair needs a main topic, so the pair is off`);
    } else if (topic.trim() === '' || topic.trim() !== topic || [...topic].length > ZULIP_MAX_UNRESOLVED_TOPIC_LENGTH) {
      problems.push(
        `${key}: the main topic must be 1 to ${ZULIP_MAX_UNRESOLVED_TOPIC_LENGTH} characters with no surrounding whitespace, so the pair is off`,
      );
    }
  }
  if (internalStreams().has(pair.zulipStreamId)) {
    problems.push(
      `${key}: Zulip stream ${pair.zulipStreamId} is an internal stream in Constants.Zulip, so the pair is off`,
    );
  }
  if (internalChannels().has(pair.discordChannelId)) {
    problems.push(`${key}: Discord channel ${pair.discordChannelId} is an internal channel, so the pair is off`);
  }
  return problems;
};

const duplicateProblems = (pairs: [MirrorPairKey, MirrorPairConfig][]) => {
  const problems: string[] = [];
  const involved = new Set<MirrorPairKey>();
  const check = (describe: string, idOf: (pair: MirrorPairConfig) => string | number | null) => {
    const owners = new Map<string | number, MirrorPairKey[]>();
    for (const [key, pair] of pairs) {
      const id = idOf(pair);
      if (id !== null) {
        owners.set(id, [...(owners.get(id) ?? []), key]);
      }
    }
    for (const [id, keys] of owners) {
      if (keys.length > 1) {
        problems.push(`${keys.join(', ')}: ${describe} ${id} is in more than one pair, so none of them is mirrored`);
        for (const key of keys) {
          involved.add(key);
        }
      }
    }
  };
  check('Discord channel', (pair) => pair.discordChannelId);
  check('Zulip stream', (pair) => pair.zulipStreamId);
  return { problems, involved };
};

const validateTeamMembers = (teamMembers: Record<number, string>) => {
  const problems: string[] = [];
  const valid: [number, string][] = [];
  for (const [key, discordId] of Object.entries(teamMembers) as [string, unknown][]) {
    const zulipId = Number(key);
    if (!/^[1-9]\d*$/.test(key) || !isPositiveInteger(zulipId)) {
      problems.push(`Constants.Mirror.TeamMembers: "${key}" is not a Zulip user ID, so the entry is ignored`);
    } else if (typeof discordId !== 'string' || !SNOWFLAKE.test(discordId)) {
      problems.push(
        `Constants.Mirror.TeamMembers: Zulip user ${key} maps to "${discordId}", which is not a Discord user ID, so the entry is ignored`,
      );
    } else {
      valid.push([zulipId, discordId]);
    }
  }

  const byDiscordId = Map.groupBy(valid, ([, discordId]) => discordId);
  const members = new Map<number, string>();
  for (const [discordId, entries] of byDiscordId) {
    if (entries.length > 1) {
      const zulipIds = entries.map(([zulipId]) => zulipId).join(', ');
      problems.push(
        `Constants.Mirror.TeamMembers: Zulip users ${zulipIds} all map to Discord user ${discordId}, so all of them are ignored`,
      );
      continue;
    }
    members.set(entries[0][0], discordId);
  }
  return { problems, members };
};

export const validateMirrorConfig = (
  pairs: Record<MirrorPairKey, MirrorPairConfig>,
  teamMembers: Record<number, string>,
): MirrorConfigReport => {
  const entries = Object.entries(pairs) as [MirrorPairKey, MirrorPairConfig][];
  const placeholders: MirrorPairKey[] = [];
  const problems: string[] = [];
  const candidates: EnabledPair[] = [];

  for (const [key, pair] of entries) {
    const { discordChannelId, zulipStreamId } = pair;
    if (discordChannelId === null || zulipStreamId === null) {
      placeholders.push(key);
      continue;
    }
    const pairProblems = shapeProblems(key, { ...pair, discordChannelId, zulipStreamId });
    problems.push(...pairProblems);
    if (pairProblems.length === 0) {
      candidates.push({
        key,
        kind: pair.kind,
        discordChannelId,
        zulipStreamId,
        mainTopic: pair.kind === 'text' ? (pair.mainTopic ?? null) : null,
        public: pair.public ?? false,
      });
    }
  }

  const duplicates = duplicateProblems(entries);
  problems.push(...duplicates.problems);
  const members = validateTeamMembers(teamMembers);
  problems.push(...members.problems);

  return {
    enabled: candidates.filter(({ key }) => !duplicates.involved.has(key)),
    placeholders,
    problems,
    teamMembers: members.members,
  };
};
