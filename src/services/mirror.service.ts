import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { getConfig } from 'src/config';
import { Constants } from 'src/constants';
import { isResolvedTopic, plural, unresolveTopic, ZULIP_RESOLVED_PREFIX, zulipNarrowLink } from 'src/format';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import {
  DiscordMirrorChannel,
  DiscordMirrorError,
  DiscordMirrorErrorKind,
  DiscordMirrorSend,
  DiscordMirrorSent,
  DiscordMirrorTarget,
  DiscordSourceMessage,
  DiscordTeamMember,
  IDiscordMirrorInterface,
} from 'src/interfaces/discord-mirror.interface';
import {
  IZulipInterface,
  ZulipMessage,
  ZulipMessagesDeleted,
  ZulipMessageUpdated,
  ZulipReceivedMessage,
} from 'src/interfaces/zulip.interface';
import {
  DiscordRenderContext,
  discordSourceHash,
  toZulipAttachmentLines,
  toZulipMirrorBody,
  toZulipReplySnippet,
  ZulipAttachmentResult,
  zulipAuthorHeader,
  zulipMirrorContent,
  zulipMirrorLead,
  ZulipReplyTarget,
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
import { EnabledPair, validateMirrorConfig } from 'src/mirror/pairs';
import { SerialQueue } from 'src/mirror/queue';
import {
  escapeDiscordInline,
  parseZulipRefs,
  splitDiscordContent,
  toDiscordMirrorContent,
  ZulipMessageRef,
} from 'src/mirror/zulip-to-discord';
import { isZulipFailure, isZulipMessageGone, isZulipRefusal, ZulipApiError } from 'src/repositories/zulip.client';
import { MirrorConversation, MirrorMessage, NewMirrorMessage } from 'src/schema';
import { hasBlacklistedUrl, toZulipEmojiName } from 'src/services/chat.service';
import { parseCommand } from 'src/services/zulip-command.service';
import { isBotSender, ZulipService } from 'src/services/zulip.service';

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
const CHANNEL_CHECK_MS = 10 * MINUTE;
const DISCORD_EPOCH = 1_420_070_400_000n;
const ACTIVE_THREAD_DAYS = 7;
const ACTIVE_THREAD_LIMIT = 20;
const MAX_FILES = 10;
const MAX_TOTAL_FILE_BYTES = 24 * 1024 * 1024;
const FILE_TRANSFER_BUDGET_MS = 120_000;
const DISCORD_MESSAGE_LENGTH = 2000;
const URLS = /https?:\/\/[^\s<>)]+/g;
const THREAD_DELETED_NOTICE = 'The Discord thread for this topic was deleted; the next message here starts a new one.';

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
  resumeTimer?: NodeJS.Timeout;
};

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

const isHumanSender = (message: ZulipReceivedMessage) =>
  !isBotSender(message) && message.senderEmail.toLowerCase() !== EMAIL_GATEWAY;

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

/** Failed without an answer, or with a 5xx: the other side may still have carried the request out. */
const mayHaveBeenCarriedOut = (error: unknown) =>
  isMirrorError(error, 'unavailable') ||
  (error instanceof ZulipApiError ? error.status >= 500 : isZulipFailure(error) && !isConnectFailure(error));

const noneTurnedAway = (): TurnedAway => ({ discord: new Map(), zulip: new Set() });

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

/** Why the pair must be off with this channel, or `undefined`. */
const channelProblem = (pair: EnabledPair, channel: DiscordMirrorChannel | undefined) => {
  if (!channel || !Constants.Discord.Servers.includes(channel.guildId)) {
    return 'does not exist or is not in an Immich server';
  }
  if (channel.kind !== (pair.kind === 'text' ? 'text' : 'forum')) {
    return `is not a ${pair.kind === 'text' ? 'text channel' : 'forum'}`;
  }
  if (channel.categoryId === Constants.Discord.Categories.Team) {
    return 'is in the Team category';
  }
  if (channel.everyoneCanView && !pair.public) {
    return 'is visible to @everyone and the pair is not marked public';
  }
  return undefined;
};

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
  private verifiedConversations = new Set<string>();
  private throttled = new Map<string, number>();
  private failedCreates = new Map<string, number>();
  private emojiCodes?: Record<string, string>;
  private emojiRetryAt = 0;
  private emotes = new Map<string, { byName: Map<string, string>; expiresAt: number }>();
  private zulipRegistered = false;
  private channelCheck?: NodeJS.Timeout;

  constructor(
    @Inject(IZulipInterface) private zulip: IZulipInterface,
    @Inject(IDiscordMirrorInterface) private discordMirror: IDiscordMirrorInterface,
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    private zulipService: ZulipService,
  ) {}

  init() {
    const { bot, zulip } = getConfig();
    if (bot.token === 'dev' || zulip.bot.apiKey === 'dev' || zulip.user.apiKey === 'dev') {
      this.logger.log('The Discord-Zulip mirror is off: Discord or Zulip is not configured');
      return;
    }

    const { enabled, placeholders, problems, teamMembers } = validateMirrorConfig(
      Constants.Mirror.Pairs,
      Constants.Mirror.TeamMembers,
    );
    if (placeholders.length > 0) {
      this.logger.warn(
        `The Discord-Zulip mirror is off for ${placeholders.join(', ')} until their placeholder IDs in Constants.Mirror.Pairs are filled in`,
      );
    }
    for (const problem of problems) {
      this.logger.error(problem);
    }
    if (enabled.length === 0) {
      return;
    }

    this.realmOrigin = new URL(zulip.realm).origin;
    this.teamMembers = teamMembers;
    this.pairs = enabled.map((pair) => ({
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
    }));
    this.zulipService.onMessage((message) => this.onZulipMessage(message));
    this.zulipService.onMessageUpdate((update) => this.onZulipUpdate(update));
    this.zulipService.onMessagesDeleted((deletion) => this.onZulipDeletion(deletion));
    this.zulipService.onQueueRegistered((registration) => this.onZulipQueueRegistered(registration));
    this.channelCheck = setInterval(() => void this.recheckChannels(), CHANNEL_CHECK_MS);
    this.channelCheck.unref();
  }

  async onDiscordReady() {
    for (const state of this.pairs) {
      this.lostTrack(state);
    }
    for (const state of this.pairs) {
      try {
        await this.checkDiscordChannel(state);
      } catch (error) {
        this.fail(`${state.pair.key}: could not check Discord channel ${state.pair.discordChannelId}`, error);
      }
      this.maybeCatchUp(state);
      this.resume(state);
    }
  }

  handlesChannel(channelId: string) {
    return this.byChannel(channelId) !== undefined;
  }

  onDiscordMessage(dto: DiscordSourceMessage) {
    const state = this.byChannel(dto.channelId);
    state?.queue.push(`Discord message ${dto.id}`, () => this.mirrorDiscordMessage(state, dto));
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

  onDiscordThreadRenamed(thread: { channelId: string; threadId: string; name: string }) {
    const state = this.byChannel(thread.channelId);
    state?.queue.push(`rename of Discord thread ${thread.threadId}`, () => this.renameFromDiscord(state, thread));
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

  private onZulipMessage(message: ZulipReceivedMessage) {
    const state = message.type === 'stream' ? this.byStream(message.streamId) : undefined;
    if (state && isHumanSender(message) && !this.isCommand(message.content)) {
      state.queue.push(`Zulip message ${message.id}`, () => this.mirrorZulipMessage(state, message));
    }
  }

  private onZulipUpdate(update: ZulipMessageUpdated) {
    const state = this.byStream(update.streamId);
    if (!state) {
      return;
    }
    const { content, messageId } = update;
    if (content !== undefined) {
      state.queue.push(`edit of Zulip message ${messageId}`, () => this.editFromZulip(state, messageId, content));
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

  private onZulipQueueRegistered({ subscribedStreamIds }: { subscribedStreamIds: number[] }) {
    const subscribed = new Set(subscribedStreamIds);
    for (const { pair, status } of this.pairs) {
      if (status !== 'disabled' && !subscribed.has(pair.zulipStreamId)) {
        this.logger.warn(
          `${pair.key}: the Zulip bot is not subscribed to stream ${pair.zulipStreamId}, so nothing posted there is mirrored until an admin subscribes it`,
        );
      }
    }
    this.verifiedConversations.clear();
    this.zulipRegistered = true;
    for (const state of this.pairs) {
      this.lostTrack(state);
      this.maybeCatchUp(state);
      this.resume(state);
    }
  }

  private isCommand(content: string) {
    return parseCommand(content, this.zulipService.ownUser?.fullName ?? '').status !== 'ignored';
  }

  private async checkDiscordChannel(state: PairState) {
    const { pair } = state;
    const channel = await this.discordMirror.getMirrorChannel(pair.discordChannelId);
    const problem = channelProblem(pair, channel);
    if (!channel || problem) {
      state.status = 'disabled';
      this.logger.error(`${pair.key}: Discord channel ${pair.discordChannelId} ${problem}, so the pair is off`);
      return;
    }

    const missing = channel.missingPermissions;
    const blocking = missing.includes('ViewChannel') || missing.includes('ManageWebhooks');
    if (missing.length > 0) {
      this.logger.warn(
        `${pair.key}: the bot is missing ${missing.join(', ')} in Discord channel ${pair.discordChannelId}${blocking ? ', so the pair is off' : ''}`,
      );
    }
    if (blocking) {
      state.status = 'disabled';
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

    state.status = 'ready';
    if (!state.announced) {
      state.announced = true;
      const topic = pair.mainTopic === null ? '' : ` (main topic "${pair.mainTopic}")`;
      this.logger.log(
        `${pair.key}: mirroring Discord channel ${pair.discordChannelId} with Zulip stream ${pair.zulipStreamId}${topic}`,
      );
    }
  }

  /** Who can see a channel, and where it sits, can change without a new gateway session. */
  private async recheckChannels() {
    for (const state of this.pairs.filter((state) => this.discordReady(state))) {
      const { pair } = state;
      try {
        const problem = channelProblem(pair, await this.discordMirror.getMirrorChannel(pair.discordChannelId));
        if (problem) {
          state.status = 'disabled';
          this.logger.error(`${pair.key}: Discord channel ${pair.discordChannelId} ${problem}, so the pair is off`);
        }
      } catch (error) {
        this.fail(`${pair.key}: could not check Discord channel ${pair.discordChannelId}`, error);
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

  private lostTrack(state: PairState) {
    state.caughtUp = false;
    state.generation++;
  }

  private retryCatchUp(state: PairState) {
    if (state.retryTimer) {
      return;
    }
    const delay = state.retryDelayMs;
    state.retryDelayMs = Math.min(delay * 2, MAX_CATCH_UP_RETRY_MS);
    this.logger.log(`${state.pair.key}: catching up again in ${delay / 1000} seconds`);
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      this.maybeCatchUp(state);
    }, delay);
  }

  private async catchUp(state: PairState) {
    state.catchUpQueued = false;
    const { pair } = state;
    const generation = state.generation;
    const turnedAway = state.turnedAway;
    state.turnedAway = noneTurnedAway();
    try {
      const since = Date.now() - Constants.Mirror.CatchUpMaxAgeHours * HOUR;
      const discord = await this.missedOnDiscord(state, since, turnedAway.discord);
      const zulip = await this.missedOnZulip(state, since, turnedAway.zulip);
      if (state.generation !== generation) {
        this.turnAway(state, turnedAway);
        return;
      }
      this.queueMissed(state, generation, discord, zulip, since);
      if (!discord.complete || !zulip.complete) {
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
    discord: Missed<DiscordSourceMessage>,
    zulip: Missed<ZulipReceivedMessage>,
    since: number,
  ) {
    const { pair } = state;
    const recentDiscord = discord.messages.filter(({ createdTimestamp }) => createdTimestamp >= since);
    const recentZulip = zulip.messages.filter(({ timestamp }) => timestamp * 1000 >= since);
    const skipped = discord.messages.length - recentDiscord.length + zulip.messages.length - recentZulip.length;
    if (skipped > 0) {
      this.logger.log(
        `${pair.key}: catch-up skipped ${plural(skipped, 'message')} older than ${Constants.Mirror.CatchUpMaxAgeHours} hours`,
      );
    }
    if (recentDiscord.length + recentZulip.length > 0) {
      this.logger.log(
        `${pair.key}: catching up ${plural(recentDiscord.length, 'Discord message')} and ${plural(recentZulip.length, 'Zulip message')}`,
      );
    }
    state.caughtUp = discord.complete && zulip.complete;
    state.queue.pushNext([
      ...recentDiscord.map((dto) => ({
        label: `Discord message ${dto.id}`,
        run: () => this.mirrorDiscordMessage(state, dto, generation),
      })),
      ...recentZulip.map((message) => ({
        label: `Zulip message ${message.id}`,
        run: () => this.mirrorZulipMessage(state, message, generation),
      })),
    ]);
  }

  /**
   * Reads back from the newest message to the high-water mark or the start of the catch-up window. The marks count
   * Discord-origin rows only: a webhook copy posted while a Discord message was missed must not hide it.
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

    const windowStart = snowflakeAt(since);
    const missed: DiscordSourceMessage[] = [];
    let complete = true;
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

  /**
   * Reads back from the newest message to the high-water mark or the start of the catch-up window. The bot's own
   * posts are left out by the server, so they never use up the pages. Moved messages are left out too, unless they were
   * turned away here: they may have come from outside the mirror, which is never mirrored retroactively.
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
    const messages = found.filter(
      (message) =>
        message.type === 'stream' &&
        message.streamId === pair.zulipStreamId &&
        message.senderId !== self &&
        isHumanSender(message) &&
        !this.isCommand(message.content) &&
        (message.movedAt === undefined || turnedAway.has(message.id)),
    );
    return { messages, complete: true };
  }

  private discordReady(state: PairState) {
    return state.status === 'ready' && this.discordMirror.isReady();
  }

  private sideReady(state: PairState, side: Side) {
    return side === 'Discord' ? this.discordReady(state) : this.zulip.isInitialised();
  }

  /** Holds a change back, behind any held before it, until `side` is ready; `true` when it did. */
  private holdFor(state: PairState, side: Side, label: string, run: () => Promise<void>) {
    const held = state.held[side];
    if (held.length === 0 && this.sideReady(state, side)) {
      return false;
    }
    held.push({ label, run });
    if (this.throttle(`held:${state.pair.key}:${side}`, THROTTLE_MS)) {
      this.logger.warn(`${state.pair.key}: ${side} is not ready, so edits, deletions and renames wait until it is`);
    }
    this.resumeLater(state);
    return true;
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

  private createFailed(state: PairState, source: string, error: unknown, attempt: CreateAttempt, turnAway: () => void) {
    if (attempt.posted || attempt.uncertain) {
      this.failedCreates.set(source, MAX_CREATE_ATTEMPTS);
      return;
    }
    if (!isTransient(error)) {
      return;
    }
    const attempts = (this.failedCreates.get(source) ?? 0) + 1;
    this.failedCreates.set(source, attempts);
    if (attempts >= MAX_CREATE_ATTEMPTS) {
      this.logger.error(`${state.pair.key}: gave up on ${source} after ${attempts} attempts`);
      return;
    }
    turnAway();
    this.lostTrack(state);
    this.retryCatchUp(state);
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
    return { zulipUserByDiscordId: this.membersOf(dto.guildId).zulipByDiscord };
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
    const { Team, Immich } = Constants.Discord.Roles;
    const verified: DiscordTeamMember | undefined =
      member && (member.roleIds.includes(Team) || member.roleIds.includes(Immich)) ? member : undefined;
    const maps = this.membersOf(guildId);
    this.memberCheckedAt.set(`${guildId}:${zulipId}`, Date.now());
    if (verified) {
      maps.discordByZulip.set(zulipId, discordId);
      maps.zulipByDiscord.set(discordId, zulipId);
    } else {
      maps.discordByZulip.delete(zulipId);
      maps.zulipByDiscord.delete(discordId);
      if (this.throttle(`unverified:${zulipId}`, Infinity)) {
        this.logger.error(
          `Constants.Mirror.TeamMembers maps Zulip user ${zulipId} to Discord user ${discordId}, who is not in the guild or holds neither the Team nor the Immich role`,
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

    const fallback = { username: sanitiseWebhookUsername(sender.fullName, ' (Zulip)') };
    let identity: Identity = fallback;
    const discordId = this.teamMembers.get(sender.id);
    if (discordId === undefined) {
      if (this.throttle(`unmapped:${sender.id}`, Infinity)) {
        this.logger.warn(
          `Zulip user ${sender.id} is not in Constants.Mirror.TeamMembers; their messages appear on Discord as "Name (Zulip)"`,
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

  private async unicodeEmoji() {
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

  private async customEmotes(guildId: string) {
    const cached = this.emotes.get(guildId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.byName;
    }
    const byName = new Map<string, string>();
    try {
      for (const emote of (await this.discordMirror.getEmotes(guildId)) ?? []) {
        const name = toZulipEmojiName(emote.name ?? '');
        if (!byName.has(name)) {
          byName.set(name, emote.animated ? `<${emote.identifier}>` : `<:${emote.identifier}>`);
        }
      }
    } catch (error) {
      this.fail(`Could not list the Discord emotes of guild ${guildId}`, error);
      return byName;
    }
    this.emotes.set(guildId, { byName, expiresAt: Date.now() + HOUR });
    return byName;
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

    const needsEmoji = refs.emojiNames.length > 0;
    const unicode = needsEmoji ? await this.unicodeEmoji() : undefined;
    const custom = needsEmoji ? await this.customEmotes(guildId) : undefined;
    return toDiscordMirrorContent(raw, {
      realmOrigin: this.realmOrigin,
      messages,
      deletedMessageIds: new Set([...deleted].filter((id) => !messages.has(id))),
      discordUserByZulipId: this.membersOf(guildId).discordByZulip,
      emoji: (name) => custom?.get(name) ?? unicode?.[name],
      lateTimestamp,
    });
  }

  private async downloadUploads(
    state: PairState,
    messageId: number,
    { uploads: paths, spoilerUploads }: { uploads: string[]; spoilerUploads: string[] },
  ) {
    const files: File[] = [];
    const notes: Note[] = [];
    let total = 0;
    const deadline = transferDeadline();
    for (const [index, path] of paths.entries()) {
      const note = { name: uploadName(path), spoiler: spoilerUploads.includes(path) };
      if (index >= MAX_FILES || deadline.signal.aborted) {
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
    if ((await this.database.getMirrorMessagesByZulipIds([message.id], { withDeleted: true })).length > 0) {
      return;
    }
    this.senderNames.set(message.senderId, message.senderFullName);

    const attempt: CreateAttempt = { posted: false, uncertain: false };
    try {
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

  /** `undefined` for a topic that has no Discord thread yet. */
  private async conversationForZulip(state: PairState, message: ZulipReceivedMessage) {
    const { pair } = state;
    const key = topicKey(message.topic);
    const known = await this.database.getMirrorConversationByZulipTopic(pair.zulipStreamId, key);
    if (known) {
      return known;
    }
    if (isMainTopic(pair, key)) {
      return this.mainConversation(state);
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
    if (!existing) {
      const created = await this.database.createMirrorConversation({
        pair: pair.key,
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
    if (existing.zulipStreamId === pair.zulipStreamId && existing.zulipTopic === zulipTopic) {
      return existing;
    }
    const changes = { zulipStreamId: pair.zulipStreamId, zulipTopic, zulipTopicKey };
    await this.database.updateMirrorConversation(existing.id, changes);
    return { ...existing, ...changes };
  }

  private async createThreadConversation(state: PairState, threadId: string, zulipTopic: string, anchor: number) {
    const { pair } = state;
    const conversation = await this.database.createMirrorConversation({
      pair: pair.key,
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
      const dropped = files.map(({ name }) => ({
        name: name.startsWith(SPOILER_FILE) ? name.slice(SPOILER_FILE.length) : name,
        spoiler: name.startsWith(SPOILER_FILE),
      }));
      parts = withNotes(outgoing.text, [...outgoing.notes, ...dropped]);
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

  private async editFromZulip(state: PairState, messageId: number, content: string) {
    const { pair } = state;
    const all = (await this.database.getMirrorMessagesByZulipIds([messageId], { withDeleted: true })).filter(
      ({ origin }) => origin === 'zulip',
    );
    const rows = all.filter(({ deletedAt }) => deletedAt === null);
    const hash = sha256(content);
    if (
      rows.length === 0 ||
      this.holdFor(state, 'Discord', `edit of Zulip message ${messageId}`, () =>
        this.editFromZulip(state, messageId, content),
      ) ||
      rows[0].sourceHash === hash
    ) {
      return;
    }

    const rendered = await this.renderForDiscord(state, content);
    if (rendered.uploads.length > 0) {
      this.logger.log(
        `${pair.key}: Zulip message ${messageId} was edited; its Discord copy keeps the files it was sent with`,
      );
    }
    let parts = splitDiscordContent(rendered.text);
    if (parts.length === 0) {
      parts = [''];
    }

    const kept: MirrorMessage[] = [];
    for (const row of rows) {
      try {
        if (row.part < parts.length) {
          const edit = { content: parts[row.part], suppressEmbeds: suppressEmbeds(parts[row.part]) };
          await this.onDiscord(state, row.discordThreadId, () =>
            this.discordMirror.editMirrorMessage(toTarget(row), edit),
          );
          kept.push(row);
        } else if (row.part > 0) {
          await this.onDiscord(state, row.discordThreadId, () => this.discordMirror.deleteMirrorMessage(toTarget(row)));
          await this.database.removeMirrorMessages([row.discordMessageId]);
        }
      } catch (error) {
        await this.discordEditFailed(state, row, error);
        if (!isMirrorError(error, 'unknown-message')) {
          kept.push(row);
        }
      }
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

  private async discordEditFailed(state: PairState, row: MirrorMessage, error: unknown) {
    const { key } = state.pair;
    const about = `Discord message ${row.discordMessageId} (the copy of Zulip message ${row.zulipMessageId})`;
    if (isMirrorError(error, 'unknown-message')) {
      await this.database.markMirrorMessagesDeleted([row.discordMessageId]);
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

  private async deleteOnDiscord(state: PairState, rows: MirrorMessage[]) {
    const label = `deletion of Discord messages ${rows.map(({ discordMessageId }) => discordMessageId).join(', ')}`;
    if (rows.length === 0 || this.holdFor(state, 'Discord', label, () => this.deleteOnDiscord(state, rows))) {
      return;
    }
    for (const row of rows) {
      try {
        await this.onDiscord(state, row.discordThreadId, () => this.discordMirror.deleteMirrorMessage(toTarget(row)));
      } catch (error) {
        if (!isMirrorError(error, 'unknown-message')) {
          this.fail(
            `${state.pair.key}: could not delete Discord message ${row.discordMessageId} (the copy of Zulip message ${row.zulipMessageId})`,
            error,
          );
        }
      }
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

  /** A conversation whose anchor is gone moves to its newest remaining message; without one, the next message is. */
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
    const topic = found.topic || EMPTY_TOPIC_NAME;
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

  private async mirrorDiscordMessage(state: PairState, dto: DiscordSourceMessage, generation?: number) {
    const { pair } = state;
    const turnAway = () =>
      this.turnAway(state, { discord: new Map([[dto.threadId ?? dto.channelId, BigInt(dto.id)]]), zulip: new Set() });
    if (!this.zulip.isInitialised()) {
      turnAway();
      this.notReady(state, 'Zulip');
      return;
    }
    const source = `Discord message ${dto.id}`;
    if (!this.mayCreate(state, source, generation, turnAway)) {
      return;
    }
    if ((await this.database.getMirrorMessagesByDiscordIds([dto.id], { withDeleted: true })).length > 0) {
      return;
    }

    const attempt: CreateAttempt = { posted: false, uncertain: false };
    try {
      let conversation: MirrorConversation | undefined;
      if (dto.threadId === null) {
        if (pair.mainTopic === null) {
          return;
        }
        conversation = await this.mainConversation(state);
      } else {
        const found = await this.database.getMirrorConversationByDiscord(pair.discordChannelId, dto.threadId);
        conversation = found && (await this.verifyConversation(state, found));
      }

      const ctx = await this.renderContext(dto);
      const body = toZulipMirrorBody(dto, ctx);
      if (body.trim() === '' && dto.attachments.length === 0) {
        return;
      }
      const topic =
        conversation?.zulipTopic ??
        (await this.claimTopic(state, toZulipTopicName(dto.threadName ?? '', dto.threadId!), dto.threadId!));
      if (topic === undefined) {
        this.logger.error(`${pair.key}: found no free Zulip topic for Discord thread ${dto.threadId}`);
        return;
      }

      const reply = await this.replyTarget(dto, topic);
      const late = Date.now() - dto.createdTimestamp > LATE_MS;
      const header = zulipAuthorHeader(dto, { ...ctx, reply, late });
      const lead = zulipMirrorLead(header, dto.replyTo?.content ? toZulipReplySnippet(dto.replyTo.content, ctx) : null);
      const attachments = toZulipAttachmentLines(await this.uploadAttachments(state, dto), dto.jumpUrl);
      if (body.trim() === '' && attachments === '') {
        return;
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
      this.created(state, source);
    } catch (error) {
      this.createFailed(state, source, error, attempt, turnAway);
      this.fail(`${pair.key}: could not mirror Discord message ${dto.id} to Zulip`, error);
    }
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
      toZulipMirrorBody(dto, await this.renderContext(dto)),
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

  private async renameFromDiscord(state: PairState, thread: { threadId: string; name: string }) {
    const { pair } = state;
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
    const target = await this.claimTopic(
      state,
      toZulipTopicName(unresolveTopic(thread.name), thread.threadId),
      thread.threadId,
      { exclude: conversation.id, prefix: isResolvedTopic(current) ? ZULIP_RESOLVED_PREFIX : '' },
    );
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

  private async threadDeleted(state: PairState, threadId: string) {
    const { pair } = state;
    const conversation = await this.database.getMirrorConversationByDiscord(pair.discordChannelId, threadId);
    if (!conversation) {
      return;
    }
    await this.detach(state, conversation, 'the Discord thread was deleted');
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
