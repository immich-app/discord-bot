import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { getConfig } from 'src/config';
import { Constants } from 'src/constants';
import { isResolvedTopic, plural, unresolveTopic, ZULIP_RESOLVED_PREFIX, zulipNarrowLink } from 'src/format';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import {
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
  sanitiseWebhookUsername,
  toDiscordThreadName,
  topicCandidates,
  topicKey,
  toZulipTopicName,
} from 'src/mirror/names';
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
const DISCORD_EPOCH = 1_420_070_400_000n;
const ACTIVE_THREAD_DAYS = 7;
const ACTIVE_THREAD_LIMIT = 20;
const MAX_FILES = 10;
const MAX_TOTAL_FILE_BYTES = 24 * 1024 * 1024;
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
  webhookRecreatedAt?: number;
  catchUpQueued: boolean;
  /** Live creates wait until catch-up has run: mirroring one first would move the high-water mark past what was missed. */
  caughtUp: boolean;
  /** Changes whenever the mirror may have missed something, which makes a catch-up already read out of date. */
  generation: number;
  retryTimer?: NodeJS.Timeout;
  retryDelayMs: number;
};

type Missed<T> = { messages: T[]; complete: boolean };

type Identity = { username: string; avatarUrl?: string };

type TeamMemberMaps = { discordByZulip: Map<number, string>; zulipByDiscord: Map<string, number> };

type OutgoingZulipMessage = {
  text: string;
  pingUserIds: string[];
  files: File[];
  notes: string[];
  identity: Identity;
};

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

const isTransient = (error: unknown) => isTransientZulipFailure(error) || isMirrorError(error, 'unavailable');

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

const noteLine = (name: string) => `*(attachment not mirrored: ${escapeDiscordInline(name)})*`;

/** The notes about files that could not be attached go on part 0, next to the files that could. */
const withNotes = (text: string, noteNames: string[]) => {
  const notes = noteNames.map(noteLine).join('\n');
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
  private identities = new Map<string, { identity: Identity; expiresAt: number }>();
  private senderNames = new Map<number, string>();
  private verifiedConversations = new Set<string>();
  private throttled = new Map<string, number>();
  private failedCreates = new Map<string, number>();
  private emojiCodes?: Record<string, string>;
  private emojiRetryAt = 0;
  private emotes = new Map<string, { byName: Map<string, string>; expiresAt: number }>();
  private zulipRegistered = false;

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
      catchUpQueued: false,
      caughtUp: false,
      generation: 0,
      retryDelayMs: CATCH_UP_RETRY_MS,
    }));
    this.zulipService.onMessage((message) => this.onZulipMessage(message));
    this.zulipService.onMessageUpdate((update) => this.onZulipUpdate(update));
    this.zulipService.onMessagesDeleted((deletion) => this.onZulipDeletion(deletion));
    this.zulipService.onQueueRegistered((registration) => this.onZulipQueueRegistered(registration));
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
    for (const state of this.pairs) {
      state.queue.close();
      clearTimeout(state.retryTimer);
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
    if (state && !this.isCommand(message.content)) {
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
    const state = this.byStream(streamId);
    if (state && messageIds.length > 0) {
      state.queue.push(`deletion of Zulip messages ${messageIds.join(', ')}`, () =>
        this.deleteFromZulip(state, messageIds),
      );
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
    }
  }

  private isCommand(content: string) {
    return parseCommand(content, this.zulipService.ownUser?.fullName ?? '').status !== 'ignored';
  }

  private async checkDiscordChannel(state: PairState) {
    const { pair } = state;
    const channel = await this.discordMirror.getMirrorChannel(pair.discordChannelId);
    const expected = pair.kind === 'text' ? 'text' : 'forum';
    let problem: string | undefined;
    if (!channel || !Constants.Discord.Servers.includes(channel.guildId)) {
      problem = 'does not exist or is not in an Immich server';
    } else if (channel.kind !== expected) {
      problem = `is not a ${pair.kind === 'text' ? 'text channel' : 'forum'}`;
    } else if (channel.categoryId === Constants.Discord.Categories.Team) {
      problem = 'is in the Team category';
    } else if (channel.everyoneCanView && !pair.public) {
      problem = 'is visible to @everyone and the pair is not marked public';
    }
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

  /** Queues what was missed while either side was away, through the normal create path, right after this op. */
  private async catchUp(state: PairState) {
    state.catchUpQueued = false;
    const { pair } = state;
    const generation = state.generation;
    const since = Date.now() - Constants.Mirror.CatchUpMaxAgeHours * HOUR;
    const discord = await this.missedOnDiscord(state, since);
    const zulip = await this.missedOnZulip(state, since);
    if (state.generation !== generation) {
      return;
    }

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
    if (discord.complete && zulip.complete) {
      state.caughtUp = true;
    } else {
      this.retryCatchUp(state);
    }
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
  private async missedOnDiscord(state: PairState, since: number): Promise<Missed<DiscordSourceMessage>> {
    const { pair } = state;
    const locations: { channelId: string; after: string; thread?: MirrorConversation }[] = [];
    const mainHighWater =
      pair.kind === 'text' ? await this.database.getMirrorDiscordHighWater(pair.discordChannelId, null) : undefined;
    if (mainHighWater !== undefined) {
      locations.push({ channelId: pair.discordChannelId, after: mainHighWater });
    }
    const active = new Date(Date.now() - ACTIVE_THREAD_DAYS * DAY);
    for (const thread of await this.database.getActiveMirrorThreads(
      pair.discordChannelId,
      active,
      ACTIVE_THREAD_LIMIT,
    )) {
      const threadId = thread.discordThreadId!;
      const highWater = await this.database.getMirrorDiscordHighWater(pair.discordChannelId, threadId);
      locations.push({ channelId: threadId, after: highWater ?? threadId, thread });
    }

    const windowStart = snowflakeAt(since);
    const missed: DiscordSourceMessage[] = [];
    let complete = true;
    for (const { channelId, after, thread } of locations) {
      const highWater = BigInt(after);
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
        if (thread && isMirrorError(error, 'unknown-channel')) {
          await this.detach(state, thread, 'the Discord thread no longer exists');
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
   * posts are left out by the server, so they never use up the pages. Moved messages are left out too: they may have
   * come from outside the mirror, which is never mirrored retroactively.
   */
  private async missedOnZulip(state: PairState, since: number): Promise<Missed<ZulipReceivedMessage>> {
    const { pair } = state;
    const highWater = await this.database.getMirrorZulipHighWater(pair.zulipStreamId);
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
        !isBotSender(message) &&
        !this.isCommand(message.content) &&
        message.movedAt === undefined,
    );
    return { messages, complete: true };
  }

  private discordReady(state: PairState) {
    return state.status === 'ready' && this.discordMirror.isReady();
  }

  private notReady(state: PairState, side: 'Discord' | 'Zulip') {
    if (this.throttle(`not-ready:${state.pair.key}`, THROTTLE_MS)) {
      this.logger.warn(
        `${state.pair.key}: not mirroring yet: ${side} is not ready; catch-up picks it up once both sides are`,
      );
    }
  }

  /**
   * `generation` is set for the creates a catch-up queues, which only run while that catch-up is the current one. A
   * message that keeps failing is given up on, so that it cannot hold the pair back until it leaves the window.
   */
  private mayCreate(state: PairState, source: string, generation: number | undefined) {
    if ((this.failedCreates.get(source) ?? 0) >= MAX_CREATE_ATTEMPTS) {
      return false;
    }
    if (generation !== undefined) {
      return generation === state.generation;
    }
    if (!state.caughtUp && this.throttle(`not-ready:${state.pair.key}`, THROTTLE_MS)) {
      this.logger.warn(`${state.pair.key}: not mirroring yet: catch-up has to run first, and picks it up`);
    }
    return state.caughtUp;
  }

  private created(state: PairState, source: string) {
    state.retryDelayMs = CATCH_UP_RETRY_MS;
    this.failedCreates.delete(source);
  }

  private createFailed(state: PairState, source: string, error: unknown) {
    if (!isTransient(error)) {
      return;
    }
    const attempts = (this.failedCreates.get(source) ?? 0) + 1;
    this.failedCreates.set(source, attempts);
    if (attempts >= MAX_CREATE_ATTEMPTS) {
      this.logger.error(`${state.pair.key}: gave up on ${source} after ${attempts} attempts`);
      return;
    }
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

  /** Recreates a deleted webhook and unarchives an archived thread, each at most once, then repeats the call. */
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
    const now = Date.now();
    if (state.webhookRecreatedAt !== undefined && now - state.webhookRecreatedAt < HOUR) {
      return false;
    }
    state.webhookRecreatedAt = now;
    await this.discordMirror.ensureMirrorWebhook(state.pair.discordChannelId);
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

  private renderContext(guildId: string): DiscordRenderContext {
    return { zulipUserByDiscordId: this.membersOf(guildId).zulipByDiscord };
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
          byName.set(name, `<${emote.identifier}>`);
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
    for (const row of await this.database.getMirrorMessagesByZulipIds(refs.messageIds)) {
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
      discordUserByZulipId: this.membersOf(guildId).discordByZulip,
      emoji: (name) => custom?.get(name) ?? unicode?.[name],
      lateTimestamp,
    });
  }

  private async downloadUploads(state: PairState, messageId: number, paths: string[]) {
    const files: File[] = [];
    const notes: string[] = [];
    let total = 0;
    for (const [index, path] of paths.entries()) {
      const name = uploadName(path);
      if (index >= MAX_FILES) {
        notes.push(name);
        continue;
      }
      try {
        const file = await this.zulip.downloadUpload(path, Constants.Mirror.MaxFileBytes);
        if (file && total + file.size <= MAX_TOTAL_FILE_BYTES) {
          total += file.size;
          files.push(file);
        } else {
          notes.push(name);
        }
      } catch (error) {
        notes.push(name);
        this.logger.warn(
          `${state.pair.key}: could not download upload ${index + 1} of Zulip message ${messageId}: ${describe(error)}`,
        );
      }
    }
    return { files, notes };
  }

  private async mirrorZulipMessage(state: PairState, message: ZulipReceivedMessage, generation?: number) {
    if (!this.discordReady(state)) {
      this.notReady(state, 'Discord');
      return;
    }
    const source = `Zulip message ${message.id}`;
    if (!this.mayCreate(state, source, generation)) {
      return;
    }
    if ((await this.database.getMirrorMessagesByZulipIds([message.id], { withDeleted: true })).length > 0) {
      return;
    }
    this.senderNames.set(message.senderId, message.senderFullName);

    try {
      const conversation = await this.conversationForZulip(state, message);
      const late = message.timestamp > 0 && Date.now() - message.timestamp * 1000 > LATE_MS;
      const rendered = await this.renderForDiscord(state, message.content, late ? message.timestamp : undefined);
      const outgoing: OutgoingZulipMessage = {
        text: rendered.text,
        pingUserIds: rendered.pingUserIds,
        ...(await this.downloadUploads(state, message.id, rendered.uploads)),
        identity: await this.resolveIdentity(
          { id: message.senderId, fullName: message.senderFullName },
          state.guildId!,
        ),
      };
      try {
        await this.deliverToDiscord(state, message, outgoing, conversation);
      } catch (error) {
        if (!conversation?.discordThreadId || !isMirrorError(error, 'unknown-channel')) {
          throw error;
        }
        await this.database.removeMirrorConversation(conversation.id);
        this.logger.log(
          `${state.pair.key}: Discord thread ${conversation.discordThreadId} no longer exists, so its Zulip topic starts a new one`,
        );
        await this.deliverToDiscord(state, message, outgoing, undefined);
      }
      this.created(state, source);
    } catch (error) {
      this.createFailed(state, source, error);
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
      return streamId === state.pair.zulipStreamId && topic !== '' && topicKey(topic) === key;
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
        this.discordMirror.sendMirrorMessage({
          channelId: pair.discordChannelId,
          username: outgoing.identity.username,
          avatarUrl: outgoing.identity.avatarUrl,
          content,
          pingUserIds: [],
          suppressEmbeds: suppressEmbeds(content),
          ...options,
        }),
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
      parts = withNotes(outgoing.text, [...outgoing.notes, ...files.map(({ name }) => name)]);
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
    if (rows.length === 0 || rows[0].sourceHash === hash) {
      return;
    }
    if (!this.discordReady(state)) {
      this.notReady(state, 'Discord');
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
      { id: senderId, fullName: this.senderNames.get(senderId) ?? '' },
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

  private async deleteFromZulip(state: PairState, messageIds: number[]) {
    const { pair } = state;
    const rows = await this.database.getMirrorMessagesByZulipIds(messageIds);
    const vanished = await this.vanishedConversations(state, messageIds);
    await this.database.markMirrorMessagesDeleted(rows.map(({ discordMessageId }) => discordMessageId));
    for (const conversation of vanished) {
      await this.database.removeMirrorConversation(conversation.id);
      this.logger.warn(
        `${pair.key}: Zulip removed every mirrored message of the topic of Discord thread ${conversation.discordThreadId}, as it does when the topic moves to a stream the bot cannot read; detached the thread and left its Discord copies alone (delete them there by hand if the topic was deleted)`,
      );
    }

    const cutoff = Date.now() - Constants.Mirror.DeleteSyncMaxAgeDays * DAY;
    const gone = new Set(vanished.map(({ id }) => id));
    const copies = rows.filter(
      ({ origin, conversationId }) => origin === 'zulip' && (conversationId === null || !gone.has(conversationId)),
    );
    const old = copies.filter(({ createdAt }) => createdAt.getTime() < cutoff);
    const young = copies.filter(({ createdAt }) => createdAt.getTime() >= cutoff);
    if (old.length > 0) {
      const count = new Set(old.map(({ zulipMessageId }) => zulipMessageId)).size;
      this.logger.warn(
        `${pair.key}: Zulip deleted ${plural(count, 'mirrored message')} older than ${Constants.Mirror.DeleteSyncMaxAgeDays} days; not deleting their Discord copies (Discord messages ${old.map(({ discordMessageId }) => discordMessageId).join(', ')}); delete them there by hand if this was intended`,
      );
    }
    if (young.length > 0 && !this.discordReady(state)) {
      this.notReady(state, 'Discord');
    } else {
      for (const row of young) {
        try {
          await this.onDiscord(state, row.discordThreadId, () => this.discordMirror.deleteMirrorMessage(toTarget(row)));
        } catch (error) {
          if (!isMirrorError(error, 'unknown-message')) {
            this.fail(
              `${pair.key}: could not delete Discord message ${row.discordMessageId} (the copy of Zulip message ${row.zulipMessageId})`,
              error,
            );
          }
        }
      }
    }

    await this.reanchor(state, messageIds);
  }

  /**
   * Zulip tells a bot about a topic that moves to a stream the bot cannot read only by deleting its messages, so a
   * deletion that takes a thread's anchor and every other mirrored message of the thread may well be such a move.
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
      const threadId = conversation.discordThreadId!;
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
      if (name === toDiscordThreadName(previous)) {
        continue;
      }
      if (!this.discordReady(state)) {
        this.notReady(state, 'Discord');
        continue;
      }
      try {
        await this.onDiscord(state, threadId, () => this.discordMirror.renameMirrorThread(threadId, name));
      } catch (error) {
        if (isMirrorError(error, 'unknown-channel')) {
          await this.detach(state, conversation, 'the Discord thread no longer exists');
        } else {
          this.logger.warn(
            `${pair.key}: could not rename Discord thread ${threadId} after its Zulip topic moved: ${describe(error)}`,
          );
        }
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
    const { topic } = found;
    if (topic !== '' && topic !== conversation.zulipTopic) {
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
    if (!this.zulip.isInitialised()) {
      this.notReady(state, 'Zulip');
      return;
    }
    const source = `Discord message ${dto.id}`;
    if (!this.mayCreate(state, source, generation)) {
      return;
    }
    if ((await this.database.getMirrorMessagesByDiscordIds([dto.id], { withDeleted: true })).length > 0) {
      return;
    }

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

      const ctx = this.renderContext(dto.guildId);
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

      const { id } = await this.zulip.sendMessage({
        stream: pair.zulipStreamId,
        topic,
        content: zulipMirrorContent(lead, body, attachments),
      });
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
      this.createFailed(state, source, error);
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
    for (const [index, attachment] of dto.attachments.entries()) {
      let url: string | null = null;
      if (index < MAX_FILES && attachment.size <= Constants.Mirror.MaxUploadBytes) {
        try {
          const file = await downloadDiscordAttachment(attachment, Constants.Mirror.MaxUploadBytes);
          url = file ? (await this.zulip.uploadFile(file)).url : null;
        } catch (error) {
          this.logger.warn(
            `${state.pair.key}: could not mirror attachment ${attachment.id} of Discord message ${dto.id}: ${describe(error)}`,
          );
        }
      }
      results.push({ name: attachment.name, spoiler: attachment.spoiler, url });
    }
    return results;
  }

  private async editFromDiscord(state: PairState, dto: DiscordSourceMessage) {
    const { pair } = state;
    const row = (await this.database.getMirrorMessagesByDiscordIds([dto.id])).find(
      ({ origin }) => origin === 'discord',
    );
    const hash = discordSourceHash(dto);
    if (!row || row.sourceHash === hash) {
      return;
    }
    if (!this.zulip.isInitialised()) {
      this.notReady(state, 'Zulip');
      return;
    }

    const content = zulipMirrorContent(
      row.zulipHeader ?? '',
      toZulipMirrorBody(dto, this.renderContext(dto.guildId)),
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
    const { pair } = state;
    for (const row of await this.database.getMirrorMessagesByDiscordIds(messageIds)) {
      // Marked first: Zulip reports the bot's own deletion back as an event, which must find nothing.
      await this.database.markMirrorMessagesDeleted([row.discordMessageId]);
      if (row.origin === 'zulip') {
        continue;
      }
      if (!this.zulip.isInitialised()) {
        this.notReady(state, 'Zulip');
        continue;
      }
      const about = `message ${row.zulipMessageId} (the copy of Discord message ${row.discordMessageId})`;
      try {
        await this.retryZulip(() => this.zulip.deleteMessage(row.zulipMessageId));
      } catch (error) {
        if (isZulipRefusal(error)) {
          this.logger.warn(
            `${pair.key}: Zulip refused to delete ${about}; add the bot to the stream's can_delete_any_message_group`,
          );
          continue;
        }
        if (!isZulipMessageGone(error)) {
          this.fail(`${pair.key}: could not delete Zulip ${about}`, error);
          continue;
        }
      }
      await this.reanchor(state, [row.zulipMessageId]);
    }
  }

  private async renameFromDiscord(state: PairState, thread: { threadId: string; name: string }) {
    const { pair } = state;
    if (!this.zulip.isInitialised()) {
      this.notReady(state, 'Zulip');
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
    if (!this.zulip.isInitialised()) {
      this.notReady(state, 'Zulip');
      return;
    }
    try {
      await this.zulip.sendMessage({
        stream: pair.zulipStreamId,
        topic: conversation.zulipTopic,
        content: THREAD_DELETED_NOTICE,
      });
    } catch (error) {
      this.fail(`${pair.key}: could not post the thread deletion notice in Zulip stream ${pair.zulipStreamId}`, error);
    }
  }
}
