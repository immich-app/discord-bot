import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { getConfig } from 'src/config';
import { Constants } from 'src/constants';
import { isResolvedTopic, plural, ZULIP_RESOLVED_PREFIX, zulipNarrowLink } from 'src/format';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import {
  DiscordMirrorChannel,
  DiscordMirrorError,
  DiscordMirrorErrorKind,
  DiscordMirrorSend,
  DiscordMirrorSent,
  DiscordMirrorTarget,
  DiscordReactionEmoji,
  DiscordSourceMessage,
  DiscordTeamMember,
  IDiscordMirrorInterface,
} from 'src/interfaces/discord-mirror.interface';
import {
  IZulipInterface,
  ZulipEmojiCodes,
  ZulipMessage,
  ZulipMessagesDeleted,
  ZulipMessageUpdated,
  ZulipReactionChanged,
  ZulipReactionEmoji,
  ZulipReceivedMessage,
} from 'src/interfaces/zulip.interface';
import {
  DiscordRenderContext,
  discordSourceHash,
  toZulipAttachmentLines,
  toZulipMirrorBody,
  toZulipReplySnippet,
  withZulipTags,
  ZulipAttachmentResult,
  zulipAuthorHeader,
  ZulipChannel,
  zulipMirrorContent,
  zulipMirrorLead,
  ZulipReplyTarget,
  zulipTagsNotice,
  zulipThreadContext,
} from 'src/mirror/discord-to-zulip';
import { downloadDiscordAttachment } from 'src/mirror/download';
import {
  EMPTY_TOPIC_NAME,
  sanitiseWebhookUsername,
  toDiscordThreadName,
  topicCandidates,
  topicKey,
  toZulipTopicName,
} from 'src/mirror/names';
import { isConnectFailure } from 'src/mirror/network';
import { EnabledPair, holdsIdentityRole, toEnabledPair } from 'src/mirror/pairs';
import { SerialQueue } from 'src/mirror/queue';
import {
  discordReactionKey,
  EmoteMaps,
  toDiscordReactionEmoji,
  toEmoteMaps,
  toZulipReactionEmoji,
  withVariationSelectors,
  zulipReactionKey,
} from 'src/mirror/reactions';
import {
  channelRefKey,
  escapeDiscordInline,
  parseZulipRefs,
  splitDiscordContent,
  toDiscordMirrorContent,
  ZulipChannelRef,
  ZulipMessageRef,
} from 'src/mirror/zulip-to-discord';
import { isZulipFailure, isZulipMessageGone, isZulipRefusal, ZulipApiError } from 'src/repositories/zulip.client';
import { MirrorConversation, MirrorIdentity, MirrorLink, MirrorMessage, NewMirrorMessage } from 'src/schema';
import { hasBlacklistedUrl, zulipBuiltInEmoji } from 'src/services/chat.service';
import { isBotSender, ZulipService } from 'src/services/zulip.service';
import { parseCommand } from 'src/zulip-command-parser';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const THROTTLE_MS = 10 * MINUTE;
const IDENTITY_CACHE_MS = 10 * MINUTE;
const LATE_MS = 120_000;
const RETRY_DELAYS_MS = [1_000, 5_000];
const SHUTDOWN_GRACE_MS = 5_000;
const RECOVERY_DEPTH = 20;
const CATCH_UP_PAGE = 100;
const CATCH_UP_PAGES = 5;
const CATCH_UP_RETRY_MS = 30_000;
const MAX_CATCH_UP_RETRY_MS = 10 * MINUTE;
const MAX_CREATE_ATTEMPTS = 3;
const RESUME_MS = 30_000;
const DISCORD_CHANGE_ATTEMPTS = 20;
const CHANNEL_CHECK_MS = 10 * MINUTE;
const DISCORD_EPOCH = 1_420_070_400_000n;
const ACTIVE_THREAD_DAYS = 7;
const ACTIVE_THREAD_LIMIT = 20;
const NEW_THREAD_LIMIT = 20;
const RECHECK_LIMIT = 200;
const ZULIP_ID_BATCH = 100;
const MAX_FILES = 10;
const MAX_TOTAL_FILE_BYTES = 24 * 1024 * 1024;
const FILE_TRANSFER_BUDGET_MS = 120_000;
const DISCORD_MESSAGE_LENGTH = 2000;
const BACKFILL_PAGE = 100;
const BACKFILL_PACE_MS = 1_000;
const URLS = /https?:\/\/[^\s<>)]+/g;
const CUSTOM_EMOTE_IDS = /<a?:\w+:(\d+)>/g;
const CHANNEL_MENTION = /<#(\d+)>/g;
const THREAD_DELETED_NOTICE = 'The Discord thread for this topic was deleted; the next message here starts a new one.';

const BACKFILL_STOPS: Record<BackfillStop, string> = {
  off: 'the mirror of this channel went off, see the log',
  unlinked: 'the channel was unlinked',
  shutdown: 'the bot shut down',
  gone: 'the Discord channel or thread no longer exists',
  failed: 'reading Discord or posting to Zulip failed, see the log',
};

export const describeBackfillStop = (stop: BackfillStop) => BACKFILL_STOPS[stop];

const NOTICE_REASONS: Partial<Record<DiscordMirrorErrorKind, string>> = {
  forbidden: 'the bot is missing permissions in the Discord channel',
  'max-webhooks': 'the Discord channel has too many webhooks for the bot to add its own',
  forum: 'Discord refused to create the forum post',
  'too-large': 'the message is too large for Discord',
  'unknown-channel': 'the Discord channel or thread no longer exists',
};

type PairState = {
  pair: EnabledPair;
  queue: SerialQueue;
  status: 'pending' | 'ready' | 'disabled';
  /** What turned the pair off, so that a check finding the same again does not log it again. */
  offReason?: string;
  /** The permissions last warned about, for the same reason. */
  missingWarned?: string;
  guildId?: string;
  channelName?: string;
  announced: boolean;
  /** Whether the webhook was ever found, so that a missing one means Discord deleted it, not a failed first lookup. */
  webhookFound: boolean;
  webhookRecreatedAt?: number;
  catchUpQueued: boolean;
  /** Live creates wait until catch-up has run: mirroring one first would move the high-water mark past what was missed. */
  caughtUp: boolean;
  /** Changes whenever the mirror may have missed something, which makes a catch-up already read out of date. */
  generation: number;
  /** Where creates were turned away since the last complete catch-up, which reads there as well. */
  turnedAway: TurnedAway;
  retryTimer?: NodeJS.Timeout;
  retryDelayMs: number;
  /** Edits, deletions and renames held back, in order, until the side they go to is ready. */
  held: Record<Side, Op[]>;
  unheard: Record<Side, boolean>;
  resumeTimer?: NodeJS.Timeout;
  /** By Discord channel or thread ID. */
  backfills: Map<string, Backfill>;
};

export type BackfillTarget =
  { discordChannelId: string; threadId: string | null } | { zulipStreamId: number; topic: string };

/** `topic` is left out for a thread that has no Zulip topic yet, which the backfill opens. */
export type BackfillPlan = {
  kind: 'text' | 'forum';
  discordChannelId: string;
  threadId: string | null;
  zulipStreamId: number;
  stream?: string;
  topic?: string;
};

export type BackfillRefusal = 'off' | 'not-linked' | 'no-conversation' | 'not-ready' | 'running';

export type BackfillStop = 'off' | 'unlinked' | 'shutdown' | 'gone' | 'failed';

/** `noticed` is whether the history notices were posted, which `copied` and `failed` then count between. */
export type BackfillOutcome = { copied: number; failed: number; noticed: boolean; stopped?: BackfillStop };

type Backfill = {
  location: string;
  threadId: string | null;
  /** Nothing newer than the moment the backfill started is copied: the live path mirrors it. */
  until: bigint;
  after: bigint;
  more: boolean;
  /** The part of the current page not copied yet, never more than a page. */
  page: DiscordSourceMessage[];
  reacted: Set<string>;
  copied: number;
  failed: number;
  /** The topic claimed for a thread that has none, which the start notice holds until the first copy opens it. */
  newTopic?: string;
  noticed: boolean;
  /** Live creates for the location, which wait until the history is in. */
  held: Op[];
  timer?: NodeJS.Timeout;
  finished: boolean;
  resolve: (outcome: BackfillOutcome) => void;
};

type CreateOutcome = 'created' | 'skipped' | 'held' | 'retry' | 'failed';

type Side = 'Discord' | 'Zulip';

type Op = { label: string; run: () => Promise<void> };

/** The first message turned away per Discord channel or thread, and every Zulip message turned away. */
type TurnedAway = { discord: Map<string, bigint>; zulip: Set<number> };

type Missed<T> = { messages: T[]; complete: boolean };

type CreateAttempt = { posted: boolean; uncertain: boolean };

type Identity = { username: string; avatarUrl?: string };

type TeamMemberMaps = { discordByZulip: Map<number, string>; zulipByDiscord: Map<string, number> };

type Note = { name: string; spoiler: boolean };

type OutgoingZulipMessage = {
  text: string;
  pingUserIds: string[];
  files: File[];
  notes: Note[];
  identity: Identity;
};

/** Zulip's email gateway posts incoming email under its own name, without the `-bot@` every other bot address has. */
const EMAIL_GATEWAY = 'emailgateway@zulip.com';

const isZulipBot = (message: ZulipReceivedMessage) =>
  isBotSender(message) || message.senderEmail.toLowerCase() === EMAIL_GATEWAY;

/** Zulip's Notification Bot says what Zulip did, such as a move or a resolve, which the mirror carries over itself. */
const isMirroredSender = (message: ZulipReceivedMessage) => !/^notification-bot@/i.test(message.senderEmail);

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const isMirrorError = (error: unknown, kind: DiscordMirrorErrorKind): error is DiscordMirrorError =>
  error instanceof DiscordMirrorError && error.kind === kind;

/** A 429 that reaches the mirror has outlasted the client's own retries; any other 4xx would only be refused again. */
const isTransientZulipFailure = (error: unknown) =>
  isZulipFailure(error) && !(error instanceof ZulipApiError && error.status < 500 && error.status !== 429);

const isNothingToChange = (error: unknown) => error instanceof ZulipApiError && error.msg === 'Nothing to change';

const describe = (error: unknown) => {
  if (error instanceof DiscordMirrorError) {
    return error.code === undefined ? error.kind : `${error.kind} (${error.code})`;
  }
  return error instanceof Error ? error.message : String(error);
};

const isExpected = (error: unknown) => error instanceof DiscordMirrorError || isZulipFailure(error);

const isTransient = (error: unknown) =>
  isTransientZulipFailure(error) || isMirrorError(error, 'unavailable') || isMirrorError(error, 'unreachable');

const mayHaveBeenCarriedOut = (error: unknown) =>
  isMirrorError(error, 'unavailable') ||
  (error instanceof ZulipApiError ? error.status >= 500 : isZulipFailure(error) && !isConnectFailure(error));

const noneTurnedAway = (): TurnedAway => ({ discord: new Map(), zulip: new Set() });

const isEmpty = ({ discord, zulip }: TurnedAway) => discord.size === 0 && zulip.size === 0;

/** Says nothing about the message: the side cannot be reached at all, or refuses every request for now. */
const isOutage = (error: unknown) =>
  isConnectFailure(error) ||
  isMirrorError(error, 'unreachable') ||
  (error instanceof ZulipApiError && error.status === 429);

const snowflakeAt = (ms: number) => (BigInt(ms) - DISCORD_EPOCH) << 22n;

const isMainTopic = (pair: EnabledPair, key: string) => pair.mainTopic !== null && key === topicKey(pair.mainTopic);

const suppressEmbeds = (content: string) => hasBlacklistedUrl(content.match(URLS) ?? []);

const jumpUrl = (guildId: string, channelId: string, messageId: string) =>
  `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

const uploadName = (path: string) => {
  const segment = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** The files of one message share a deadline well inside the queue's watchdog; one past it becomes a note. */
const transferDeadline = () => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('The files of this message took too long to transfer', 'TimeoutError')),
    FILE_TRANSFER_BUDGET_MS,
  );
  return { signal: controller.signal, done: () => clearTimeout(timer) };
};

const SPOILER_FILE = 'SPOILER_';

const toNote = ({ name }: File): Note => ({
  name: name.startsWith(SPOILER_FILE) ? name.slice(SPOILER_FILE.length) : name,
  spoiler: name.startsWith(SPOILER_FILE),
});

const noteLine = ({ name, spoiler }: Note) => {
  const line = `*(attachment not mirrored: ${escapeDiscordInline(name)})*`;
  return spoiler ? `||${line}||` : line;
};

/** The notes about files that could not be attached go on part 0, next to the files that could. */
const withNotes = (text: string, noteList: Note[]) => {
  const notes = noteList.map(noteLine).join('\n');
  const parts = splitDiscordContent(text);
  if (!notes) {
    return parts;
  }
  if (parts.length === 0) {
    return [notes];
  }
  if (parts[0].length + notes.length + 1 <= DISCORD_MESSAGE_LENGTH) {
    return [`${parts[0]}\n${notes}`, ...parts.slice(1)];
  }
  return splitDiscordContent(`${notes}\n${text}`);
};

const zulipOriginRow = (
  pair: EnabledPair,
  source: Pick<MirrorMessage, 'conversationId' | 'zulipMessageId' | 'zulipSenderId' | 'sourceHash'>,
  posted: DiscordMirrorSent,
  part: number,
): NewMirrorMessage => ({
  discordMessageId: posted.messageId,
  conversationId: source.conversationId,
  origin: 'zulip',
  discordChannelId: pair.discordChannelId,
  discordThreadId: posted.channelId === pair.discordChannelId ? null : posted.channelId,
  discordWebhookId: posted.webhookId,
  discordAuthorId: null,
  zulipMessageId: source.zulipMessageId,
  zulipStreamId: pair.zulipStreamId,
  zulipSenderId: source.zulipSenderId,
  part,
  sourceHash: source.sourceHash,
  zulipHeader: null,
  zulipAttachments: null,
});

const channelProblem = (pair: EnabledPair, channel: DiscordMirrorChannel | undefined) => {
  if (!channel) {
    return 'does not exist';
  }
  if (channel.kind !== pair.kind) {
    return `is not a ${pair.kind === 'text' ? 'text channel' : 'forum'}`;
  }
  return undefined;
};

const toTeamMembers = (identities: MirrorIdentity[]) =>
  new Map(identities.map(({ zulipUserId, discordUserId }) => [zulipUserId, discordUserId]));

const toTarget = (row: MirrorMessage): DiscordMirrorTarget => ({
  channelId: row.discordChannelId,
  threadId: row.discordThreadId,
  messageId: row.discordMessageId,
  webhookId: row.discordWebhookId,
});

@Injectable()
export class MirrorService implements OnModuleDestroy {
  private logger = new Logger(MirrorService.name);
  private pairs: PairState[] = [];
  private realmOrigin = '';
  private teamMembers = new Map<number, string>();
  private members = new Map<string, TeamMemberMaps>();
  private memberCheckedAt = new Map<string, number>();
  private identities = new Map<string, { identity: Identity; expiresAt: number }>();
  private senderNames = new Map<number, string>();
  /** Learnt from their messages, like the names; a bot is never linked with a Discord account. */
  private botSenders = new Set<number>();
  /** Read once per queue registration, so that a renamed stream is named anew. */
  private streamNames = new Map<number, string>();
  private verifiedConversations = new Set<string>();
  /** Names the mirror gave threads whose `threadUpdate` has not come back yet, oldest first. */
  private ownThreadNames = new Map<string, { name: string; at: number }[]>();
  private throttled = new Map<string, number>();
  private failedCreates = new Map<string, number>();
  private emojiCodes?: ZulipEmojiCodes;
  private emojiRetryAt = 0;
  private emotes = new Map<string, { maps: EmoteMaps; loadedAt: number; triedAt: number }>();
  /** Reaction syncs queued and not started yet, which another change to the same message need not queue again. */
  private pendingReactions = new Set<string>();
  private active = false;
  private zulipRegistered = false;
  private subscribedStreams = new Set<number>();
  private discordConnected = false;
  private channelCheck?: NodeJS.Timeout;

  constructor(
    @Inject(IZulipInterface) private zulip: IZulipInterface,
    @Inject(IDiscordMirrorInterface) private discordMirror: IDiscordMirrorInterface,
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    private zulipService: ZulipService,
  ) {}

  async init() {
    const { bot, zulip } = getConfig();
    if (bot.token === 'dev' || zulip.bot.apiKey === 'dev' || zulip.user.apiKey === 'dev') {
      this.logger.log('The Discord-Zulip mirror is off: Discord or Zulip is not configured');
      return;
    }

    this.active = true;
    this.realmOrigin = new URL(zulip.realm).origin;
    this.teamMembers = toTeamMembers(await this.database.getMirrorIdentities());
    this.pairs = (await this.database.getMirrorLinks()).map((link) => this.newPairState(toEnabledPair(link)));
    this.logger.log(`The Discord-Zulip mirror has ${plural(this.pairs.length, 'link')}`);
    this.zulipService.onMessage((message) => this.onZulipMessage(message), { withBots: true });
    this.zulipService.onMessageUpdate((update) => this.onZulipUpdate(update));
    this.zulipService.onMessagesDeleted((deletion) => this.onZulipDeletion(deletion));
    this.zulipService.onReaction((reaction) => this.onZulipReaction(reaction));
    this.zulipService.onQueueRegistered((registration) => this.onZulipQueueRegistered(registration));
    this.channelCheck = setInterval(() => void this.recheckChannels(), CHANNEL_CHECK_MS);
    this.channelCheck.unref();
  }

  isActive() {
    return this.active;
  }

  /** Resolves to whether the pair is on: it stays off while its Discord channel fails the check, which says why. */
  async enable(link: MirrorLink) {
    if (!this.active) {
      return false;
    }
    const existing = this.pairs.find(({ pair }) => pair.key === link.discordChannelId);
    if (existing) {
      return existing.status === 'ready';
    }
    const state = this.newPairState(toEnabledPair(link));
    this.pairs.push(state);
    this.verifiedConversations.clear();
    this.logger.log(`${state.pair.key}: linked with Zulip stream ${state.pair.zulipStreamId}`);
    if (this.discordConnected && this.discordMirror.isReady()) {
      await this.checkDiscordChannel(state);
      this.lostTrack(state, ['Discord', 'Zulip']);
      this.maybeCatchUp(state);
      this.resume(state);
    }
    return state.status === 'ready';
  }

  /** Nothing new is queued for the pair from now on; what is already queued finishes. */
  disable(discordChannelId: string) {
    const state = this.pairs.find(({ pair }) => pair.key === discordChannelId);
    if (!state) {
      return;
    }
    this.pairs = this.pairs.filter((other) => other !== state);
    state.queue.close();
    clearTimeout(state.retryTimer);
    clearTimeout(state.resumeTimer);
    this.abandonBackfills(state, 'unlinked');
    this.verifiedConversations.clear();
    this.logger.log(`${state.pair.key}: unlinked from Zulip stream ${state.pair.zulipStreamId}`);
  }

  async refreshIdentities() {
    if (!this.active) {
      return;
    }
    this.teamMembers = toTeamMembers(await this.database.getMirrorIdentities());
    this.members.clear();
    this.memberCheckedAt.clear();
    this.identities.clear();
    const guildIds = new Set(this.pairs.flatMap(({ guildId }) => (guildId ? [guildId] : [])));
    for (const guildId of guildIds) {
      await this.verifyTeamMembers(guildId);
    }
  }

  /**
   * Copies the Discord messages of one location that have no copy yet, oldest first, up to the newest one now, a
   * message per queue op. `acknowledge` is called before anything is copied: live creates for the location already
   * wait, and one that throws calls the backfill off.
   */
  async backfill(
    target: BackfillTarget,
    acknowledge: (plan: BackfillPlan) => Promise<void>,
  ): Promise<{ refused: BackfillRefusal } | { done: Promise<BackfillOutcome> }> {
    if (!this.active) {
      return { refused: 'off' };
    }
    const found = await this.backfillLocation(target);
    if ('refused' in found) {
      return found;
    }
    const { state, threadId, topic } = found;
    const { pair } = state;
    const location = threadId ?? pair.discordChannelId;
    if (!this.discordReady(state) || !this.zulip.isInitialised()) {
      return { refused: 'not-ready' };
    }
    if (state.backfills.has(location)) {
      return { refused: 'running' };
    }

    let resolve: (outcome: BackfillOutcome) => void = () => {};
    const done = new Promise<BackfillOutcome>((settle) => (resolve = settle));
    const backfill: Backfill = {
      location,
      threadId,
      until: snowflakeAt(Date.now()),
      after: BigInt(location) - 1n,
      more: true,
      page: [],
      reacted: new Set(),
      copied: 0,
      failed: 0,
      noticed: false,
      held: [],
      finished: false,
      resolve,
    };
    state.backfills.set(location, backfill);
    try {
      await acknowledge({
        kind: pair.kind,
        discordChannelId: pair.discordChannelId,
        threadId,
        zulipStreamId: pair.zulipStreamId,
        stream: await this.streamName(pair.zulipStreamId),
        topic,
      });
    } catch (error) {
      state.backfills.delete(location);
      state.queue.pushNext(backfill.held);
      throw error;
    }
    this.logger.log(`${pair.key}: backfilling Discord channel ${location} up to message ${backfill.until}`);
    this.nextBackfillStep(state, backfill);
    return { done };
  }

  private async backfillLocation(
    target: BackfillTarget,
  ): Promise<{ refused: BackfillRefusal } | { state: PairState; threadId: string | null; topic?: string }> {
    if ('zulipStreamId' in target) {
      const state = this.pairs.find(({ pair }) => pair.zulipStreamId === target.zulipStreamId);
      if (!state) {
        return { refused: 'not-linked' };
      }
      const key = topicKey(this.fromZulipTopic(target.topic));
      if (isMainTopic(state.pair, key)) {
        return { state, threadId: null, topic: state.pair.mainTopic! };
      }
      const conversation = await this.database.getMirrorConversationByZulipTopic(state.pair.zulipStreamId, key);
      return conversation?.discordThreadId
        ? { state, threadId: conversation.discordThreadId, topic: conversation.zulipTopic }
        : { refused: 'no-conversation' };
    }
    const state = this.pairs.find(({ pair }) => pair.discordChannelId === target.discordChannelId);
    if (!state || (target.threadId === null && state.pair.mainTopic === null)) {
      return { refused: 'not-linked' };
    }
    if (target.threadId === null) {
      return { state, threadId: null, topic: state.pair.mainTopic! };
    }
    const conversation = await this.database.getMirrorConversationByDiscord(
      state.pair.discordChannelId,
      target.threadId,
    );
    return { state, threadId: target.threadId, topic: conversation?.zulipTopic };
  }

  private newPairState(pair: EnabledPair): PairState {
    return {
      pair,
      queue: new SerialQueue(pair.key, this.logger),
      status: 'pending',
      announced: false,
      webhookFound: false,
      catchUpQueued: false,
      caughtUp: false,
      generation: 0,
      turnedAway: noneTurnedAway(),
      retryDelayMs: CATCH_UP_RETRY_MS,
      held: { Discord: [], Zulip: [] },
      unheard: { Discord: false, Zulip: false },
      backfills: new Map(),
    };
  }

  async onDiscordReady() {
    this.discordConnected = true;
    for (const state of this.pairs) {
      this.lostTrack(state, ['Discord']);
    }
    for (const state of this.pairs) {
      await this.checkDiscordChannel(state);
      this.maybeCatchUp(state);
      this.resume(state);
    }
  }

  /**
   * Discord does not replay what a new session missed, and can deliver new messages before `shardReady` says the
   * session is ready, so nothing is created live from the moment the connection drops until catch-up has run.
   */
  onDiscordDisconnected() {
    this.discordConnected = false;
    for (const state of this.pairs) {
      this.lostTrack(state, ['Discord']);
    }
  }

  onDiscordResumed() {
    this.discordConnected = true;
    for (const state of this.pairs) {
      this.maybeCatchUp(state);
      this.resume(state);
    }
  }

  isOwnWebhook(webhookId: string) {
    return this.discordMirror.isOwnMirrorWebhook(webhookId);
  }

  handlesChannel(channelId: string) {
    return this.byChannel(channelId) !== undefined;
  }

  onDiscordMessage(dto: DiscordSourceMessage) {
    const state = this.byChannel(dto.channelId);
    state?.queue.push(`Discord message ${dto.id}`, async () => {
      await this.mirrorDiscordMessage(state, dto);
    });
  }

  onDiscordMessageEdited(dto: DiscordSourceMessage) {
    const state = this.byChannel(dto.channelId);
    state?.queue.push(`edit of Discord message ${dto.id}`, () => this.editFromDiscord(state, dto));
  }

  onDiscordMessagesDeleted(channelId: string, messageIds: string[]) {
    const state = this.byChannel(channelId);
    if (state && messageIds.length > 0) {
      state.queue.push(`deletion of Discord messages ${messageIds.join(', ')}`, () =>
        this.deleteFromDiscord(state, messageIds),
      );
    }
  }

  /** Discord's reactions are read afresh, so any change to them is the same sync, and one queued covers the next. */
  onDiscordReactionsChanged(channelId: string, messageId: string) {
    const state = this.byChannel(channelId);
    if (state) {
      this.queueReactionSync(state, `reactions of Discord message ${messageId}`, () =>
        this.reactionsToZulip(state, messageId),
      );
    }
  }

  onDiscordThreadRenamed(thread: { channelId: string; threadId: string; name: string }) {
    const state = this.byChannel(thread.channelId);
    state?.queue.push(`rename of Discord thread ${thread.threadId}`, () => this.renameFromDiscord(state, thread));
  }

  onDiscordThreadTagsChanged(thread: { channelId: string; threadId: string; tags: string[] }) {
    const state = this.byChannel(thread.channelId);
    state?.queue.push(`tags of Discord thread ${thread.threadId}`, () => this.tagsFromDiscord(state, thread));
  }

  onDiscordThreadDeleted(thread: { channelId: string; threadId: string }) {
    const state = this.byChannel(thread.channelId);
    state?.queue.push(`deletion of Discord thread ${thread.threadId}`, () =>
      this.threadDeleted(state, thread.threadId),
    );
  }

  async whenIdle() {
    await Promise.all(this.pairs.map(({ queue }) => queue.whenIdle()));
  }

  async onModuleDestroy() {
    clearInterval(this.channelCheck);
    for (const state of this.pairs) {
      state.queue.close();
      clearTimeout(state.retryTimer);
      clearTimeout(state.resumeTimer);
      this.abandonBackfills(state, 'shutdown');
    }
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
    });
    await Promise.race([this.whenIdle(), grace]);
    clearTimeout(timer);
  }

  private byChannel(channelId: string) {
    return this.pairs.find(({ pair, status }) => pair.discordChannelId === channelId && status !== 'disabled');
  }

  private byStream(streamId: number | undefined) {
    return this.pairs.find(({ pair, status }) => pair.zulipStreamId === streamId && status !== 'disabled');
  }

  /** Events and `GET /messages` name the empty topic by the realm's display name; the mirror keeps it as `''`. */
  private fromZulipTopic(topic: string) {
    return topic === (this.zulipService.emptyTopicName ?? EMPTY_TOPIC_NAME) ? '' : topic;
  }

  private onZulipMessage(received: ZulipReceivedMessage) {
    const state = received.type === 'stream' ? this.byStream(received.streamId) : undefined;
    if (state && isMirroredSender(received) && !this.isCommand(received.content)) {
      const message = { ...received, topic: this.fromZulipTopic(received.topic) };
      state.queue.push(`Zulip message ${message.id}`, () => this.mirrorZulipMessage(state, message));
    }
  }

  private onZulipUpdate(received: ZulipMessageUpdated) {
    const state = this.byStream(received.streamId);
    if (!state) {
      return;
    }
    const update =
      received.topic === undefined ? received : { ...received, topic: this.fromZulipTopic(received.topic) };
    const { content, messageId } = update;
    if (content !== undefined) {
      state.queue.push(`edit of Zulip message ${messageId}`, () =>
        this.editFromZulip(state, messageId, content, 1, update.origContent),
      );
    }
    if (update.topic !== undefined || update.newStreamId !== undefined) {
      state.queue.push(`move of Zulip message ${messageId}`, () => this.moveFromZulip(state, update));
    }
  }

  private onZulipDeletion({ messageIds, streamId }: ZulipMessagesDeleted) {
    if (messageIds.length === 0 || streamId === undefined) {
      return;
    }
    const label = `deletion of Zulip messages ${messageIds.join(', ')}`;
    const state = this.byStream(streamId);
    if (state) {
      state.queue.push(label, () => this.deleteFromZulip(state, messageIds));
      return;
    }
    for (const other of this.pairs.filter(({ status }) => status !== 'disabled')) {
      other.queue.push(label, () => this.deleteMovedFromZulip(other, messageIds));
    }
  }

  /** A reaction event names no stream, so each pair looks for the message among its own. */
  private onZulipReaction({ messageId }: ZulipReactionChanged) {
    for (const state of this.pairs.filter(({ status }) => status !== 'disabled')) {
      this.queueReactionSync(state, `reactions of Zulip message ${messageId}`, () =>
        this.reactionsToDiscord(state, messageId),
      );
    }
  }

  private queueReactionSync(state: PairState, label: string, run: () => Promise<void>) {
    const key = `${state.pair.key}:${label}`;
    if (this.pendingReactions.has(key)) {
      return;
    }
    this.pendingReactions.add(key);
    state.queue.push(label, () => {
      this.pendingReactions.delete(key);
      return run();
    });
  }

  private onZulipQueueRegistered({ subscribedStreamIds }: { subscribedStreamIds: number[] }) {
    const subscribed = new Set(subscribedStreamIds);
    this.subscribedStreams = subscribed;
    for (const { pair, status } of this.pairs) {
      if (status !== 'disabled' && !subscribed.has(pair.zulipStreamId)) {
        this.logger.warn(
          `${pair.key}: the Zulip bot is not subscribed to stream ${pair.zulipStreamId}, so nothing posted there is mirrored until an admin subscribes it`,
        );
      }
    }
    this.verifiedConversations.clear();
    this.streamNames.clear();
    this.zulipRegistered = true;
    for (const state of this.pairs) {
      this.lostTrack(state, ['Zulip']);
      this.maybeCatchUp(state);
      this.resume(state);
    }
  }

  private isCommand(content: string) {
    return parseCommand(content, this.zulipService.ownUser?.fullName ?? '').status !== 'ignored';
  }

  /**
   * A webhook posts whatever the bot's permissions, so the pair goes off as soon as the bot loses the channel. Only
   * `setUp` turns a pair on, which a pair already on skips: it would recreate a deleted webhook outside the hourly limit.
   */
  private async inspectDiscordChannel(state: PairState, setUp: boolean) {
    const { pair } = state;
    const channel = await this.discordMirror.getMirrorChannel(pair.discordChannelId);
    const problem = channelProblem(pair, channel);
    if (!channel || problem) {
      this.turnOff(
        state,
        'error',
        `${pair.key}: Discord channel ${pair.discordChannelId} ${problem}, so the pair is off`,
      );
      return;
    }

    const missing = channel.missingPermissions;
    const missingMessage = `${pair.key}: the bot is missing ${missing.join(', ')} in Discord channel ${pair.discordChannelId}`;
    if (missing.includes('ViewChannel') || missing.includes('ManageWebhooks')) {
      this.turnOff(state, 'warn', `${missingMessage}, so the pair is off`);
      return;
    }
    if (missing.length > 0 && state.missingWarned !== missingMessage) {
      this.logger.warn(missingMessage);
    }
    state.missingWarned = missing.length > 0 ? missingMessage : undefined;
    if (!setUp) {
      return;
    }

    state.guildId = channel.guildId;
    state.channelName = channel.name;
    try {
      await this.discordMirror.ensureMirrorWebhook(pair.discordChannelId);
      state.webhookFound = true;
    } catch (error) {
      this.fail(`${pair.key}: could not set up the mirror webhook in Discord channel ${pair.discordChannelId}`, error);
    }
    await this.verifyTeamMembers(channel.guildId);

    if (state.status === 'disabled') {
      this.logger.log(`${pair.key}: Discord channel ${pair.discordChannelId} can be mirrored again, so the pair is on`);
    }
    state.status = 'ready';
    state.offReason = undefined;
    if (!state.announced) {
      state.announced = true;
      const topic = pair.mainTopic === null ? '' : ` (main topic "${pair.mainTopic}")`;
      this.logger.log(
        `${pair.key}: mirroring Discord channel ${pair.discordChannelId} with Zulip stream ${pair.zulipStreamId}${topic}`,
      );
    }
  }

  private async checkDiscordChannel(state: PairState, setUp = true) {
    try {
      await this.inspectDiscordChannel(state, setUp);
    } catch (error) {
      const failed = `${state.pair.key}: could not check Discord channel ${state.pair.discordChannelId}`;
      if (isMirrorError(error, 'forbidden')) {
        this.turnOff(state, 'error', `${failed}: ${describe(error)}, so the pair is off`);
      } else {
        this.fail(failed, error);
      }
    }
  }

  private turnOff(state: PairState, level: 'warn' | 'error', reason: string) {
    if (state.status !== 'disabled' || state.offReason !== reason) {
      this.logger[level](reason);
    }
    if (state.status !== 'disabled') {
      this.lostTrack(state, ['Discord', 'Zulip']);
    }
    state.status = 'disabled';
    state.offReason = reason;
  }

  /** Who can see a channel, where it sits and what the bot may do there can all change within a gateway session. */
  private async recheckChannels() {
    if (!this.discordMirror.isReady()) {
      return;
    }
    for (const state of this.pairs) {
      if (state.status === 'ready') {
        await this.checkDiscordChannel(state, false);
        continue;
      }
      await this.checkDiscordChannel(state);
      if (this.discordReady(state)) {
        this.lostTrack(state, ['Discord', 'Zulip']);
        this.maybeCatchUp(state);
        this.resume(state);
      }
    }
  }

  private maybeCatchUp(state: PairState) {
    if (state.catchUpQueued || !this.zulipRegistered || !this.discordReady(state)) {
      return;
    }
    state.catchUpQueued = true;
    state.queue.push('catch-up', () => this.catchUp(state));
  }

  /** `unheard` are the sides whose edits and deletions may have gone without an event, which the next recheck reads. */
  private lostTrack(state: PairState, unheard: Side[] = []) {
    state.caughtUp = false;
    state.generation++;
    for (const side of unheard) {
      state.unheard[side] = true;
    }
  }

  private retryCatchUp(state: PairState) {
    if (state.retryTimer || !this.pairs.includes(state)) {
      return;
    }
    const delay = state.retryDelayMs;
    state.retryDelayMs = Math.min(delay * 2, MAX_CATCH_UP_RETRY_MS);
    this.logger.log(`${state.pair.key}: catching up again in ${delay / 1000} seconds`);
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      this.maybeCatchUp(state);
      if (!state.catchUpQueued && state.status === 'ready' && this.zulipRegistered) {
        this.retryCatchUp(state);
      }
    }, delay);
  }

  private async catchUp(state: PairState) {
    state.catchUpQueued = false;
    const { pair } = state;
    const generation = state.generation;
    const turnedAway = state.turnedAway;
    state.turnedAway = noneTurnedAway();
    try {
      const since = Math.max(Date.now() - Constants.Mirror.CatchUpMaxAgeHours * HOUR, pair.linkedAt);
      const discord = await this.missedOnDiscord(state, since, turnedAway.discord);
      const zulip = await this.missedOnZulip(state, since, turnedAway.zulip);
      if (state.generation !== generation) {
        this.turnAway(state, turnedAway);
        return;
      }
      const read = discord.complete && zulip.complete;
      if (!read) {
        this.forgiveFailedCreates();
      }
      // Only an op the queue's watchdog gave up on can meet creates turned away while it read.
      const complete = read && isEmpty(state.turnedAway);
      this.queueMissed(state, generation, discord.messages, zulip.messages, since, complete);
      if (complete) {
        state.queue.push('recheck of recent messages', () => this.recheck(state, generation));
      } else {
        this.turnAway(state, turnedAway);
        this.retryCatchUp(state);
      }
    } catch (error) {
      this.turnAway(state, turnedAway);
      this.fail(`${pair.key}: catch-up failed`, error);
      this.retryCatchUp(state);
    }
  }

  private queueMissed(
    state: PairState,
    generation: number,
    discord: DiscordSourceMessage[],
    zulip: ZulipReceivedMessage[],
    since: number,
    complete: boolean,
  ) {
    const { pair } = state;
    const recentDiscord = discord.filter(({ createdTimestamp }) => createdTimestamp >= since);
    const recentZulip = zulip.filter(({ timestamp }) => timestamp * 1000 >= since);
    const skipped = discord.length - recentDiscord.length + zulip.length - recentZulip.length;
    if (skipped > 0) {
      this.logger.log(
        `${pair.key}: catch-up skipped ${plural(skipped, 'message')} older than ${Constants.Mirror.CatchUpMaxAgeHours} hours or than the link`,
      );
    }
    if (recentDiscord.length + recentZulip.length > 0) {
      this.logger.log(
        `${pair.key}: catching up ${plural(recentDiscord.length, 'Discord message')} and ${plural(recentZulip.length, 'Zulip message')}`,
      );
    }
    state.caughtUp = complete && this.discordConnected;
    state.queue.pushNext([
      ...recentDiscord.map((dto) => ({
        label: `Discord message ${dto.id}`,
        run: async () => {
          await this.mirrorDiscordMessage(state, dto, generation);
        },
      })),
      ...recentZulip.map((message) => ({
        label: `Zulip message ${message.id}`,
        run: () => this.mirrorZulipMessage(state, message, generation),
      })),
    ]);
  }

  /**
   * The high-water marks count Discord-origin rows only: a webhook copy posted while a Discord message was missed
   * must not hide it.
   */
  private async missedOnDiscord(
    state: PairState,
    since: number,
    turnedAway: Map<string, bigint>,
  ): Promise<Missed<DiscordSourceMessage>> {
    const { pair } = state;
    const locations = new Map<string, { after: bigint; thread?: MirrorConversation }>();
    const read = (channelId: string, after: bigint, thread?: MirrorConversation) => {
      const known = locations.get(channelId);
      locations.set(channelId, {
        after: known && known.after < after ? known.after : after,
        thread: known?.thread ?? thread,
      });
    };
    const mainHighWater =
      pair.kind === 'text' ? await this.database.getMirrorDiscordHighWater(pair.discordChannelId, null) : undefined;
    if (mainHighWater !== undefined) {
      read(pair.discordChannelId, BigInt(mainHighWater));
    }
    const active = new Date(Date.now() - ACTIVE_THREAD_DAYS * DAY);
    for (const thread of await this.database.getActiveMirrorThreads(
      pair.discordChannelId,
      active,
      ACTIVE_THREAD_LIMIT,
    )) {
      const threadId = thread.discordThreadId!;
      const highWater = await this.database.getMirrorDiscordHighWater(pair.discordChannelId, threadId);
      read(threadId, BigInt(highWater ?? threadId), thread);
    }
    for (const [channelId, first] of turnedAway) {
      const thread =
        channelId === pair.discordChannelId || locations.has(channelId)
          ? undefined
          : await this.database.getMirrorConversationByDiscord(pair.discordChannelId, channelId);
      read(channelId, first - 1n, thread);
    }

    let complete = true;
    try {
      for (const threadId of await this.newThreads(state, since, locations)) {
        read(threadId, BigInt(threadId) - 1n);
      }
    } catch (error) {
      complete = !isTransient(error);
      this.fail(`${pair.key}: catch-up could not list the threads of Discord channel ${pair.discordChannelId}`, error);
    }

    const windowStart = snowflakeAt(since);
    const missed: DiscordSourceMessage[] = [];
    for (const [channelId, { after: highWater, thread }] of locations) {
      const stop = highWater > windowStart ? highWater : windowStart;
      try {
        const found: DiscordSourceMessage[] = [];
        for (let page = 1, before: string | undefined; ; page++) {
          const { messages, oldestId, full } = await this.discordMirror.fetchMirrorMessagesBefore(
            channelId,
            before,
            CATCH_UP_PAGE,
          );
          found.unshift(...messages.filter(({ id }) => BigInt(id) > highWater));
          if (!full || oldestId === null || BigInt(oldestId) <= stop) {
            break;
          }
          if (page === CATCH_UP_PAGES) {
            this.logger.warn(
              `${pair.key}: catch-up stopped after reading ${CATCH_UP_PAGES * CATCH_UP_PAGE} messages of Discord channel ${channelId}; older missed messages are not mirrored`,
            );
            break;
          }
          before = oldestId;
        }
        missed.push(...found);
      } catch (error) {
        if (channelId !== pair.discordChannelId && isMirrorError(error, 'unknown-channel')) {
          if (thread) {
            await this.detach(state, thread, 'the Discord thread no longer exists');
          }
        } else {
          complete &&= !isTransient(error);
          this.fail(`${pair.key}: catch-up could not read Discord channel ${channelId}`, error);
        }
      }
    }
    return { messages: missed, complete };
  }

  /** Threads made within the window that have no conversation: the mirror never saw them start. */
  private async newThreads(state: PairState, since: number, known: Map<string, unknown>) {
    const { pair } = state;
    const fresh = (await this.discordMirror.listMirrorThreads(pair.discordChannelId))
      .filter(({ id, createdTimestamp }) => createdTimestamp >= since && !known.has(id))
      .toSorted((a, b) => b.createdTimestamp - a.createdTimestamp);
    const unseen: string[] = [];
    for (const { id } of fresh) {
      if (!(await this.database.getMirrorConversationByDiscord(pair.discordChannelId, id))) {
        unseen.push(id);
      }
    }
    if (unseen.length > NEW_THREAD_LIMIT) {
      this.logger.warn(
        `${pair.key}: catch-up found ${unseen.length} new Discord threads and reads the newest ${NEW_THREAD_LIMIT}; the messages of the others (${unseen.slice(NEW_THREAD_LIMIT).join(', ')}) are not mirrored`,
      );
    }
    return unseen.slice(0, NEW_THREAD_LIMIT);
  }

  /**
   * The bot's own posts are left out by the server, so they never use up the pages. Moved messages are left out too,
   * unless they were turned away here: they may have come from outside the mirror, which is never mirrored
   * retroactively.
   */
  private async missedOnZulip(
    state: PairState,
    since: number,
    turnedAway: Set<number>,
  ): Promise<Missed<ZulipReceivedMessage>> {
    const { pair } = state;
    const known = await this.database.getMirrorZulipHighWater(pair.zulipStreamId);
    const below = turnedAway.size > 0 ? Math.min(...turnedAway) - 1 : undefined;
    const highWater = below === undefined || (known !== undefined && known < below) ? known : below;
    if (highWater === undefined) {
      return { messages: [], complete: true };
    }
    const self = this.zulipService.ownUser?.userId;
    const found: ZulipReceivedMessage[] = [];
    try {
      for (let page = 1, before: number | undefined; ; page++) {
        const messages = await this.retryZulip(() =>
          this.zulip.getStreamMessagesBefore({
            stream: pair.zulipStreamId,
            before,
            count: CATCH_UP_PAGE,
            excludeSenderId: self,
          }),
        );
        found.unshift(...messages.filter(({ id }) => id > highWater));
        const [oldest] = messages;
        if (messages.length < CATCH_UP_PAGE || oldest.id <= highWater || oldest.timestamp * 1000 < since) {
          break;
        }
        if (page === CATCH_UP_PAGES) {
          this.logger.warn(
            `${pair.key}: catch-up stopped after reading ${CATCH_UP_PAGES * CATCH_UP_PAGE} messages of Zulip stream ${pair.zulipStreamId}; older missed messages are not mirrored`,
          );
          break;
        }
        before = oldest.id;
      }
    } catch (error) {
      this.fail(`${pair.key}: catch-up could not read Zulip stream ${pair.zulipStreamId}`, error);
      return { messages: [], complete: !isTransient(error) };
    }
    const messages = found
      .map((message) => ({ ...message, topic: this.fromZulipTopic(message.topic) }))
      .filter(
        (message) =>
          message.type === 'stream' &&
          message.streamId === pair.zulipStreamId &&
          message.senderId !== self &&
          isMirroredSender(message) &&
          !this.isCommand(message.content) &&
          (message.movedAt === undefined || turnedAway.has(message.id)),
      );
    return { messages, complete: true };
  }

  /**
   * Edits and deletions made while the bot was away bring no event, so after a complete catch-up both sides of the
   * newest recent rows are read again and whatever changed goes through the live edit and deletion paths.
   */
  private async recheck(state: PairState, generation: number) {
    const { pair } = state;
    if (generation !== state.generation) {
      return;
    }
    const unheard = state.unheard;
    state.unheard = { Discord: false, Zulip: false };
    if (!unheard.Discord && !unheard.Zulip) {
      return;
    }
    const since = Math.max(Date.now() - Constants.Mirror.RecheckMaxAgeHours * HOUR, pair.linkedAt);
    const rows = await this.database.getRecentMirrorMessages(pair.discordChannelId, new Date(since), RECHECK_LIMIT);
    if (rows.length === RECHECK_LIMIT) {
      this.logger.log(
        `${pair.key}: rechecking the newest ${RECHECK_LIMIT} mirrored messages; edits and deletions of older ones made while the bot was away are not mirrored`,
      );
    }
    const ops = [
      ...(unheard.Discord
        ? await this.recheckOnDiscord(
            state,
            rows.filter(({ origin }) => origin === 'discord'),
          )
        : []),
      ...(unheard.Zulip
        ? await this.recheckOnZulip(
            state,
            rows.filter(({ origin }) => origin === 'zulip'),
          )
        : []),
    ];
    // What was read may be out of date by now; the catch-up that follows reads again.
    if (generation !== state.generation) {
      state.unheard.Discord ||= unheard.Discord;
      state.unheard.Zulip ||= unheard.Zulip;
      return;
    }
    if (ops.length > 0) {
      this.logger.log(`${pair.key}: mirroring ${plural(ops.length, 'change')} made while the bot was away`);
    }
    state.queue.pushNext(ops);
  }

  /**
   * Reads each location back to its oldest recent row; a row the pages do not reach is left alone, and so is every row
   * of a location that shows no message at all, which is likelier lost access than everything deleted.
   */
  private async recheckOnDiscord(state: PairState, rows: MirrorMessage[]) {
    const { pair } = state;
    const byLocation = new Map<string, MirrorMessage[]>();
    for (const row of rows) {
      const location = row.discordThreadId ?? row.discordChannelId;
      byLocation.set(location, [...(byLocation.get(location) ?? []), row]);
    }
    const ops: Op[] = [];
    for (const [location, located] of byLocation) {
      const oldest = located.reduce((min, { discordMessageId }) => {
        const id = BigInt(discordMessageId);
        return id < min ? id : min;
      }, BigInt(located[0].discordMessageId));
      const found = new Map<string, DiscordSourceMessage>();
      let reached: bigint;
      try {
        for (let page = 1, before: string | undefined; ; page++) {
          const { messages, oldestId, full } = await this.discordMirror.fetchMirrorMessagesBefore(
            location,
            before,
            CATCH_UP_PAGE,
          );
          for (const message of messages) {
            found.set(message.id, message);
          }
          reached = full && oldestId !== null ? BigInt(oldestId) : 0n;
          if (reached <= oldest || page === CATCH_UP_PAGES) {
            break;
          }
          before = oldestId!;
        }
      } catch (error) {
        if (!isMirrorError(error, 'unknown-channel')) {
          this.fail(`${pair.key}: could not recheck Discord channel ${location}`, error);
        }
        continue;
      }
      if (found.size === 0) {
        continue;
      }
      for (const row of located) {
        const dto = found.get(row.discordMessageId);
        if (!dto && BigInt(row.discordMessageId) >= reached) {
          ops.push({
            label: `deletion of Discord messages ${row.discordMessageId}`,
            run: () => this.deleteFromDiscord(state, [row.discordMessageId]),
          });
        } else if (dto && discordSourceHash(dto) !== row.sourceHash) {
          ops.push({ label: `edit of Discord message ${dto.id}`, run: () => this.editFromDiscord(state, dto) });
        }
      }
    }
    return ops;
  }

  /** Like Discord, a stream that shows none of the messages is left alone. */
  private async recheckOnZulip(state: PairState, rows: MirrorMessage[]) {
    const { pair } = state;
    const hashes = new Map(rows.map(({ zulipMessageId, sourceHash }) => [zulipMessageId, sourceHash]));
    const ids = [...hashes.keys()].toSorted((a, b) => a - b);
    if (ids.length === 0 || !this.subscribedStreams.has(pair.zulipStreamId)) {
      return [];
    }
    const found = new Map<number, ZulipReceivedMessage>();
    try {
      for (let start = 0; start < ids.length; start += ZULIP_ID_BATCH) {
        const batch = ids.slice(start, start + ZULIP_ID_BATCH);
        for (const message of await this.retryZulip(() => this.zulip.getMessagesByIds(batch))) {
          found.set(message.id, message);
        }
      }
    } catch (error) {
      this.fail(`${pair.key}: could not recheck Zulip stream ${pair.zulipStreamId}`, error);
      return [];
    }
    const ops: Op[] = [];
    // An unreadable message counts as deleted, as it does live: Zulip sends a delete_message event to a user who
    // loses access to a moved message.
    const gone = ids.filter((id) => !found.has(id));
    if (found.size === 0) {
      return [];
    }
    if (gone.length > 0) {
      ops.push({
        label: `deletion of Zulip messages ${gone.join(', ')}`,
        run: () => this.deleteFromZulip(state, gone),
      });
    }
    for (const [id, message] of found) {
      if (sha256(message.content) !== hashes.get(id)) {
        ops.push({ label: `edit of Zulip message ${id}`, run: () => this.editFromZulip(state, id, message.content) });
      }
    }
    return ops;
  }

  private discordReady(state: PairState) {
    return state.status === 'ready' && this.discordMirror.isReady();
  }

  private sideReady(state: PairState, side: Side) {
    return side === 'Discord' ? this.discordReady(state) : this.zulip.isInitialised();
  }

  private holdFor(state: PairState, side: Side, label: string, run: () => Promise<void>) {
    if (state.held[side].length === 0 && this.sideReady(state, side)) {
      return false;
    }
    if (!this.sideReady(state, side) && this.throttle(`held:${state.pair.key}:${side}`, THROTTLE_MS)) {
      this.logger.warn(`${state.pair.key}: ${side} is not ready, so edits, deletions and renames wait until it is`);
    }
    this.hold(state, side, label, run);
    return true;
  }

  private hold(state: PairState, side: Side, label: string, run: () => Promise<void>) {
    state.held[side].push({ label, run });
    this.resumeLater(state);
  }

  /** Edits and deletions can be sent again safely, so one Discord failed for now waits its turn to be tried again. */
  private retryOnDiscord(state: PairState, label: string, attempt: number, run: (attempt: number) => Promise<void>) {
    if (this.throttle(`retry:${state.pair.key}`, THROTTLE_MS)) {
      this.logger.warn(`${state.pair.key}: Discord failed an edit or deletion for now, so it is tried again soon`);
    }
    this.hold(state, 'Discord', label, () => run(attempt + 1));
  }

  private resumeLater(state: PairState) {
    state.resumeTimer ??= setTimeout(() => {
      state.resumeTimer = undefined;
      this.resume(state);
    }, RESUME_MS);
  }

  /** The op waits behind the queue, so whatever is held meanwhile lines up behind the older changes and goes with them. */
  private resume(state: PairState) {
    for (const side of ['Discord', 'Zulip'] as const) {
      if (state.held[side].length === 0) {
        continue;
      }
      state.queue.push(`changes held for ${side}`, async () => {
        if (state.status === 'disabled') {
          state.held[side] = [];
        } else if (this.sideReady(state, side)) {
          state.queue.pushNext(state.held[side].splice(0));
        } else {
          this.resumeLater(state);
        }
      });
    }
  }

  private notReady(state: PairState, side: Side) {
    if (this.throttle(`not-ready:${state.pair.key}`, THROTTLE_MS)) {
      this.logger.warn(
        `${state.pair.key}: not mirroring yet: ${side} is not ready; catch-up picks it up once both sides are`,
      );
    }
  }

  private turnAway(state: PairState, { discord, zulip }: TurnedAway) {
    for (const [location, id] of discord) {
      const first = state.turnedAway.discord.get(location);
      if (first === undefined || id < first) {
        state.turnedAway.discord.set(location, id);
      }
    }
    for (const id of zulip) {
      state.turnedAway.zulip.add(id);
    }
  }

  /**
   * `generation` is set for the creates a catch-up queues, which only run while that catch-up is the current one. A
   * message that keeps failing is given up on, so that it cannot hold the pair back until it leaves the window.
   */
  private mayCreate(state: PairState, source: string, generation: number | undefined, turnAway: () => void) {
    if ((this.failedCreates.get(source) ?? 0) >= MAX_CREATE_ATTEMPTS) {
      return false;
    }
    if (generation === undefined ? state.caughtUp : generation === state.generation) {
      return true;
    }
    turnAway();
    if (generation === undefined && this.throttle(`not-ready:${state.pair.key}`, THROTTLE_MS)) {
      this.logger.warn(`${state.pair.key}: not mirroring yet: catch-up has to run first, and picks it up`);
    }
    return false;
  }

  /** A create that may have been carried out is never sent again: that could post it twice. */
  private async creating<T>(attempt: CreateAttempt, call: () => Promise<T>) {
    try {
      const result = await call();
      attempt.posted = true;
      return result;
    } catch (error) {
      attempt.uncertain ||= mayHaveBeenCarriedOut(error);
      throw error;
    }
  }

  private created(state: PairState, source: string) {
    state.retryDelayMs = CATCH_UP_RETRY_MS;
    this.failedCreates.delete(source);
  }

  /**
   * A refusal is final, and an outage is no reason to give up on a message. Anything else before the message went out,
   * such as a database failure, is tried again, but only so often.
   */
  /** Resolves to whether the create is tried again. */
  private createFailed(state: PairState, source: string, error: unknown, attempt: CreateAttempt, turnAway: () => void) {
    if (attempt.posted || attempt.uncertain) {
      this.failedCreates.set(source, MAX_CREATE_ATTEMPTS);
      return false;
    }
    if (isExpected(error) && !isTransient(error)) {
      return false;
    }
    if (!isOutage(error)) {
      const attempts = (this.failedCreates.get(source) ?? 0) + 1;
      this.failedCreates.set(source, attempts);
      if (attempts >= MAX_CREATE_ATTEMPTS) {
        this.logger.error(`${state.pair.key}: gave up on ${source} after ${attempts} attempts`);
        return false;
      }
    }
    turnAway();
    this.lostTrack(state);
    this.retryCatchUp(state);
    return true;
  }

  /** A catch-up that cannot read a side shows the failures so far were an outage, not the messages. */
  private forgiveFailedCreates() {
    for (const [source, attempts] of this.failedCreates) {
      if (attempts < MAX_CREATE_ATTEMPTS) {
        this.failedCreates.delete(source);
      }
    }
  }

  private throttle(key: string, ms: number) {
    const now = Date.now();
    const last = this.throttled.get(key);
    if (last !== undefined && now - last < ms) {
      return false;
    }
    this.throttled.set(key, now);
    return true;
  }

  private fail(message: string, error: unknown) {
    if (isExpected(error)) {
      this.logger.error(`${message}: ${describe(error)}`);
    } else {
      this.logger.error(`${message}: ${describe(error)}`, error);
    }
  }

  private async retryZulip<T>(call: () => Promise<T>): Promise<T> {
    for (const delay of RETRY_DELAYS_MS) {
      try {
        return await call();
      } catch (error) {
        if (!isTransientZulipFailure(error)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return call();
  }

  private async onDiscord<T>(state: PairState, threadId: string | null | undefined, call: () => Promise<T>) {
    let recreated = false;
    let unarchived = false;
    for (;;) {
      try {
        return await call();
      } catch (error) {
        if (!recreated && isMirrorError(error, 'unknown-webhook') && (await this.recreateWebhook(state))) {
          recreated = true;
          continue;
        }
        if (!unarchived && threadId && isMirrorError(error, 'archived')) {
          await this.discordMirror.unarchiveMirrorThread(threadId);
          unarchived = true;
          continue;
        }
        throw error;
      }
    }
  }

  private async recreateWebhook(state: PairState) {
    const recreating = state.webhookFound;
    if (recreating && state.webhookRecreatedAt !== undefined && Date.now() - state.webhookRecreatedAt < HOUR) {
      return false;
    }
    await this.discordMirror.ensureMirrorWebhook(state.pair.discordChannelId);
    state.webhookFound = true;
    if (recreating) {
      state.webhookRecreatedAt = Date.now();
    }
    return true;
  }

  private membersOf(guildId: string) {
    let maps = this.members.get(guildId);
    if (!maps) {
      maps = { discordByZulip: new Map(), zulipByDiscord: new Map() };
      this.members.set(guildId, maps);
    }
    return maps;
  }

  /** A removed role only shows when the member is checked again, so the ones a message involves are, once stale. */
  private async renderContext(dto: DiscordSourceMessage): Promise<DiscordRenderContext> {
    const involved = new Set([dto.author.id, ...Object.keys(dto.mentions.users)]);
    for (const [zulipId, discordId] of this.teamMembers) {
      const checkedAt = this.memberCheckedAt.get(`${dto.guildId}:${zulipId}`) ?? 0;
      if (involved.has(discordId) && Date.now() - checkedAt >= IDENTITY_CACHE_MS) {
        try {
          await this.verifiedMember(dto.guildId, zulipId, discordId);
        } catch (error) {
          this.fail(`Could not look up Discord user ${discordId} for Zulip user ${zulipId}`, error);
        }
      }
    }
    const text = [dto.content, ...dto.forwarded, dto.replyTo?.content ?? ''].join('\n');
    const emoteIds = [...text.matchAll(CUSTOM_EMOTE_IDS)].map(([, id]) => id);
    const emotes =
      emoteIds.length > 0
        ? (await this.emoteMaps(dto.guildId, (maps) => emoteIds.some((id) => !maps.zulipByEmoteId.has(id))))
            ?.zulipByEmoteId
        : undefined;
    const channels = new Map<string, ZulipChannel>();
    for (const [, channelId] of text.matchAll(CHANNEL_MENTION)) {
      const channel = channels.has(channelId) ? undefined : await this.zulipChannelOf(channelId);
      if (channel) {
        channels.set(channelId, channel);
      }
    }
    return {
      zulipUserByDiscordId: this.membersOf(dto.guildId).zulipByDiscord,
      ...(emotes ? { zulipEmojiByEmoteId: new Map([...emotes].map(([id, { name }]) => [id, name])) } : {}),
      ...(channels.size > 0 ? { zulipChannelByDiscordId: channels } : {}),
    };
  }

  /** The stream of a linked channel, with its main topic, or the stream and topic of a mirrored thread. */
  private async zulipChannelOf(channelId: string): Promise<ZulipChannel | undefined> {
    const linked = this.pairs.find(({ pair }) => pair.discordChannelId === channelId)?.pair;
    let found: { streamId: number; topic?: string } | undefined = linked && {
      streamId: linked.zulipStreamId,
      ...(linked.mainTopic === null ? {} : { topic: linked.mainTopic }),
    };
    for (const { pair } of found ? [] : this.pairs) {
      const conversation = await this.database.getMirrorConversationByDiscord(pair.discordChannelId, channelId);
      if (conversation) {
        found = { streamId: conversation.zulipStreamId, topic: conversation.zulipTopic };
        break;
      }
    }
    const stream = found && (await this.streamName(found.streamId));
    return found && stream !== undefined ? { ...found, stream } : undefined;
  }

  private async streamName(streamId: number) {
    const known = this.streamNames.get(streamId);
    if (known !== undefined) {
      return known;
    }
    try {
      const { name } = await this.retryZulip(() => this.zulip.getStream(streamId));
      this.streamNames.set(streamId, name);
      return name;
    } catch (error) {
      this.fail(`Could not read the name of Zulip stream ${streamId}`, error);
      return undefined;
    }
  }

  /** The Discord channel of a linked stream or its main topic, or the thread of a mirrored topic. */
  private async discordChannelOf({ stream, topic }: ZulipChannelRef) {
    let state: PairState | undefined;
    for (const candidate of this.pairs) {
      const { zulipStreamId } = candidate.pair;
      if (
        typeof stream === 'number'
          ? zulipStreamId === stream
          : (await this.streamName(zulipStreamId))?.toLowerCase() === stream.toLowerCase()
      ) {
        state = candidate;
        break;
      }
    }
    if (!state || topic === undefined) {
      return state?.pair.discordChannelId;
    }
    const key = topicKey(this.fromZulipTopic(topic));
    if (isMainTopic(state.pair, key)) {
      return state.pair.discordChannelId;
    }
    const conversation = await this.database.getMirrorConversationByZulipTopic(state.pair.zulipStreamId, key);
    return conversation?.discordThreadId ?? undefined;
  }

  private async verifyTeamMembers(guildId: string) {
    for (const [zulipId, discordId] of this.teamMembers) {
      try {
        await this.verifiedMember(guildId, zulipId, discordId);
      } catch (error) {
        this.fail(`Could not look up Discord user ${discordId} for Zulip user ${zulipId}`, error);
      }
    }
  }

  private async verifiedMember(guildId: string, zulipId: number, discordId: string) {
    const member = await this.discordMirror.getTeamMember(guildId, discordId);
    const verified: DiscordTeamMember | undefined =
      member && holdsIdentityRole(guildId, member.roleIds) ? member : undefined;
    const maps = this.membersOf(guildId);
    this.memberCheckedAt.set(`${guildId}:${zulipId}`, Date.now());
    if (verified) {
      maps.discordByZulip.set(zulipId, discordId);
      maps.zulipByDiscord.set(discordId, zulipId);
    } else {
      maps.discordByZulip.delete(zulipId);
      maps.zulipByDiscord.delete(discordId);
      if (this.throttle(`unverified:${zulipId}`, Infinity)) {
        this.logger.warn(
          `Zulip user ${zulipId} is linked to Discord user ${discordId}, who is not in the guild or holds neither the Team nor the Immich role, so the link is not used`,
        );
      }
    }
    return verified;
  }

  private async resolveIdentity(sender: { id: number; fullName: string }, guildId: string): Promise<Identity> {
    const cacheKey = `${guildId}:${sender.id}`;
    const cached = this.identities.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.identity;
    }

    if (this.botSenders.has(sender.id)) {
      return { username: sanitiseWebhookUsername(sender.fullName, ' (Zulip bot)') };
    }
    const fallback = { username: sanitiseWebhookUsername(sender.fullName, ' (Zulip)') };
    let identity: Identity = fallback;
    const discordId = this.teamMembers.get(sender.id);
    if (discordId === undefined) {
      if (this.throttle(`unmapped:${sender.id}`, Infinity)) {
        this.logger.warn(
          `Zulip user ${sender.id} has not linked a Discord account; their messages appear on Discord as "Name (Zulip)"`,
        );
      }
    } else {
      try {
        const member = await this.verifiedMember(guildId, sender.id, discordId);
        if (member) {
          identity = { username: sanitiseWebhookUsername(member.displayName), avatarUrl: member.avatarUrl };
        }
      } catch (error) {
        this.fail(`Could not look up Discord user ${discordId} for Zulip user ${sender.id}`, error);
        return fallback;
      }
    }
    this.identities.set(cacheKey, { identity, expiresAt: Date.now() + IDENTITY_CACHE_MS });
    return identity;
  }

  private async emojiTables() {
    if (this.emojiCodes || Date.now() < this.emojiRetryAt) {
      return this.emojiCodes;
    }
    try {
      this.emojiCodes = await this.zulip.getEmojiCodes();
    } catch (error) {
      this.emojiRetryAt = Date.now() + HOUR;
      this.logger.warn(
        `Could not load the Zulip emoji table, so emoji names stay as text for an hour: ${describe(error)}`,
      );
    }
    return this.emojiCodes;
  }

  /**
   * The names the emote sync gives the emotes, so that a renamed one (`fire2`) is found by the name it has on Zulip.
   * `undefined` while either side cannot be read, which a reaction sync must not take for an emote nobody uses.
   */
  /** An emote synced or uploaded since the maps were read is found by reading them again, at most once a minute. */
  private async emoteMaps(guildId: string, lacks?: (maps: EmoteMaps) => boolean): Promise<EmoteMaps | undefined> {
    const cached = this.emotes.get(guildId);
    const now = Date.now();
    if (cached && (now - cached.triedAt < MINUTE || (now - cached.loadedAt < HOUR && !lacks?.(cached.maps)))) {
      return cached.maps;
    }
    if (cached) {
      cached.triedAt = now;
    }
    // Maps that could not be read again are still better than none: they hold every emote known until then.
    const maps = await this.readEmoteMaps(guildId);
    if (!maps) {
      return cached?.maps;
    }
    this.emotes.set(guildId, { maps, loadedAt: now, triedAt: now });
    return maps;
  }

  private async readEmoteMaps(guildId: string) {
    const codes = await this.emojiTables();
    if (!codes) {
      return undefined;
    }
    try {
      const emotes = await this.discordMirror.getEmotes(guildId);
      if (!emotes) {
        return undefined;
      }
      const realm = await this.retryZulip(() => this.zulip.listEmoji());
      return toEmoteMaps(emotes, zulipBuiltInEmoji(codes), realm);
    } catch (error) {
      this.fail(`Could not match the Discord emotes of guild ${guildId} with the Zulip realm emoji`, error);
      return undefined;
    }
  }

  private async renderForDiscord(state: PairState, raw: string, lateTimestamp?: number) {
    const guildId = state.guildId!;
    const refs = parseZulipRefs(raw, this.realmOrigin);
    const messages = new Map<number, ZulipMessageRef>();
    const deleted = new Set<number>();
    for (const row of await this.database.getMirrorMessagesByZulipIds(refs.messageIds, { withDeleted: true })) {
      if (row.deletedAt !== null) {
        deleted.add(row.zulipMessageId);
        continue;
      }
      if (messages.has(row.zulipMessageId)) {
        continue;
      }
      const rowGuildId = this.pairs.find(({ pair }) => pair.discordChannelId === row.discordChannelId)?.guildId;
      const quoted = refs.quoteReply?.messageId === row.zulipMessageId ? refs.quoteReply.senderName : undefined;
      messages.set(row.zulipMessageId, {
        jumpUrl: jumpUrl(rowGuildId ?? guildId, row.discordThreadId ?? row.discordChannelId, row.discordMessageId),
        origin: row.origin,
        discordAuthorId: row.discordAuthorId,
        authorName: quoted ?? 'someone',
      });
    }

    const channels = new Map<string, string>();
    for (const ref of refs.channels) {
      const channelId = await this.discordChannelOf(ref);
      if (channelId !== undefined) {
        channels.set(channelRefKey(ref), channelId);
      }
    }

    const needsEmoji = refs.emojiNames.length > 0;
    const unicode = needsEmoji ? (await this.emojiTables())?.unicode : undefined;
    const custom = needsEmoji
      ? (
          await this.emoteMaps(guildId, (maps) =>
            refs.emojiNames.some((name) => !maps.discordByZulipName.has(name) && unicode?.[name] === undefined),
          )
        )?.discordByZulipName
      : undefined;
    return toDiscordMirrorContent(raw, {
      realmOrigin: this.realmOrigin,
      messages,
      deletedMessageIds: new Set([...deleted].filter((id) => !messages.has(id))),
      channels,
      discordUserByZulipId: this.membersOf(guildId).discordByZulip,
      emoji: (name) => {
        const emote = custom?.get(name);
        return emote ? (emote.animated ? `<${emote.identifier}>` : `<:${emote.identifier}>`) : unicode?.[name];
      },
      lateTimestamp,
    });
  }

  private async downloadUploads(
    state: PairState,
    messageId: number,
    { uploads: paths, spoilerUploads }: { uploads: string[]; spoilerUploads: string[] },
    slots = MAX_FILES,
  ) {
    const files: File[] = [];
    const notes: Note[] = [];
    let total = 0;
    const deadline = transferDeadline();
    for (const [index, path] of paths.entries()) {
      const note = { name: uploadName(path), spoiler: spoilerUploads.includes(path) };
      if (index >= slots || deadline.signal.aborted) {
        notes.push(note);
        continue;
      }
      try {
        const file = await this.zulip.downloadUpload(path, Constants.Mirror.MaxFileBytes, deadline.signal);
        if (file && total + file.size <= MAX_TOTAL_FILE_BYTES) {
          total += file.size;
          files.push(note.spoiler ? new File([file], `${SPOILER_FILE}${file.name}`, { type: file.type }) : file);
        } else {
          notes.push(note);
        }
      } catch (error) {
        notes.push(note);
        this.logger.warn(
          `${state.pair.key}: could not download upload ${index + 1} of Zulip message ${messageId}: ${describe(error)}`,
        );
      }
    }
    deadline.done();
    return { files, notes };
  }

  private async mirrorZulipMessage(state: PairState, message: ZulipReceivedMessage, generation?: number) {
    const turnAway = () => state.turnedAway.zulip.add(message.id);
    if (!this.discordReady(state)) {
      turnAway();
      this.notReady(state, 'Discord');
      return;
    }
    const source = `Zulip message ${message.id}`;
    if (!this.mayCreate(state, source, generation, turnAway)) {
      return;
    }

    const attempt: CreateAttempt = { posted: false, uncertain: false };
    try {
      if ((await this.database.getMirrorMessagesByZulipIds([message.id], { withDeleted: true })).length > 0) {
        return;
      }
      this.senderNames.set(message.senderId, message.senderFullName);
      if (isZulipBot(message)) {
        this.botSenders.add(message.senderId);
      }
      const conversation = await this.conversationForZulip(state, message);
      const late = message.timestamp > 0 && Date.now() - message.timestamp * 1000 > LATE_MS;
      const rendered = await this.renderForDiscord(state, message.content, late ? message.timestamp : undefined);
      const outgoing: OutgoingZulipMessage = {
        text: rendered.text,
        pingUserIds: rendered.pingUserIds,
        ...(await this.downloadUploads(state, message.id, rendered)),
        identity: await this.resolveIdentity(
          { id: message.senderId, fullName: message.senderFullName },
          state.guildId!,
        ),
      };
      try {
        await this.deliverToDiscord(state, message, outgoing, conversation, attempt);
      } catch (error) {
        if (!conversation?.discordThreadId || !isMirrorError(error, 'unknown-channel')) {
          throw error;
        }
        await this.database.removeMirrorConversation(conversation.id);
        this.logger.log(
          `${state.pair.key}: Discord thread ${conversation.discordThreadId} no longer exists, so its Zulip topic starts a new one`,
        );
        await this.deliverToDiscord(state, message, outgoing, undefined, attempt);
      }
      this.created(state, source);
    } catch (error) {
      this.createFailed(state, source, error, attempt, turnAway);
      await this.zulipCreateFailed(state, message, error);
    }
  }

  private async conversationForZulip(state: PairState, message: ZulipReceivedMessage) {
    const { pair } = state;
    const key = topicKey(message.topic);
    if (isMainTopic(pair, key)) {
      return this.mainConversation(state);
    }
    const known = await this.database.getMirrorConversationByZulipTopic(pair.zulipStreamId, key);
    if (known) {
      return known;
    }

    const recent = await this.retryZulip(() =>
      this.zulip.getMessages({ stream: pair.zulipStreamId, topic: message.topic, numBefore: RECOVERY_DEPTH }),
    );
    const recentIds = recent.map(({ id }) => id).filter((id) => id !== message.id);
    const rows = await this.database.getMirrorMessagesByZulipIds(recentIds);
    for (const conversationId of new Set(rows.toReversed().map((row) => row.conversationId))) {
      const conversation =
        conversationId === null ? undefined : await this.database.getMirrorConversation(conversationId);
      if (
        conversation?.discordThreadId &&
        conversation.zulipStreamId === pair.zulipStreamId &&
        (await this.isAnchoredIn(state, conversation, key, recentIds))
      ) {
        await this.database.updateMirrorConversation(conversation.id, {
          zulipTopic: message.topic,
          zulipTopicKey: key,
        });
        this.logger.log(
          `${pair.key}: found the conversation of Discord thread ${conversation.discordThreadId} again after its Zulip topic was renamed`,
        );
        return { ...conversation, zulipTopic: message.topic, zulipTopicKey: key };
      }
    }
    return undefined;
  }

  /** A conversation goes where its anchor goes: messages moved away without it never take it along. */
  private async isAnchoredIn(state: PairState, conversation: MirrorConversation, key: string, recentIds: number[]) {
    const anchor = conversation.zulipAnchorMessageId;
    if (anchor === null || recentIds.includes(anchor)) {
      return true;
    }
    try {
      const { topic, streamId } = await this.retryZulip(() => this.zulip.getMessage(anchor));
      return streamId === state.pair.zulipStreamId && topicKey(topic) === key;
    } catch (error) {
      if (isZulipMessageGone(error)) {
        return false;
      }
      throw error;
    }
  }

  private async mainConversation(state: PairState) {
    const { pair } = state;
    const zulipTopic = pair.mainTopic!;
    const zulipTopicKey = topicKey(zulipTopic);
    const existing = await this.database.getMirrorConversationByDiscord(pair.discordChannelId, null);
    if (existing?.zulipStreamId === pair.zulipStreamId && existing.zulipTopic === zulipTopic) {
      return existing;
    }
    const owner = await this.database.getMirrorConversationByZulipTopic(pair.zulipStreamId, zulipTopicKey);
    if (owner && owner.id !== existing?.id) {
      await this.detach(state, owner, 'its Zulip topic is now the main topic');
    }
    if (!existing) {
      const created = await this.database.createMirrorConversation({
        discordChannelId: pair.discordChannelId,
        discordThreadId: null,
        zulipStreamId: pair.zulipStreamId,
        zulipTopic,
        zulipTopicKey,
        zulipAnchorMessageId: null,
      });
      this.logger.log(`${pair.key}: created the main conversation of Discord channel ${pair.discordChannelId}`);
      return created;
    }
    const changes = { zulipStreamId: pair.zulipStreamId, zulipTopic, zulipTopicKey };
    await this.database.updateMirrorConversation(existing.id, changes);
    return { ...existing, ...changes };
  }

  private async createThreadConversation(state: PairState, threadId: string, zulipTopic: string, anchor: number) {
    const { pair } = state;
    const conversation = await this.database.createMirrorConversation({
      discordChannelId: pair.discordChannelId,
      discordThreadId: threadId,
      zulipStreamId: pair.zulipStreamId,
      zulipTopic,
      zulipTopicKey: topicKey(zulipTopic),
      zulipAnchorMessageId: anchor,
    });
    this.verifiedConversations.add(conversation.id);
    this.logger.log(`${pair.key}: created the conversation of Discord thread ${threadId} (Zulip anchor ${anchor})`);
    return conversation;
  }

  /** Throws only when nothing was posted; a failure after part 0 is logged. */
  private async deliverToDiscord(
    state: PairState,
    message: ZulipReceivedMessage,
    outgoing: OutgoingZulipMessage,
    conversation: MirrorConversation | undefined,
    attempt: CreateAttempt,
  ) {
    const { pair } = state;
    let files = outgoing.files;
    let parts = withNotes(outgoing.text, outgoing.notes);
    if (parts.length === 0 && files.length > 0) {
      parts = [''];
    }
    if (parts.length === 0) {
      return;
    }

    const send = (content: string, options: Partial<DiscordMirrorSend>) =>
      this.onDiscord(state, options.threadId, () =>
        this.creating(attempt, () =>
          this.discordMirror.sendMirrorMessage({
            channelId: pair.discordChannelId,
            username: outgoing.identity.username,
            avatarUrl: outgoing.identity.avatarUrl,
            content,
            pingUserIds: [],
            suppressEmbeds: suppressEmbeds(content),
            ...options,
          }),
        ),
      );
    const first: Partial<DiscordMirrorSend> = {
      threadId: conversation?.discordThreadId ?? undefined,
      threadName: conversation || pair.kind === 'text' ? undefined : toDiscordThreadName(message.topic),
      pingUserIds: outgoing.pingUserIds,
    };

    let sent: DiscordMirrorSent;
    try {
      sent = await send(parts[0], { ...first, files });
    } catch (error) {
      if (!isMirrorError(error, 'too-large') || files.length === 0) {
        throw error;
      }
      parts = withNotes(outgoing.text, [...outgoing.notes, ...files.map(toNote)]);
      files = [];
      sent = await send(parts[0], { ...first, files });
    }

    let conversationId = conversation?.id ?? null;
    let threadId = conversation ? conversation.discordThreadId : pair.kind === 'forum' ? sent.channelId : null;
    if (!conversation) {
      if (pair.kind === 'text') {
        try {
          threadId = await this.discordMirror.startMirrorThread(
            pair.discordChannelId,
            sent.messageId,
            toDiscordThreadName(message.topic),
          );
        } catch (error) {
          if (this.throttle(`thread-start:${pair.key}`, HOUR)) {
            this.logger.error(
              `${pair.key}: could not start a Discord thread for Zulip message ${message.id}: ${describe(error)}`,
            );
          }
          await this.notifyZulip(state, message.topic, 'the bot could not start a Discord thread for this topic');
        }
      }
      if (threadId !== null) {
        conversationId = (await this.createThreadConversation(state, threadId, message.topic, message.id)).id;
      }
    }

    const source = {
      conversationId,
      zulipMessageId: message.id,
      zulipSenderId: message.senderId,
      sourceHash: sha256(message.content),
    };
    await this.database.createMirrorMessages([zulipOriginRow(pair, source, sent, 0)]);
    if (conversation?.discordThreadId && conversation.zulipAnchorMessageId === null) {
      await this.database.updateMirrorConversation(conversation.id, { zulipAnchorMessageId: message.id });
    }

    for (let part = 1; part < parts.length; part++) {
      try {
        const posted = await send(parts[part], { threadId: threadId ?? undefined });
        await this.database.createMirrorMessages([zulipOriginRow(pair, source, posted, part)]);
      } catch (error) {
        this.fail(`${pair.key}: could not mirror part ${part + 1} of Zulip message ${message.id} to Discord`, error);
        return;
      }
    }
  }

  private async zulipCreateFailed(state: PairState, message: ZulipReceivedMessage, error: unknown) {
    const { pair } = state;
    const failed = `${pair.key}: could not mirror Zulip message ${message.id} to Discord`;
    if (!(error instanceof DiscordMirrorError)) {
      this.fail(failed, error);
      return;
    }

    if (error.kind === 'locked') {
      this.logger.warn(`${failed}: the Discord thread is locked`);
    } else if (error.kind === 'unknown-webhook') {
      this.logger.error(
        `${pair.key}: the Zulip mirror webhook in #${state.channelName} (${pair.discordChannelId}) was deleted again; deny the bot Manage Webhooks there to stop the mirror, or wait an hour`,
      );
    } else if (
      (error.kind !== 'forbidden' && error.kind !== 'max-webhooks') ||
      this.throttle(`webhook-failure:${pair.key}:${error.kind}`, THROTTLE_MS)
    ) {
      this.logger.error(`${failed}: ${describe(error)}`);
    }

    const reason = NOTICE_REASONS[error.kind];
    if (reason) {
      await this.notifyZulip(state, message.topic, reason);
    }
  }

  private async notifyZulip(state: PairState, topic: string, reason: string) {
    const { key, zulipStreamId } = state.pair;
    if (!this.throttle(`notice:${zulipStreamId}:${topicKey(topic)}`, THROTTLE_MS)) {
      return;
    }
    try {
      await this.zulip.sendMessage({ stream: zulipStreamId, topic, content: `⚠ Not mirrored to Discord: ${reason}.` });
    } catch (error) {
      this.fail(`${key}: could not post the not-mirrored notice in Zulip stream ${zulipStreamId}`, error);
    }
  }

  /**
   * `before` is the content the edit replaced, which an edit event carries: the uploads it adds are attached to the
   * first part. Without it, as when catch-up finds the edit, the copy keeps the files it has.
   */
  private async editFromZulip(state: PairState, messageId: number, content: string, attempt = 1, before?: string) {
    const { pair } = state;
    const label = `edit of Zulip message ${messageId}`;
    const all = (await this.database.getMirrorMessagesByZulipIds([messageId], { withDeleted: true })).filter(
      ({ origin }) => origin === 'zulip',
    );
    const rows = all.filter(({ deletedAt }) => deletedAt === null);
    const hash = sha256(content);
    if (
      rows.length === 0 ||
      this.holdFor(state, 'Discord', label, () => this.editFromZulip(state, messageId, content, attempt, before)) ||
      rows[0].sourceHash === hash
    ) {
      return;
    }

    const rendered = await this.renderForDiscord(state, content);
    const earlier = before === undefined ? undefined : parseZulipRefs(before, this.realmOrigin).uploads;
    const added = earlier === undefined ? [] : rendered.uploads.filter((path) => !earlier.includes(path));
    if (
      earlier === undefined ? rendered.uploads.length > 0 : earlier.some((path) => !rendered.uploads.includes(path))
    ) {
      this.logger.log(
        `${pair.key}: Zulip message ${messageId} was edited; its Discord copy keeps the files it was sent with`,
      );
    }
    const upload =
      added.length > 0 && rows[0].part === 0
        ? await this.downloadUploads(
            state,
            messageId,
            { uploads: added, spoilerUploads: rendered.spoilerUploads },
            await this.freeFileSlots(rows[0], earlier!.length),
          )
        : { files: [], notes: [] };
    let parts = withNotes(rendered.text, upload.notes);
    if (parts.length === 0) {
      parts = [''];
    }

    const kept: MirrorMessage[] = [];
    let again = false;
    let attached = false;
    for (const row of rows) {
      try {
        if (row.part < parts.length) {
          const files = row.part === 0 ? upload.files : [];
          attached =
            (await this.editOnDiscord(state, row, parts[row.part], files, rendered.text, upload.notes)) || attached;
          kept.push(row);
        } else if (row.part > 0) {
          await this.onDiscord(state, row.discordThreadId, () => this.discordMirror.deleteMirrorMessage(toTarget(row)));
          await this.database.removeMirrorMessages([row.discordMessageId]);
        }
      } catch (error) {
        if (isTransient(error) && attempt < DISCORD_CHANGE_ATTEMPTS) {
          again = true;
          attached ||= row.part === 0 && upload.files.length > 0 && mayHaveBeenCarriedOut(error);
          continue;
        }
        await this.discordEditFailed(state, row, error);
        if (!isMirrorError(error, 'unknown-message') && !isMirrorError(error, 'unknown-channel')) {
          kept.push(row);
        }
      }
    }
    if (again) {
      // Files the first part took, or may have, are not attached again: the retry sees them as there before the edit.
      this.retryOnDiscord(state, label, attempt, (next) =>
        this.editFromZulip(state, messageId, content, next, attached ? content : before),
      );
      return;
    }
    await this.database.updateMirrorMessages(
      kept.map(({ discordMessageId }) => discordMessageId),
      { sourceHash: hash },
    );

    const complete = all.every(({ part, deletedAt }, index) => part === index && deletedAt === null);
    if (complete && parts.length > rows.length) {
      await this.appendParts(state, rows, parts.slice(rows.length), hash);
    }
  }

  /** Uploads the first mirroring turned into notes left their slots free, so the copy itself is counted. */
  private async freeFileSlots(row: MirrorMessage, earlierUploads: number) {
    try {
      return MAX_FILES - Math.min(await this.discordMirror.countMirrorAttachments(toTarget(row)), MAX_FILES);
    } catch {
      return MAX_FILES - Math.min(earlierUploads, MAX_FILES);
    }
  }

  /**
   * Discord keeps a message's attachments through an edit, and adds the files given; files it finds too large become
   * notes. Resolves to whether files were attached.
   */
  private async editOnDiscord(
    state: PairState,
    row: MirrorMessage,
    content: string,
    files: File[],
    text: string,
    notes: Note[],
  ) {
    const edit = (body: string, withFiles: File[]) =>
      this.onDiscord(state, row.discordThreadId, () =>
        this.discordMirror.editMirrorMessage(toTarget(row), {
          content: body,
          suppressEmbeds: suppressEmbeds(body),
          ...(withFiles.length > 0 ? { files: withFiles } : {}),
        }),
      );
    try {
      await edit(content, files);
      return files.length > 0;
    } catch (error) {
      if (!isMirrorError(error, 'too-large') || files.length === 0) {
        throw error;
      }
      await edit(withNotes(text, [...notes, ...files.map(toNote)])[0] ?? '', []);
      return false;
    }
  }

  private async discordEditFailed(state: PairState, row: MirrorMessage, error: unknown) {
    const { key } = state.pair;
    const about = `Discord message ${row.discordMessageId} (the copy of Zulip message ${row.zulipMessageId})`;
    if (isMirrorError(error, 'unknown-message')) {
      await this.database.markMirrorMessagesDeleted([row.discordMessageId]);
    } else if (isMirrorError(error, 'unknown-channel') && row.discordThreadId !== null) {
      await this.threadDeleted(state, row.discordThreadId, 'the Discord thread no longer exists');
    } else if (isMirrorError(error, 'locked')) {
      this.logger.warn(`${key}: could not update ${about}: the Discord thread is locked`);
    } else if (isMirrorError(error, 'replaced-webhook')) {
      this.logger.warn(`${key}: could not update ${about}: it was posted by a webhook that has since been replaced`);
    } else {
      this.fail(`${key}: could not update ${about}`, error);
    }
  }

  private async appendParts(state: PairState, rows: MirrorMessage[], extra: string[], hash: string) {
    const { pair } = state;
    const [first] = rows;
    const conversation =
      first.conversationId === null ? undefined : await this.database.getMirrorConversation(first.conversationId);
    const threadId = conversation ? conversation.discordThreadId : rows.at(-1)!.discordThreadId;
    const senderId = first.zulipSenderId ?? 0;
    const identity = await this.resolveIdentity(
      { id: senderId, fullName: await this.senderName(senderId, first.zulipMessageId) },
      state.guildId!,
    );
    for (const [index, content] of extra.entries()) {
      const part = rows.length + index;
      try {
        const posted = await this.onDiscord(state, threadId, () =>
          this.discordMirror.sendMirrorMessage({
            channelId: pair.discordChannelId,
            threadId: threadId ?? undefined,
            username: identity.username,
            avatarUrl: identity.avatarUrl,
            content,
            pingUserIds: [],
            suppressEmbeds: suppressEmbeds(content),
          }),
        );
        await this.database.createMirrorMessages([zulipOriginRow(pair, { ...first, sourceHash: hash }, posted, part)]);
      } catch (error) {
        this.fail(
          `${pair.key}: could not add part ${part + 1} of Zulip message ${first.zulipMessageId} on Discord`,
          error,
        );
        return;
      }
    }
  }

  /** Names are only learned from new messages, so after a restart an edit has to ask for its sender's. */
  private async senderName(senderId: number, messageId: number) {
    const known = this.senderNames.get(senderId);
    if (known !== undefined || this.teamMembers.has(senderId)) {
      return known ?? '';
    }
    try {
      const { senderFullName = '' } = await this.retryZulip(() => this.zulip.getMessage(messageId));
      this.senderNames.set(senderId, senderFullName);
      return senderFullName;
    } catch {
      return '';
    }
  }

  private async deleteFromZulip(state: PairState, messageIds: number[]) {
    const rows = await this.database.getMirrorMessagesByZulipIds(messageIds);
    const vanished = await this.vanishedConversations(state, messageIds);
    await this.database.markMirrorMessagesDeleted(rows.map(({ discordMessageId }) => discordMessageId));
    for (const conversation of vanished) {
      await this.detach(state, conversation, 'Zulip removed every mirrored message of its topic');
    }
    await this.deleteCopies(state, rows);
    await this.reanchor(state, messageIds);
  }

  /** A message moved out of the mirror stream is deleted in the stream it was moved to, which no pair owns. */
  private async deleteMovedFromZulip(state: PairState, messageIds: number[]) {
    const rows = (await this.database.getMirrorMessagesByZulipIds(messageIds)).filter(
      ({ discordChannelId }) => discordChannelId === state.pair.discordChannelId,
    );
    if (rows.length > 0) {
      await this.database.markMirrorMessagesDeleted(rows.map(({ discordMessageId }) => discordMessageId));
      await this.deleteCopies(state, rows);
    }
  }

  private async deleteCopies(state: PairState, rows: MirrorMessage[]) {
    const { pair } = state;
    const cutoff = Date.now() - Constants.Mirror.DeleteSyncMaxAgeDays * DAY;
    const copies = rows.filter(({ origin }) => origin === 'zulip');
    const old = copies.filter(({ createdAt }) => createdAt.getTime() < cutoff);
    const young = copies.filter(({ createdAt }) => createdAt.getTime() >= cutoff);
    if (old.length > 0) {
      const count = new Set(old.map(({ zulipMessageId }) => zulipMessageId)).size;
      this.logger.warn(
        `${pair.key}: Zulip deleted ${plural(count, 'mirrored message')} older than ${Constants.Mirror.DeleteSyncMaxAgeDays} days; not deleting their Discord copies (Discord messages ${old.map(({ discordMessageId }) => discordMessageId).join(', ')}); delete them there by hand if this was intended`,
      );
    }
    await this.deleteOnDiscord(state, young);
  }

  private async deleteOnDiscord(state: PairState, rows: MirrorMessage[], attempt = 1) {
    const label = `deletion of Discord messages ${rows.map(({ discordMessageId }) => discordMessageId).join(', ')}`;
    if (rows.length === 0 || this.holdFor(state, 'Discord', label, () => this.deleteOnDiscord(state, rows, attempt))) {
      return;
    }
    const again: MirrorMessage[] = [];
    for (const row of rows) {
      try {
        await this.onDiscord(state, row.discordThreadId, () => this.discordMirror.deleteMirrorMessage(toTarget(row)));
      } catch (error) {
        if (isMirrorError(error, 'unknown-message')) {
          continue;
        }
        if (isMirrorError(error, 'unknown-channel') && row.discordThreadId !== null) {
          await this.threadDeleted(state, row.discordThreadId, 'the Discord thread no longer exists');
        } else if (isTransient(error) && attempt < DISCORD_CHANGE_ATTEMPTS) {
          again.push(row);
        } else {
          this.fail(
            `${state.pair.key}: could not delete Discord message ${row.discordMessageId} (the copy of Zulip message ${row.zulipMessageId})`,
            error,
          );
        }
      }
    }
    if (again.length > 0) {
      this.retryOnDiscord(state, label, attempt, (next) => this.deleteOnDiscord(state, again, next));
    }
  }

  /**
   * Threads whose anchor and every other mirrored message the deletion takes. Zulip reports a topic moved to a stream
   * the bot cannot read with the same event as a real deletion, so the copies go either way, and the thread is let go
   * rather than kept for a topic that may now live elsewhere.
   */
  private async vanishedConversations(state: PairState, messageIds: number[]) {
    const deleted = new Set(messageIds);
    const vanished: MirrorConversation[] = [];
    for (const conversation of await this.database.getMirrorConversationsByAnchors(messageIds)) {
      if (conversation.zulipStreamId !== state.pair.zulipStreamId || conversation.discordThreadId === null) {
        continue;
      }
      const rows = await this.database.getMirrorMessagesByConversation(conversation.id);
      if (
        rows.some(({ origin }) => origin === 'zulip') &&
        rows.every(({ zulipMessageId }) => deleted.has(zulipMessageId))
      ) {
        vanished.push(conversation);
      }
    }
    return vanished;
  }

  private async reanchor(state: PairState, deletedIds: number[]) {
    for (const conversation of await this.database.getMirrorConversationsByAnchors(deletedIds)) {
      const newest = await this.database.getNewestMirrorZulipMessageId(conversation.id);
      const anchor = newest === undefined || deletedIds.includes(newest) ? null : newest;
      await this.database.updateMirrorConversation(conversation.id, { zulipAnchorMessageId: anchor });
      this.logger.log(
        `${state.pair.key}: re-anchored the conversation of Discord thread ${conversation.discordThreadId} to Zulip message ${anchor ?? 'none'}`,
      );
    }
  }

  private async moveFromZulip(state: PairState, update: ZulipMessageUpdated) {
    const { pair } = state;
    const moved = [...new Set([update.messageId, ...update.messageIds])];
    const conversations = (await this.database.getMirrorConversationsByAnchors(moved)).filter(
      ({ zulipStreamId, discordThreadId }) => zulipStreamId === pair.zulipStreamId && discordThreadId !== null,
    );
    await this.leaveConversations(state, update, moved, new Set(conversations.map(({ id }) => id)));
    for (const conversation of conversations) {
      if (update.newStreamId !== undefined && update.newStreamId !== pair.zulipStreamId) {
        await this.detach(state, conversation, 'its Zulip topic was moved to another stream');
        continue;
      }
      if (update.topic === undefined) {
        continue;
      }

      const zulipTopicKey = topicKey(update.topic);
      if (await this.isTakenByAnother(state, conversation, zulipTopicKey)) {
        await this.detach(state, conversation, 'its Zulip topic was merged into another conversation');
        continue;
      }

      const previous = conversation.zulipTopic;
      await this.database.updateMirrorConversation(conversation.id, { zulipTopic: update.topic, zulipTopicKey });
      const name = toDiscordThreadName(update.topic);
      if (name !== toDiscordThreadName(previous)) {
        await this.renameThread(state, conversation, name);
      }
      if (isResolvedTopic(update.topic) !== isResolvedTopic(previous)) {
        await this.archiveThread(state, { ...conversation, zulipTopic: update.topic });
      }
    }
  }

  private async renameThread(state: PairState, conversation: MirrorConversation, name: string) {
    const threadId = conversation.discordThreadId!;
    const later = async () => {
      const current = await this.database.getMirrorConversation(conversation.id);
      if (current) {
        await this.renameThread(state, current, toDiscordThreadName(current.zulipTopic));
      }
    };
    if (this.holdFor(state, 'Discord', `rename of Discord thread ${threadId}`, later)) {
      return;
    }
    try {
      await this.onDiscord(state, threadId, () => this.discordMirror.renameMirrorThread(threadId, name));
      const names = (this.ownThreadNames.get(threadId) ?? []).filter(({ at }) => Date.now() - at < THROTTLE_MS);
      this.ownThreadNames.set(threadId, [...names, { name, at: Date.now() }]);
    } catch (error) {
      if (isMirrorError(error, 'unknown-channel')) {
        await this.detach(state, conversation, 'the Discord thread no longer exists');
      } else {
        this.logger.warn(
          `${state.pair.key}: could not rename Discord thread ${threadId} after its Zulip topic moved: ${describe(error)}`,
        );
      }
    }
  }

  /** Resolving a topic archives its thread, and unresolving it takes the thread out of the archive. */
  private async archiveThread(state: PairState, conversation: MirrorConversation, attempt = 1) {
    const threadId = conversation.discordThreadId!;
    const archive = isResolvedTopic(conversation.zulipTopic);
    const label = `${archive ? 'archiving' : 'unarchiving'} of Discord thread ${threadId}`;
    const later = (next: number) => async () => {
      const current = await this.database.getMirrorConversation(conversation.id);
      if (current) {
        await this.archiveThread(state, current, next);
      }
    };
    if (this.holdFor(state, 'Discord', label, later(attempt))) {
      return;
    }
    try {
      await (archive
        ? this.discordMirror.archiveMirrorThread(threadId)
        : this.discordMirror.unarchiveMirrorThread(threadId));
    } catch (error) {
      if (isMirrorError(error, 'unknown-channel')) {
        await this.detach(state, conversation, 'the Discord thread no longer exists');
      } else if (isTransient(error) && attempt < DISCORD_CHANGE_ATTEMPTS) {
        this.retryOnDiscord(state, label, attempt, (next) => later(next)());
      } else {
        this.logger.warn(
          `${state.pair.key}: could not ${archive ? 'archive' : 'unarchive'} Discord thread ${threadId} after its Zulip topic was ${archive ? 'resolved' : 'unresolved'}: ${describe(error)}`,
        );
      }
    }
  }

  /**
   * The tags of a forum post are the first line of the first message of its topic when the bot posted that message,
   * and a notice in the topic when a Zulip user did, or when the message can no longer be edited.
   */
  private async tagsFromDiscord(state: PairState, thread: { threadId: string; tags: string[] }) {
    const { pair } = state;
    const { threadId, tags } = thread;
    if (this.holdFor(state, 'Zulip', `tags of Discord thread ${threadId}`, () => this.tagsFromDiscord(state, thread))) {
      return;
    }
    const found = await this.database.getMirrorConversationByDiscord(pair.discordChannelId, threadId);
    const conversation = found && (await this.verifyConversation(state, found));
    if (!conversation) {
      return;
    }
    const [row] = (await this.database.getMirrorMessagesByDiscordIds([threadId])).filter(
      ({ origin }) => origin === 'discord',
    );
    if (row && (await this.editTags(state, row, tags))) {
      return;
    }
    try {
      await this.zulip.sendMessage({
        stream: pair.zulipStreamId,
        topic: conversation.zulipTopic,
        content: zulipTagsNotice(tags),
      });
    } catch (error) {
      this.fail(
        `${pair.key}: could not post the tags of Discord thread ${threadId} in Zulip stream ${pair.zulipStreamId}`,
        error,
      );
    }
  }

  /** Resolves to whether the first message now shows the tags. */
  private async editTags(state: PairState, row: MirrorMessage, tags: string[]) {
    const { pair } = state;
    const lead = withZulipTags(row.zulipHeader ?? '', tags);
    if (lead === row.zulipHeader) {
      return true;
    }
    let dto: DiscordSourceMessage | undefined;
    try {
      dto = await this.discordMirror.fetchMirrorMessage(
        row.discordThreadId ?? row.discordChannelId,
        row.discordMessageId,
      );
    } catch (error) {
      this.fail(`${pair.key}: could not read Discord message ${row.discordMessageId} to show its thread's tags`, error);
      return false;
    }
    if (!dto) {
      return false;
    }
    const content = zulipMirrorContent(
      lead,
      toZulipMirrorBody(this.editedBody(state, dto), await this.renderContext(dto)),
      row.zulipAttachments ?? '',
    );
    try {
      await this.retryZulip(() => this.zulip.updateMessage(row.zulipMessageId, { content }));
    } catch (error) {
      if (!isNothingToChange(error)) {
        this.logger.log(
          `${pair.key}: could not edit the tags into Zulip message ${row.zulipMessageId}, so they are posted instead: ${describe(error)}`,
        );
        return false;
      }
    }
    await this.database.updateMirrorMessages([row.discordMessageId], {
      zulipHeader: lead,
      sourceHash: discordSourceHash(dto),
    });
    return true;
  }

  /** Moved messages whose conversation stays behind no longer belong to it, so they can never become its anchor. */
  private async leaveConversations(
    state: PairState,
    update: ZulipMessageUpdated,
    moved: number[],
    movingAlong: Set<string>,
  ) {
    const outOfStream = update.newStreamId !== undefined && update.newStreamId !== state.pair.zulipStreamId;
    const leaving = (await this.database.getMirrorMessagesByZulipIds(moved)).filter(
      ({ conversationId }) => outOfStream || (conversationId !== null && !movingAlong.has(conversationId)),
    );
    await this.database.updateMirrorMessages(
      leaving.map(({ discordMessageId }) => discordMessageId),
      outOfStream ? { conversationId: null, zulipStreamId: update.newStreamId } : { conversationId: null },
    );
  }

  /** The main topic counts as taken even before its conversation exists. */
  private async isTakenByAnother(state: PairState, conversation: MirrorConversation, key: string) {
    const { pair } = state;
    if (key === conversation.zulipTopicKey) {
      return false;
    }
    if (isMainTopic(pair, key)) {
      return true;
    }
    const owner = await this.database.getMirrorConversationByZulipTopic(pair.zulipStreamId, key);
    return owner !== undefined && owner.id !== conversation.id;
  }

  private async detach(state: PairState, conversation: MirrorConversation, reason: string) {
    await this.database.removeMirrorConversation(conversation.id);
    this.logger.log(
      `${state.pair.key}: detached the conversation of Discord thread ${conversation.discordThreadId}: ${reason}`,
    );
  }

  /** Reads the anchor's topic once per queue registration, in case a move was missed. */
  private async verifyConversation(state: PairState, conversation: MirrorConversation) {
    const { pair } = state;
    const anchor = conversation.zulipAnchorMessageId;
    if (anchor === null || this.verifiedConversations.has(conversation.id)) {
      return conversation;
    }

    let found: ZulipMessage;
    try {
      found = await this.retryZulip(() => this.zulip.getMessage(anchor));
    } catch (error) {
      if (!isZulipMessageGone(error)) {
        this.logger.warn(
          `${pair.key}: could not check the Zulip topic of Discord thread ${conversation.discordThreadId}: ${describe(error)}`,
        );
        return conversation;
      }
      await this.reanchor(state, [anchor]);
      this.verifiedConversations.add(conversation.id);
      return (await this.database.getMirrorConversation(conversation.id)) ?? conversation;
    }

    if (found.streamId !== pair.zulipStreamId) {
      await this.detach(state, conversation, 'its Zulip topic was moved to another stream');
      return undefined;
    }
    const { topic } = found;
    if (topic !== conversation.zulipTopic) {
      const zulipTopicKey = topicKey(topic);
      if (await this.isTakenByAnother(state, conversation, zulipTopicKey)) {
        await this.detach(state, conversation, 'its Zulip topic was merged into another conversation');
        return undefined;
      }
      await this.database.updateMirrorConversation(conversation.id, { zulipTopic: topic, zulipTopicKey });
      conversation = { ...conversation, zulipTopic: topic, zulipTopicKey };
    }
    this.verifiedConversations.add(conversation.id);
    return conversation;
  }

  /** A contributor thread never merges into an existing Zulip topic, nor into the main one. */
  private async claimTopic(
    state: PairState,
    base: string,
    threadId: string,
    { exclude, prefix = '' }: { exclude?: string; prefix?: string } = {},
  ) {
    const { pair } = state;
    const candidates = topicCandidates(base, threadId);
    for (const [index, name] of candidates.entries()) {
      const candidate = `${prefix}${name}`;
      const key = topicKey(candidate);
      if (isMainTopic(pair, key)) {
        continue;
      }
      const owner = await this.database.getMirrorConversationByZulipTopic(pair.zulipStreamId, key);
      if (owner) {
        if (owner.id === exclude) {
          return candidate;
        }
        continue;
      }
      if (index === candidates.length - 1) {
        return candidate;
      }
      const existing = await this.retryZulip(() =>
        this.zulip.getMessages({ stream: pair.zulipStreamId, topic: candidate, numBefore: 1 }),
      );
      if (existing.length === 0) {
        return candidate;
      }
    }
    return undefined;
  }

  /**
   * A backfilled message renders every mention silently and is marked with its time; `topic` is the one the backfill
   * claimed for a thread that has none yet.
   */
  private async mirrorDiscordMessage(
    state: PairState,
    source: DiscordSourceMessage,
    generation?: number,
    backfill?: { topic?: string },
  ): Promise<CreateOutcome> {
    const { pair } = state;
    const holding = backfill ? undefined : state.backfills.get(source.threadId ?? source.channelId);
    if (holding) {
      holding.held.push({
        label: `Discord message ${source.id}`,
        run: () => this.mirrorHeld(state, source, generation),
      });
      return 'held';
    }
    const dto = backfill ? { ...source, silent: true } : source;
    const turnAway = () =>
      this.turnAway(state, { discord: new Map([[dto.threadId ?? dto.channelId, BigInt(dto.id)]]), zulip: new Set() });
    if (!this.zulip.isInitialised()) {
      turnAway();
      this.notReady(state, 'Zulip');
      return 'retry';
    }
    const label = `Discord message ${dto.id}`;
    if (!this.mayCreate(state, label, generation, turnAway)) {
      return (this.failedCreates.get(label) ?? 0) >= MAX_CREATE_ATTEMPTS ? 'failed' : 'retry';
    }

    const attempt: CreateAttempt = { posted: false, uncertain: false };
    try {
      if ((await this.database.getMirrorMessagesByDiscordIds([dto.id], { withDeleted: true })).length > 0) {
        return 'skipped';
      }
      let conversation: MirrorConversation | undefined;
      if (dto.threadId === null) {
        if (pair.mainTopic === null) {
          return 'skipped';
        }
        conversation = await this.mainConversation(state);
      } else {
        const found = await this.database.getMirrorConversationByDiscord(pair.discordChannelId, dto.threadId);
        conversation = found && (await this.verifyConversation(state, found));
      }

      const ctx = await this.renderContext(dto);
      const body = toZulipMirrorBody(dto, ctx);
      if (body.trim() === '' && dto.attachments.length === 0) {
        return 'skipped';
      }
      const topic =
        conversation?.zulipTopic ??
        backfill?.topic ??
        (await this.claimTopic(state, toZulipTopicName(dto.threadName ?? '', dto.threadId!), dto.threadId!));
      if (topic === undefined) {
        this.logger.error(`${pair.key}: found no free Zulip topic for Discord thread ${dto.threadId}`);
        return 'failed';
      }

      const reply = await this.replyTarget(dto, topic);
      const late = backfill !== undefined || Date.now() - dto.createdTimestamp > LATE_MS;
      const header = zulipAuthorHeader(dto, { ...ctx, reply, late });
      const context = conversation || pair.kind !== 'text' ? '' : await this.threadContext(state, dto.threadId!, ctx);
      const tags = !conversation && pair.kind === 'forum' && dto.id === dto.threadId ? (dto.threadTags ?? []) : [];
      const lead = withZulipTags(
        context + zulipMirrorLead(header, dto.replyTo?.content ? toZulipReplySnippet(dto.replyTo.content, ctx) : null),
        tags,
      );
      const attachments = toZulipAttachmentLines(await this.uploadAttachments(state, dto), dto.jumpUrl);
      if (body.trim() === '' && attachments === '') {
        return 'skipped';
      }

      const { id } = await this.creating(attempt, () =>
        this.zulip.sendMessage({
          stream: pair.zulipStreamId,
          topic,
          content: zulipMirrorContent(lead, body, attachments),
        }),
      );
      conversation ??= await this.createThreadConversation(state, dto.threadId!, topic, id);
      await this.database.createMirrorMessages([
        {
          discordMessageId: dto.id,
          conversationId: conversation.id,
          origin: 'discord',
          discordChannelId: pair.discordChannelId,
          discordThreadId: dto.threadId,
          discordWebhookId: null,
          discordAuthorId: dto.author.id,
          zulipMessageId: id,
          zulipStreamId: pair.zulipStreamId,
          zulipSenderId: null,
          part: 0,
          sourceHash: discordSourceHash(dto),
          zulipHeader: lead,
          zulipAttachments: attachments || null,
        },
      ]);
      if (conversation.discordThreadId !== null && conversation.zulipAnchorMessageId === null) {
        await this.database.updateMirrorConversation(conversation.id, { zulipAnchorMessageId: id });
      }
      this.created(state, label);
      return 'created';
    } catch (error) {
      const retry = this.createFailed(state, label, error, attempt, turnAway);
      this.fail(`${pair.key}: could not mirror Discord message ${dto.id} to Zulip`, error);
      return retry ? 'retry' : 'failed';
    }
  }

  /** Behind whatever is queued, so that the pair's other conversations keep flowing. */
  private nextBackfillStep(state: PairState, backfill: Backfill, delayMs = 0) {
    if (backfill.finished) {
      return;
    }
    const push = () =>
      state.queue.push(`backfill of Discord channel ${backfill.location}`, () => this.backfillStep(state, backfill));
    if (delayMs === 0) {
      push();
      return;
    }
    backfill.timer = setTimeout(() => {
      backfill.timer = undefined;
      push();
    }, delayMs);
    backfill.timer.unref();
  }

  /** One page read or one message copied. */
  private async backfillStep(state: PairState, backfill: Backfill) {
    const { pair } = state;
    if (backfill.finished) {
      return;
    }
    if (state.status === 'disabled') {
      await this.endBackfill(state, backfill, 'off');
      return;
    }
    if (!state.caughtUp || !this.discordReady(state) || !this.zulip.isInitialised()) {
      if (this.throttle(`backfill-waits:${pair.key}`, THROTTLE_MS)) {
        this.logger.warn(`${pair.key}: a backfill waits until both sides are ready and caught up`);
      }
      this.nextBackfillStep(state, backfill, RESUME_MS);
      return;
    }

    if (backfill.page.length === 0) {
      if (!backfill.more) {
        await this.endBackfill(state, backfill);
        return;
      }
      try {
        await this.readBackfillPage(backfill);
      } catch (error) {
        if (isMirrorError(error, 'unknown-channel')) {
          await this.endBackfill(state, backfill, 'gone');
          return;
        }
        this.fail(`${pair.key}: a backfill could not read Discord channel ${backfill.location}`, error);
        if (!isTransient(error)) {
          await this.endBackfill(state, backfill, 'failed');
          return;
        }
        this.nextBackfillStep(state, backfill, RESUME_MS);
        return;
      }
      this.nextBackfillStep(state, backfill);
      return;
    }

    const [dto] = backfill.page;
    if (!backfill.noticed && !(await this.startBackfillNotice(state, backfill, dto))) {
      return;
    }
    const outcome = await this.mirrorDiscordMessage(state, dto, state.generation, { topic: backfill.newTopic });
    if (outcome === 'retry') {
      this.nextBackfillStep(state, backfill, RESUME_MS);
      return;
    }
    backfill.page.shift();
    if (outcome === 'created') {
      backfill.copied++;
      if (backfill.reacted.has(dto.id)) {
        this.queueReactionSync(state, `reactions of Discord message ${dto.id}`, () =>
          this.reactionsToZulip(state, dto.id),
        );
      }
    } else if (outcome === 'failed') {
      backfill.failed++;
    }
    this.nextBackfillStep(state, backfill, outcome === 'created' ? BACKFILL_PACE_MS : 0);
  }

  /** Streams forwards: only the part of one page not mirrored yet is kept. */
  private async readBackfillPage(backfill: Backfill) {
    const page = await this.discordMirror.fetchMirrorMessagesAfter(
      backfill.location,
      String(backfill.after),
      BACKFILL_PAGE,
    );
    const newest = page.newestId === null ? undefined : BigInt(page.newestId);
    backfill.more = page.full && newest !== undefined && newest < backfill.until;
    backfill.after = newest ?? backfill.after;
    const wanted = page.messages.filter(({ id }) => BigInt(id) <= backfill.until);
    const mirrored = new Set(
      (
        await this.database.getMirrorMessagesByDiscordIds(
          wanted.map(({ id }) => id),
          { withDeleted: true },
        )
      ).map(({ discordMessageId }) => discordMessageId),
    );
    backfill.page = wanted.filter(({ id }) => !mirrored.has(id));
    backfill.reacted = new Set(page.reactedIds);
  }

  /** The topic the history goes to; a thread that has none claims one, which the start notice then holds. */
  private async backfillTopic(state: PairState, backfill: Backfill, first?: DiscordSourceMessage) {
    const { pair } = state;
    if (backfill.threadId === null) {
      return pair.mainTopic!;
    }
    const found = await this.database.getMirrorConversationByDiscord(pair.discordChannelId, backfill.threadId);
    const conversation = found && (await this.verifyConversation(state, found));
    if (conversation) {
      return conversation.zulipTopic;
    }
    if (first) {
      backfill.newTopic ??= await this.claimTopic(
        state,
        toZulipTopicName(first.threadName ?? '', backfill.threadId),
        backfill.threadId,
      );
    }
    return backfill.newTopic;
  }

  /** Resolves to whether the notice is in; otherwise the backfill is ended or tried again later. */
  private async startBackfillNotice(state: PairState, backfill: Backfill, first: DiscordSourceMessage) {
    const { pair } = state;
    try {
      const topic = await this.backfillTopic(state, backfill, first);
      if (topic === undefined) {
        this.logger.error(`${pair.key}: found no free Zulip topic for Discord thread ${backfill.threadId}`);
        await this.endBackfill(state, backfill, 'failed');
        return false;
      }
      await this.zulip.sendMessage({
        stream: pair.zulipStreamId,
        topic,
        content: `📜 History from Discord from before the mirror follows (from <time:${new Date(first.createdTimestamp).toISOString()}>)`,
      });
      backfill.noticed = true;
      return true;
    } catch (error) {
      this.fail(`${pair.key}: could not post the backfill notice in Zulip stream ${pair.zulipStreamId}`, error);
      if (isTransient(error)) {
        this.nextBackfillStep(state, backfill, RESUME_MS);
      } else {
        await this.endBackfill(state, backfill, 'failed');
      }
      return false;
    }
  }

  /** The end notice goes in before the live creates that waited, which then run next, in order. */
  private async endBackfill(state: PairState, backfill: Backfill, stopped?: BackfillStop) {
    const { pair } = state;
    const { copied, failed, noticed } = backfill;
    if (noticed) {
      const count = `${plural(copied, 'message')}${failed > 0 ? `; ${failed} could not be copied, see the log` : ''}`;
      const content =
        stopped === undefined
          ? `📜 End of the history from Discord: ${count}`
          : `📜 The history from Discord stops here for now, after ${count}: ${BACKFILL_STOPS[stopped]}.${stopped === 'gone' ? '' : ' `mirror-backfill` carries on from here.'}`;
      try {
        const topic = await this.backfillTopic(state, backfill);
        if (topic !== undefined) {
          await this.zulip.sendMessage({ stream: pair.zulipStreamId, topic, content });
        }
      } catch (error) {
        this.fail(`${pair.key}: could not post the end of a backfill in Zulip stream ${pair.zulipStreamId}`, error);
      }
    }
    this.finishBackfill(state, backfill, stopped);
    state.queue.pushNext(backfill.held);
  }

  private finishBackfill(state: PairState, backfill: Backfill, stopped?: BackfillStop) {
    if (backfill.finished) {
      return;
    }
    backfill.finished = true;
    clearTimeout(backfill.timer);
    state.backfills.delete(backfill.location);
    const { copied, failed, noticed } = backfill;
    this.logger.log(
      `${state.pair.key}: backfill of Discord channel ${backfill.location} ${stopped ? `stopped (${stopped})` : 'done'}: copied ${plural(copied, 'message')}, ${failed} failed`,
    );
    backfill.resolve({ copied, failed, noticed, ...(stopped ? { stopped } : {}) });
  }

  /** The queue is closed, so nothing is posted and the creates that waited go with it. */
  private abandonBackfills(state: PairState, stopped: BackfillStop) {
    for (const backfill of state.backfills.values()) {
      this.finishBackfill(state, backfill, stopped);
    }
  }

  /** Read afresh: an edit or deletion while it waited found no copy to change. */
  private async mirrorHeld(state: PairState, dto: DiscordSourceMessage, generation: number | undefined) {
    if ((await this.database.getMirrorMessagesByDiscordIds([dto.id], { withDeleted: true })).length > 0) {
      return;
    }
    let current: DiscordSourceMessage | undefined = dto;
    try {
      current = await this.discordMirror.fetchMirrorMessage(dto.threadId ?? dto.channelId, dto.id);
    } catch (error) {
      this.logger.warn(
        `${state.pair.key}: could not read Discord message ${dto.id} again after the backfill, so it is mirrored as it was sent: ${describe(error)}`,
      );
    }
    if (current && (await this.mirrorDiscordMessage(state, current, generation)) === 'created') {
      this.queueReactionSync(state, `reactions of Discord message ${dto.id}`, () =>
        this.reactionsToZulip(state, dto.id),
      );
    }
  }

  /** A thread started from a message has that message's ID, and a thread started without one none of a message. */
  private async threadContext(state: PairState, threadId: string, ctx: DiscordRenderContext) {
    const { pair } = state;
    let starter: DiscordSourceMessage | undefined;
    try {
      starter = await this.discordMirror.fetchMirrorMessage(pair.discordChannelId, threadId);
    } catch (error) {
      this.logger.warn(
        `${pair.key}: could not read the message Discord thread ${threadId} was started from: ${describe(error)}`,
      );
      return '';
    }
    if (!starter) {
      return '';
    }
    const [row] = await this.database.getMirrorMessagesByDiscordIds([threadId]);
    const conversation =
      !row || row.conversationId === null ? undefined : await this.database.getMirrorConversation(row.conversationId);
    return zulipThreadContext(
      {
        zulipLink: row
          ? zulipNarrowLink(row.zulipStreamId, conversation?.zulipTopic ?? pair.mainTopic ?? '', row.zulipMessageId)
          : null,
        jumpUrl: starter.jumpUrl,
        authorName: starter.author.displayName || starter.author.username,
        content: starter.content,
      },
      ctx,
    );
  }

  private async replyTarget(dto: DiscordSourceMessage, topic: string): Promise<ZulipReplyTarget | null> {
    const { replyTo } = dto;
    if (!replyTo) {
      return null;
    }
    const [row] = await this.database.getMirrorMessagesByDiscordIds([replyTo.messageId]);
    if (!row || (row.origin === 'zulip' && row.zulipSenderId === null)) {
      return { origin: 'unmirrored', authorName: replyTo.authorDisplayName };
    }
    const conversation =
      row.conversationId === null ? undefined : await this.database.getMirrorConversation(row.conversationId);
    const link = zulipNarrowLink(row.zulipStreamId, conversation?.zulipTopic ?? topic, row.zulipMessageId);
    return row.origin === 'zulip'
      ? { origin: 'zulip', zulipSenderId: row.zulipSenderId!, link }
      : { origin: 'discord', discordAuthorId: row.discordAuthorId ?? '', authorName: replyTo.authorDisplayName, link };
  }

  private async uploadAttachments(state: PairState, dto: DiscordSourceMessage) {
    const results: ZulipAttachmentResult[] = [];
    const deadline = transferDeadline();
    for (const [index, attachment] of dto.attachments.entries()) {
      let url: string | null = null;
      if (index < MAX_FILES && attachment.size <= Constants.Mirror.MaxUploadBytes && !deadline.signal.aborted) {
        try {
          const file = await downloadDiscordAttachment(attachment, Constants.Mirror.MaxUploadBytes, deadline.signal);
          url = file ? (await this.zulip.uploadFile(file, deadline.signal)).url : null;
        } catch (error) {
          this.logger.warn(
            `${state.pair.key}: could not mirror attachment ${attachment.id} of Discord message ${dto.id}: ${describe(error)}`,
          );
        }
      }
      results.push({ name: attachment.name, spoiler: attachment.spoiler, url });
    }
    deadline.done();
    return results;
  }

  private async editFromDiscord(state: PairState, dto: DiscordSourceMessage) {
    const { pair } = state;
    const row = (await this.database.getMirrorMessagesByDiscordIds([dto.id])).find(
      ({ origin }) => origin === 'discord',
    );
    const hash = discordSourceHash(dto);
    if (
      !row ||
      this.holdFor(state, 'Zulip', `edit of Discord message ${dto.id}`, () => this.editFromDiscord(state, dto)) ||
      row.sourceHash === hash
    ) {
      return;
    }

    const content = zulipMirrorContent(
      row.zulipHeader ?? '',
      toZulipMirrorBody(this.editedBody(state, dto), await this.renderContext(dto)),
      row.zulipAttachments ?? '',
    );
    try {
      await this.retryZulip(() => this.zulip.updateMessage(row.zulipMessageId, { content }));
    } catch (error) {
      if (isZulipRefusal(error)) {
        this.logger.log(
          `${pair.key}: Zulip refused the edit of message ${row.zulipMessageId} (the copy of Discord message ${dto.id}): ${describe(error)}`,
        );
        return;
      }
      if (!isNothingToChange(error)) {
        this.fail(
          `${pair.key}: could not edit Zulip message ${row.zulipMessageId} (the copy of Discord message ${dto.id})`,
          error,
        );
        return;
      }
    }
    await this.database.updateMirrorMessages([dto.id], { sourceHash: hash });
  }

  /** Only a backfill copies a message older than the link, and its mentions stay silent through an edit. */
  private editedBody(state: PairState, dto: DiscordSourceMessage) {
    return dto.createdTimestamp < state.pair.linkedAt ? { ...dto, silent: true } : dto;
  }

  private async deleteFromDiscord(state: PairState, messageIds: string[]) {
    for (const row of await this.database.getMirrorMessagesByDiscordIds(messageIds)) {
      // Marked first: Zulip reports the bot's own deletion back as an event, which must find nothing.
      await this.database.markMirrorMessagesDeleted([row.discordMessageId]);
      if (row.origin === 'discord') {
        await this.deleteOnZulip(state, row);
      }
    }
  }

  private async deleteOnZulip(state: PairState, row: MirrorMessage) {
    const { pair } = state;
    const about = `message ${row.zulipMessageId} (the copy of Discord message ${row.discordMessageId})`;
    if (this.holdFor(state, 'Zulip', `deletion of Zulip ${about}`, () => this.deleteOnZulip(state, row))) {
      return;
    }
    try {
      await this.retryZulip(() => this.zulip.deleteMessage(row.zulipMessageId));
    } catch (error) {
      if (isZulipRefusal(error)) {
        this.logger.warn(
          `${pair.key}: Zulip refused to delete ${about}; add the bot to the stream's can_delete_any_message_group`,
        );
        return;
      }
      if (!isZulipMessageGone(error)) {
        this.fail(`${pair.key}: could not delete Zulip ${about}`, error);
        return;
      }
    }
    await this.reanchor(state, [row.zulipMessageId]);
  }

  /**
   * The bot can only react as itself, so its reactions on the Zulip message stand for the Discord users who react to the
   * Discord side, however many: it reacts once someone does and takes its reaction back when nobody does any more.
   */
  private async reactionsToZulip(state: PairState, discordMessageId: string) {
    const { pair } = state;
    const label = `reactions of Discord message ${discordMessageId}`;
    const [row] = await this.database.getMirrorMessagesByDiscordIds([discordMessageId]);
    if (
      !row ||
      row.discordChannelId !== pair.discordChannelId ||
      this.holdFor(state, 'Zulip', label, () => this.reactionsToZulip(state, discordMessageId))
    ) {
      return;
    }
    const copies =
      row.origin === 'zulip' ? await this.database.getMirrorMessagesByZulipIds([row.zulipMessageId]) : [row];
    const codes = await this.emojiTables();
    if (!codes) {
      return;
    }
    const wanted = new Map<string, ZulipReactionEmoji>();
    try {
      const read: Awaited<ReturnType<typeof this.readDiscordReactions>> = [];
      for (const copy of copies) {
        read.push(...(await this.readDiscordReactions(copy)));
      }
      const emotes = await this.emoteMaps(state.guildId!, (maps) =>
        read.some(({ emoji }) => emoji.id !== null && !maps.zulipByEmoteId.has(emoji.id)),
      );
      if (!emotes) {
        return;
      }
      for (const { emoji, count, me } of read) {
        const zulipEmoji = count > (me ? 1 : 0) ? toZulipReactionEmoji(emoji, codes.names, emotes) : undefined;
        if (zulipEmoji) {
          wanted.set(zulipReactionKey(zulipEmoji), zulipEmoji);
        }
      }
      const self = this.zulipService.ownUser?.userId;
      const { reactions = [] } = await this.retryZulip(() => this.zulip.getMessage(row.zulipMessageId));
      const mine = new Map(
        reactions
          .filter(({ userId }) => userId === self)
          .map(({ name, code, type }) => [zulipReactionKey({ name, code, type }), { name, code, type }] as const),
      );
      for (const [key, emoji] of wanted) {
        if (!mine.has(key)) {
          await this.changeZulipReaction(
            () => this.zulip.addReaction(row.zulipMessageId, emoji),
            'REACTION_ALREADY_EXISTS',
          );
        }
      }
      for (const [key, emoji] of mine) {
        if (!wanted.has(key)) {
          await this.changeZulipReaction(
            () => this.zulip.removeReaction(row.zulipMessageId, emoji),
            'REACTION_DOES_NOT_EXIST',
          );
        }
      }
    } catch (error) {
      if (!isZulipMessageGone(error) && !isMirrorError(error, 'unknown-channel')) {
        this.fail(`${pair.key}: could not mirror the reactions of Discord message ${discordMessageId} to Zulip`, error);
      }
    }
  }

  /** A copy deleted on Discord has no reactions left to count. */
  private async readDiscordReactions(row: MirrorMessage) {
    try {
      return await this.discordMirror.getMirrorReactions(toTarget(row));
    } catch (error) {
      if (isMirrorError(error, 'unknown-message')) {
        return [];
      }
      throw error;
    }
  }

  private async changeZulipReaction(call: () => Promise<void>, alreadyCode: string) {
    try {
      await this.retryZulip(call);
    } catch (error) {
      if (!(error instanceof ZulipApiError && error.code === alreadyCode)) {
        throw error;
      }
    }
  }

  /** The Zulip side of `reactionsToZulip`: the bot reacts on the first part of the Discord copy. */
  private async reactionsToDiscord(state: PairState, zulipMessageId: number) {
    const { pair } = state;
    const label = `reactions of Zulip message ${zulipMessageId}`;
    const [row] = (await this.database.getMirrorMessagesByZulipIds([zulipMessageId])).filter(
      ({ discordChannelId }) => discordChannelId === pair.discordChannelId,
    );
    if (!row || this.holdFor(state, 'Discord', label, () => this.reactionsToDiscord(state, zulipMessageId))) {
      return;
    }
    const target = toTarget(row);
    try {
      const self = this.zulipService.ownUser?.userId;
      const { reactions = [] } = await this.retryZulip(() => this.zulip.getMessage(zulipMessageId));
      const emotes = await this.emoteMaps(state.guildId!, (maps) =>
        reactions.some(({ type, name }) => type === 'realm_emoji' && !maps.discordByZulipName.has(name)),
      );
      if (!emotes) {
        return;
      }
      const wanted = new Map<string, DiscordReactionEmoji>();
      for (const { userId, ...emoji } of reactions) {
        const discordEmoji = userId === self ? undefined : toDiscordReactionEmoji(emoji, emotes);
        if (discordEmoji) {
          wanted.set(discordReactionKey(discordEmoji), discordEmoji);
        }
      }
      const mine = new Map(
        (await this.discordMirror.getMirrorReactions(target))
          .filter(({ me }) => me)
          .map(({ emoji }) => [discordReactionKey(emoji), emoji] as const),
      );
      for (const [key, emoji] of wanted) {
        if (!mine.has(key)) {
          await this.addDiscordReaction(state, row, emoji);
        }
      }
      for (const [key, emoji] of mine) {
        if (!wanted.has(key)) {
          await this.discordMirror.removeMirrorReaction(target, emoji);
        }
      }
    } catch (error) {
      if (isZulipMessageGone(error) || isMirrorError(error, 'unknown-message')) {
        return;
      }
      if (isMirrorError(error, 'unknown-channel') && row.discordThreadId !== null) {
        await this.threadDeleted(state, row.discordThreadId, 'the Discord thread no longer exists');
        return;
      }
      this.fail(`${pair.key}: could not mirror the reactions of Zulip message ${zulipMessageId} to Discord`, error);
    }
  }

  private async addDiscordReaction(state: PairState, row: MirrorMessage, emoji: DiscordReactionEmoji) {
    const target = toTarget(row);
    try {
      await this.onDiscord(state, row.discordThreadId, () => this.discordMirror.addMirrorReaction(target, emoji));
    } catch (error) {
      const qualified = isMirrorError(error, 'unknown-emoji') ? withVariationSelectors(emoji) : undefined;
      if (!qualified) {
        throw error;
      }
      try {
        await this.discordMirror.addMirrorReaction(target, qualified);
      } catch (again) {
        if (!isMirrorError(again, 'unknown-emoji')) {
          throw again;
        }
        this.logger.log(
          `${state.pair.key}: Discord does not support an emoji a Zulip user reacted with, so that reaction to Discord message ${target.messageId} is not mirrored`,
        );
      }
    }
  }

  /** Whether the rename is the echo of one the mirror made, which a later one may already have overtaken. */
  private isOwnRename(threadId: string, name: string) {
    const names = (this.ownThreadNames.get(threadId) ?? []).filter(({ at }) => Date.now() - at < THROTTLE_MS);
    const index = names.findIndex((entry) => entry.name === name);
    const left = names.slice(index + 1);
    if (left.length > 0) {
      this.ownThreadNames.set(threadId, left);
    } else {
      this.ownThreadNames.delete(threadId);
    }
    return index >= 0;
  }

  private async renameFromDiscord(state: PairState, thread: { threadId: string; name: string }) {
    const { pair } = state;
    if (this.isOwnRename(thread.threadId, thread.name)) {
      return;
    }
    if (
      this.holdFor(state, 'Zulip', `rename of Discord thread ${thread.threadId}`, () =>
        this.renameFromDiscord(state, thread),
      )
    ) {
      return;
    }
    const found = await this.database.getMirrorConversationByDiscord(pair.discordChannelId, thread.threadId);
    if (!found || thread.name === toDiscordThreadName(found.zulipTopic)) {
      return;
    }
    // Read afresh: a move the bot missed could have taken the anchor into another stream, whose topic this would rename.
    this.verifiedConversations.delete(found.id);
    const conversation = await this.verifyConversation(state, found);
    if (!conversation) {
      return;
    }

    const current = conversation.zulipTopic;
    const target = await this.claimTopic(state, toZulipTopicName(thread.name, thread.threadId), thread.threadId, {
      exclude: conversation.id,
      prefix: isResolvedTopic(current) ? ZULIP_RESOLVED_PREFIX : '',
    });
    if (target === undefined || target === current) {
      return;
    }

    const anchor = conversation.zulipAnchorMessageId;
    if (anchor !== null) {
      try {
        await this.retryZulip(() =>
          this.zulip.updateMessage(anchor, {
            topic: target,
            propagateMode: 'change_all',
            sendNotificationToOldThread: false,
            sendNotificationToNewThread: false,
          }),
        );
      } catch (error) {
        if (!isNothingToChange(error)) {
          if (isZulipRefusal(error)) {
            this.logger.warn(
              `${pair.key}: Zulip refused to rename the topic of Discord thread ${thread.threadId}: ${describe(error)}`,
            );
          } else {
            this.fail(`${pair.key}: could not rename the Zulip topic of Discord thread ${thread.threadId}`, error);
          }
          return;
        }
      }
    }
    await this.database.updateMirrorConversation(conversation.id, {
      zulipTopic: target,
      zulipTopicKey: topicKey(target),
    });
  }

  private async threadDeleted(state: PairState, threadId: string, reason = 'the Discord thread was deleted') {
    const { pair } = state;
    const conversation = await this.database.getMirrorConversationByDiscord(pair.discordChannelId, threadId);
    if (!conversation) {
      return;
    }
    await this.detach(state, conversation, reason);
    await this.noticeThreadDeleted(state, conversation.zulipTopic);
  }

  private async noticeThreadDeleted(state: PairState, topic: string) {
    const { pair } = state;
    if (
      this.holdFor(state, 'Zulip', `notice of the deleted thread of a Zulip topic`, () =>
        this.noticeThreadDeleted(state, topic),
      )
    ) {
      return;
    }
    try {
      await this.zulip.sendMessage({ stream: pair.zulipStreamId, topic, content: THREAD_DELETED_NOTICE });
    } catch (error) {
      this.fail(`${pair.key}: could not post the thread deletion notice in Zulip stream ${pair.zulipStreamId}`, error);
    }
  }
}
