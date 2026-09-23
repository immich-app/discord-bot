import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Constants } from 'src/constants';
import { IDatabaseRepository, MirrorMessageQuery } from 'src/interfaces/database.interface';
import {
  DiscordMirrorChannel,
  DiscordMirrorError,
  DiscordMirrorPage,
  DiscordMirrorSend,
  DiscordSourceMessage,
  IDiscordMirrorInterface,
} from 'src/interfaces/discord-mirror.interface';
import {
  IZulipInterface,
  ZulipMessagesDeleted,
  ZulipMessageUpdated,
  ZulipReceivedMessage,
} from 'src/interfaces/zulip.interface';
import { discordSourceHash } from 'src/mirror/discord-to-zulip';
import { downloadDiscordAttachment } from 'src/mirror/download';
import { toDiscordThreadName } from 'src/mirror/names';
import { ZulipApiError } from 'src/repositories/zulip.client';
import {
  MirrorConversation,
  MirrorIdentity,
  MirrorLink,
  MirrorMessage,
  NewMirrorConversation,
  NewMirrorMessage,
  UpdateMirrorConversation,
  UpdateMirrorMessage,
} from 'src/schema';
import { MirrorService } from 'src/services/mirror.service';
import {
  ZulipDeletionHandler,
  ZulipMessageHandler,
  ZulipReactionHandler,
  ZulipRegistrationHandler,
  ZulipService,
  ZulipUpdateHandler,
} from 'src/services/zulip.service';
import { afterEach, beforeEach, describe, expect, it, Mocked, vitest } from 'vitest';

const { config } = vitest.hoisted(() => ({
  config: {
    bot: { token: 'bot-token' },
    zulip: {
      bot: { username: 'bot@example.com', apiKey: 'bot-key' },
      user: { username: 'human@example.com', apiKey: 'user-key' },
      realm: 'https://zulip.example.com',
    },
  },
}));

vitest.mock('src/config', () => ({ getConfig: () => config }));

vitest.mock('src/mirror/download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/mirror/download')>()),
  downloadDiscordAttachment: vitest.fn(),
}));

const GUILD = Constants.Discord.Servers[0];
const DEV_CHANNEL = '100000000000000001';
const OFF_TOPIC_CHANNEL = '100000000000000002';
const FORUM = Constants.Discord.Channels.DevFocusTopic;
const DEV_STREAM = 900;
const OFF_TOPIC_STREAM = 901;
const FORUM_STREAM = 902;
const WEBHOOK = '700000000000000001';
const BOT = { userId: 1, fullName: 'Immich Bot' };
const TEAM_ZULIP_ID = 12;
const TEAM_DISCORD_ID = '400000000000000012';
const CONTRIBUTOR = '400000000000000099';
const TEAM_MEMBER = {
  displayName: 'Alex',
  avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png',
  roleIds: [GUILD, Constants.Discord.Roles.Team],
};
const UPLOAD_URL = '/user_uploads/2/ab/cdefghijklmnopqrstuvwxyz/upload.txt';
const DAY = 24 * 60 * 60 * 1000;

type MirrorMethods =
  | 'getMirrorConversation'
  | 'getMirrorConversationByDiscord'
  | 'getMirrorConversationByZulipTopic'
  | 'getMirrorConversationsByAnchors'
  | 'getActiveMirrorThreads'
  | 'createMirrorConversation'
  | 'updateMirrorConversation'
  | 'removeMirrorConversation'
  | 'createMirrorMessages'
  | 'getMirrorMessagesByDiscordIds'
  | 'getMirrorMessagesByZulipIds'
  | 'getMirrorMessagesByConversation'
  | 'getRecentMirrorMessages'
  | 'getNewestMirrorZulipMessageId'
  | 'updateMirrorMessages'
  | 'markMirrorMessagesDeleted'
  | 'removeMirrorMessages'
  | 'getMirrorZulipHighWater'
  | 'getMirrorDiscordHighWater'
  | 'getMirrorLinks'
  | 'getMirrorIdentities';

const link = (overrides: Partial<MirrorLink> & Pick<MirrorLink, 'discordChannelId' | 'zulipStreamId'>): MirrorLink => ({
  kind: 'text',
  mainTopic: null,
  createdBy: 'Alex (Discord user 400000000000000012)',
  discordAnnouncementId: null,
  createdAt: new Date(0),
  ...overrides,
});

const newMirrorDatabase = () => {
  const links: MirrorLink[] = [
    link({ discordChannelId: DEV_CHANNEL, zulipStreamId: DEV_STREAM, mainTopic: '#dev' }),
    link({ discordChannelId: OFF_TOPIC_CHANNEL, zulipStreamId: OFF_TOPIC_STREAM, mainTopic: '#dev-off-topic' }),
    link({ discordChannelId: FORUM, zulipStreamId: FORUM_STREAM, kind: 'forum' }),
  ];
  const identities: MirrorIdentity[] = [
    { zulipUserId: TEAM_ZULIP_ID, discordUserId: TEAM_DISCORD_ID, createdAt: new Date(0) },
  ];
  const conversations: MirrorConversation[] = [];
  const messages: MirrorMessage[] = [];
  let sequence = 0;
  const conversation = (id: string) => conversations.find((row) => row.id === id);
  const copy = <T extends object>(row: T | undefined) => (row ? { ...row } : undefined);
  const visible = (options?: MirrorMessageQuery) => (row: MirrorMessage) =>
    options?.withDeleted === true || row.deletedAt === null;

  const repository: Mocked<Pick<IDatabaseRepository, MirrorMethods>> = {
    getMirrorConversation: vitest.fn(async (id: string) => copy(conversation(id))),
    getMirrorConversationByDiscord: vitest.fn(async (channelId: string, threadId: string | null) =>
      copy(conversations.find((row) => row.discordChannelId === channelId && row.discordThreadId === threadId)),
    ),
    getMirrorConversationByZulipTopic: vitest.fn(async (streamId: number, key: string) =>
      copy(conversations.find((row) => row.zulipStreamId === streamId && row.zulipTopicKey === key)),
    ),
    getMirrorConversationsByAnchors: vitest.fn(async (ids: number[]) =>
      conversations
        .filter((row) => row.zulipAnchorMessageId !== null && ids.includes(row.zulipAnchorMessageId))
        .map((row) => ({ ...row })),
    ),
    getActiveMirrorThreads: vitest.fn(async (channelId: string, since: Date, limit: number) =>
      conversations
        .filter(
          (row) =>
            row.discordChannelId === channelId &&
            row.discordThreadId !== null &&
            messages.some(({ conversationId, createdAt }) => conversationId === row.id && createdAt >= since),
        )
        .slice(0, limit)
        .map((row) => ({ ...row })),
    ),
    createMirrorConversation: vitest.fn(async (entity: NewMirrorConversation) => {
      const threadId = entity.discordThreadId ?? null;
      if (
        conversations.some(
          (row) =>
            (row.zulipStreamId === entity.zulipStreamId && row.zulipTopicKey === entity.zulipTopicKey) ||
            (row.discordChannelId === entity.discordChannelId && row.discordThreadId === threadId),
        )
      ) {
        throw new Error('duplicate key value violates unique constraint');
      }
      const created = {
        id: `conversation-${++sequence}`,
        zulipAnchorMessageId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...entity,
        discordThreadId: threadId,
      } as MirrorConversation;
      conversations.push(created);
      return { ...created };
    }),
    updateMirrorConversation: vitest.fn(async (id: string, changes: UpdateMirrorConversation) => {
      const row = conversation(id)!;
      const updated = { ...row, ...changes };
      if (
        conversations.some(
          (other) =>
            other !== row &&
            ((other.zulipStreamId === updated.zulipStreamId && other.zulipTopicKey === updated.zulipTopicKey) ||
              (other.discordChannelId === updated.discordChannelId &&
                other.discordThreadId === updated.discordThreadId)),
        )
      ) {
        throw new Error('duplicate key value violates unique constraint');
      }
      Object.assign(row, changes);
    }),
    removeMirrorConversation: vitest.fn(async (id: string) => {
      conversations.splice(conversations.indexOf(conversation(id)!), 1);
      for (const message of messages.filter(({ conversationId }) => conversationId === id)) {
        message.conversationId = null;
      }
    }),
    createMirrorMessages: vitest.fn(async (rows: NewMirrorMessage[]) => {
      for (const row of rows) {
        const part = row.part ?? 0;
        if (
          messages.some(
            (message) =>
              message.discordMessageId === row.discordMessageId ||
              (message.zulipMessageId === row.zulipMessageId && message.part === part),
          )
        ) {
          throw new Error('duplicate key value violates unique constraint');
        }
        messages.push({ createdAt: new Date(), deletedAt: null, ...row, part } as MirrorMessage);
      }
    }),
    getMirrorMessagesByDiscordIds: vitest.fn(async (ids: string[], options?: MirrorMessageQuery) =>
      messages
        .filter(visible(options))
        .filter(({ discordMessageId }) => ids.includes(discordMessageId))
        .map((row) => ({ ...row })),
    ),
    getMirrorMessagesByZulipIds: vitest.fn(async (ids: number[], options?: MirrorMessageQuery) =>
      messages
        .filter(visible(options))
        .filter(({ zulipMessageId }) => ids.includes(zulipMessageId))
        .sort((a, b) => a.zulipMessageId - b.zulipMessageId || a.part - b.part)
        .map((row) => ({ ...row })),
    ),
    getMirrorMessagesByConversation: vitest.fn(async (id: string) =>
      messages
        .filter(visible())
        .filter(({ conversationId }) => conversationId === id)
        .map((row) => ({ ...row })),
    ),
    getRecentMirrorMessages: vitest.fn(async (channelId: string, since: Date, limit: number) =>
      messages
        .filter(visible())
        .filter((row) => row.discordChannelId === channelId && row.createdAt >= since)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map((row) => ({ ...row })),
    ),
    getNewestMirrorZulipMessageId: vitest.fn(async (id: string) => {
      const ids = messages
        .filter(visible())
        .filter(({ conversationId }) => conversationId === id)
        .map((row) => row.zulipMessageId);
      return ids.length > 0 ? Math.max(...ids) : undefined;
    }),
    updateMirrorMessages: vitest.fn(async (ids: string[], changes: UpdateMirrorMessage) => {
      for (const message of messages.filter(({ discordMessageId }) => ids.includes(discordMessageId))) {
        Object.assign(message, changes);
      }
    }),
    markMirrorMessagesDeleted: vitest.fn(async (ids: string[]) => {
      for (const message of messages.filter(({ discordMessageId }) => ids.includes(discordMessageId))) {
        message.deletedAt ??= new Date();
      }
    }),
    removeMirrorMessages: vitest.fn(async (ids: string[]) => {
      const kept = messages.filter(({ discordMessageId }) => !ids.includes(discordMessageId));
      messages.splice(0, messages.length, ...kept);
    }),
    getMirrorZulipHighWater: vitest.fn(async (streamId: number) => {
      const ids = messages
        .filter((row) => row.origin === 'zulip' && row.zulipStreamId === streamId)
        .map((row) => row.zulipMessageId);
      return ids.length > 0 ? Math.max(...ids) : undefined;
    }),
    getMirrorDiscordHighWater: vitest.fn(async (channelId: string, threadId: string | null) =>
      messages
        .filter(
          (row) => row.origin === 'discord' && row.discordChannelId === channelId && row.discordThreadId === threadId,
        )
        .map(({ discordMessageId }) => discordMessageId)
        .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
        .at(-1),
    ),
    getMirrorLinks: vitest.fn(async () => links.map((row) => ({ ...row }))),
    getMirrorIdentities: vitest.fn(async () => identities.map((row) => ({ ...row }))),
  };
  return { links, identities, conversations, messages, repository };
};

const mirrorChannel = (channelId: string): DiscordMirrorChannel => ({
  id: channelId,
  guildId: GUILD,
  name: channelId === FORUM ? 'dev-focus-topic' : 'dev',
  kind: channelId === FORUM ? 'forum' : 'text',
  everyoneCanView: false,
  missingPermissions: [],
});

const newDiscordMirrorMock = (): Mocked<IDiscordMirrorInterface> => {
  let snowflake = 600_000_000_000_000_000n;
  return {
    getEmotes: vitest.fn().mockResolvedValue([]),
    isReady: vitest.fn().mockReturnValue(true),
    getMirrorChannel: vitest.fn(async (channelId: string) => mirrorChannel(channelId)),
    ensureMirrorWebhook: vitest.fn().mockResolvedValue(undefined),
    sendMirrorMessage: vitest.fn(async ({ channelId, threadId, threadName }: DiscordMirrorSend) => {
      const messageId = String(++snowflake);
      return { messageId, channelId: threadId ?? (threadName ? messageId : channelId), webhookId: WEBHOOK };
    }),
    editMirrorMessage: vitest.fn().mockResolvedValue(undefined),
    deleteMirrorMessage: vitest.fn().mockResolvedValue(undefined),
    startMirrorThread: vitest.fn(async (_channelId: string, messageId: string) => messageId),
    renameMirrorThread: vitest.fn().mockResolvedValue(undefined),
    unarchiveMirrorThread: vitest.fn().mockResolvedValue(undefined),
    archiveMirrorThread: vitest.fn().mockResolvedValue(undefined),
    getTeamMember: vitest.fn().mockResolvedValue(TEAM_MEMBER),
    fetchMirrorMessagesBefore: vitest.fn().mockResolvedValue({ messages: [], oldestId: null, full: false }),
    fetchMirrorMessage: vitest.fn().mockResolvedValue(undefined),
    listMirrorThreads: vitest.fn().mockResolvedValue([]),
    sendMirrorNotice: vitest.fn(),
    unpinMirrorNotice: vitest.fn(),
    getMirrorReactions: vitest.fn().mockResolvedValue([]),
    addMirrorReaction: vitest.fn().mockResolvedValue(undefined),
    removeMirrorReaction: vitest.fn().mockResolvedValue(undefined),
  };
};

const newZulipMock = (): Mocked<IZulipInterface> => {
  let id = 5000;
  return {
    init: vitest.fn(),
    isInitialised: vitest.fn().mockReturnValue(true),
    sendMessage: vitest.fn(async () => ({ id: ++id })),
    sendDirectMessage: vitest.fn(),
    getMessage: vitest.fn(),
    updateMessage: vitest.fn().mockResolvedValue(undefined),
    createEmote: vitest.fn(),
    getSubscriptions: vitest.fn(),
    getOwnUser: vitest.fn(),
    getUser: vitest.fn(),
    getStream: vitest.fn(),
    getMessages: vitest.fn().mockResolvedValue([]),
    registerQueue: vitest.fn(),
    getEvents: vitest.fn(),
    deleteQueue: vitest.fn(),
    deleteMessage: vitest.fn().mockResolvedValue(undefined),
    uploadFile: vitest.fn(async (file: File) => ({ url: UPLOAD_URL, filename: file.name })),
    downloadUpload: vitest.fn(async (path: string) => new File(['bytes'], path.slice(path.lastIndexOf('/') + 1))),
    getStreamMessagesBefore: vitest.fn().mockResolvedValue([]),
    getMessagesByIds: vitest.fn().mockResolvedValue([]),
    getEmojiCodes: vitest.fn().mockResolvedValue({
      unicode: { smile: '😄', fire: '🔥' },
      names: { '1f604': 'smile', '1f525': 'fire', '1f44d': '+1', '2764': 'heart' },
    }),
    listEmoji: vitest.fn().mockResolvedValue([]),
    addReaction: vitest.fn().mockResolvedValue(undefined),
    removeReaction: vitest.fn().mockResolvedValue(undefined),
  };
};

const newZulipServiceStub = () => {
  const handlers = {
    message: [] as ZulipMessageHandler[],
    update: [] as ZulipUpdateHandler[],
    deletion: [] as ZulipDeletionHandler[],
    registration: [] as ZulipRegistrationHandler[],
    reaction: [] as ZulipReactionHandler[],
  };
  const service = {
    ownUser: BOT,
    emptyTopicName: 'general chat',
    onMessage: vitest.fn((handler: ZulipMessageHandler) => handlers.message.push(handler)),
    onMessageUpdate: vitest.fn((handler: ZulipUpdateHandler) => handlers.update.push(handler)),
    onMessagesDeleted: vitest.fn((handler: ZulipDeletionHandler) => handlers.deletion.push(handler)),
    onQueueRegistered: vitest.fn((handler: ZulipRegistrationHandler) => handlers.registration.push(handler)),
    onReaction: vitest.fn((handler: ZulipReactionHandler) => handlers.reaction.push(handler)),
  };
  return { service, handlers };
};

const zulipMessage = (overrides: Partial<ZulipReceivedMessage> = {}): ZulipReceivedMessage => ({
  id: 1001,
  senderId: 20,
  senderEmail: 'bea@example.com',
  senderFullName: 'Bea',
  type: 'stream',
  streamId: DEV_STREAM,
  topic: '#dev',
  content: 'hello',
  timestamp: Math.floor(Date.now() / 1000),
  ...overrides,
});

const discordMessage = (overrides: Partial<DiscordSourceMessage> = {}): DiscordSourceMessage => {
  const id = overrides.id ?? '300000000000000001';
  return {
    id,
    guildId: GUILD,
    channelId: DEV_CHANNEL,
    threadId: null,
    threadName: null,
    createdTimestamp: Date.now(),
    jumpUrl: `https://discord.com/channels/${GUILD}/${DEV_CHANNEL}/${id}`,
    author: { id: CONTRIBUTOR, username: 'contrib123', displayName: 'Contrib' },
    silent: false,
    content: 'hello',
    mentions: { users: {}, roles: {}, channels: {} },
    attachments: [],
    stickers: [],
    poll: null,
    forwarded: [],
    replyTo: null,
    ...overrides,
  };
};

const paragraphs = (...letters: string[]) => letters.map((letter) => letter.repeat(1500)).join('\n\n');

const refused = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' });

describe(MirrorService.name, () => {
  let sut: MirrorService;
  let zulip: Mocked<IZulipInterface>;
  let discord: Mocked<IDiscordMirrorInterface>;
  let db: ReturnType<typeof newMirrorDatabase>;
  let stub: ReturnType<typeof newZulipServiceStub>;

  const log = () => vitest.mocked(Logger.prototype.log);
  const warn = () => vitest.mocked(Logger.prototype.warn);
  const error = () => vitest.mocked(Logger.prototype.error);

  beforeEach(() => {
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vitest.spyOn(Logger.prototype, level).mockImplementation(() => {});
    }
    config.bot.token = 'bot-token';
    config.zulip.bot.apiKey = 'bot-key';
    vitest.mocked(downloadDiscordAttachment).mockReset();

    zulip = newZulipMock();
    discord = newDiscordMirrorMock();
    db = newMirrorDatabase();
    stub = newZulipServiceStub();
    zulip.getMessage.mockImplementation(async (id) => {
      const conversation = db.conversations.find(({ zulipAnchorMessageId }) => zulipAnchorMessageId === id);
      return { id, topic: conversation?.zulipTopic ?? '', streamId: conversation?.zulipStreamId ?? DEV_STREAM };
    });
    sut = new MirrorService(
      zulip,
      discord,
      db.repository as unknown as IDatabaseRepository,
      stub.service as unknown as ZulipService,
    );
  });

  afterEach(() => {
    vitest.restoreAllMocks();
    vitest.useRealTimers();
  });

  const register = async (streams = [DEV_STREAM, OFF_TOPIC_STREAM, FORUM_STREAM]) => {
    for (const handler of stub.handlers.registration) {
      handler({ subscribedStreamIds: streams });
    }
    await sut.whenIdle();
  };

  const start = async () => {
    await sut.init();
    await sut.onDiscordReady();
    await register();
  };

  const fromZulip = async (message: ZulipReceivedMessage) => {
    for (const handler of stub.handlers.message) {
      await handler(message);
    }
    await sut.whenIdle();
  };

  const updateFromZulip = async (update: Partial<ZulipMessageUpdated> & { messageId: number }) => {
    for (const handler of stub.handlers.update) {
      await handler({
        userId: 20,
        renderingOnly: false,
        messageIds: [update.messageId],
        streamId: DEV_STREAM,
        ...update,
      });
    }
    await sut.whenIdle();
  };

  const deleteFromZulip = async (deletion: Partial<ZulipMessagesDeleted> & { messageIds: number[] }) => {
    for (const handler of stub.handlers.deletion) {
      await handler({ streamId: DEV_STREAM, ...deletion });
    }
    await sut.whenIdle();
  };

  const fromDiscord = async (dto: DiscordSourceMessage) => {
    sut.onDiscordMessage(dto);
    await sut.whenIdle();
  };

  const seedThread = (overrides: Partial<MirrorConversation> = {}) => {
    const conversation: MirrorConversation = {
      id: `seeded-${db.conversations.length + 1}`,
      discordChannelId: DEV_CHANNEL,
      discordThreadId: '200000000000000001',
      zulipStreamId: DEV_STREAM,
      zulipTopic: 'Crash on upload',
      zulipTopicKey: 'crash on upload',
      zulipAnchorMessageId: 70,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    db.conversations.push(conversation);
    return conversation;
  };

  const seedRow = (overrides: Partial<MirrorMessage>) => {
    const row: MirrorMessage = {
      discordMessageId: '800000000000000001',
      conversationId: null,
      origin: 'zulip',
      discordChannelId: DEV_CHANNEL,
      discordThreadId: null,
      discordWebhookId: WEBHOOK,
      discordAuthorId: null,
      zulipMessageId: 70,
      zulipStreamId: DEV_STREAM,
      zulipSenderId: 20,
      part: 0,
      sourceHash: 'hash',
      zulipHeader: null,
      zulipAttachments: null,
      createdAt: new Date(),
      deletedAt: null,
      ...overrides,
    };
    db.messages.push(row);
    return row;
  };

  const sent = (index: number) => discord.sendMirrorMessage.mock.calls[index][0];
  const sentMessages = () => zulip.sendMessage.mock.calls.map(([payload]) => payload);

  describe('modes', () => {
    it('should register nothing when Discord runs with the dev token', async () => {
      config.bot.token = 'dev';
      await sut.init();

      expect(log()).toHaveBeenCalledWith('The Discord-Zulip mirror is off: Discord or Zulip is not configured');
      expect(stub.service.onMessage).not.toHaveBeenCalled();
      expect(db.repository.getMirrorLinks).not.toHaveBeenCalled();
      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(false);
      expect(sut.isActive()).toBe(false);
      expect(await sut.enable(db.links[0])).toBe(false);
    });

    it('should register nothing when Zulip runs with the dev keys', async () => {
      config.zulip.bot.apiKey = 'dev';
      await sut.init();

      expect(stub.service.onQueueRegistered).not.toHaveBeenCalled();
      expect(warn()).not.toHaveBeenCalled();
    });

    it('should listen without links, so that a link made later works', async () => {
      db.links.splice(0);

      await sut.init();
      await sut.onDiscordReady();

      expect(log()).toHaveBeenCalledWith('The Discord-Zulip mirror has 0 links');
      expect(stub.service.onMessage).toHaveBeenCalledOnce();
      expect(stub.service.onQueueRegistered).toHaveBeenCalledOnce();
      expect(sut.handlesChannel(FORUM)).toBe(false);
      expect(discord.getMirrorChannel).not.toHaveBeenCalled();
      expect(error()).not.toHaveBeenCalled();
    });
  });

  describe('links at runtime', () => {
    const NEW_CHANNEL = '100000000000000003';
    const NEW_STREAM = 903;

    it('should mirror a new link at once', async () => {
      await start();
      const created = link({ discordChannelId: NEW_CHANNEL, zulipStreamId: NEW_STREAM, mainTopic: '#new' });

      expect(await sut.enable(created)).toBe(true);
      await sut.whenIdle();

      expect(discord.ensureMirrorWebhook).toHaveBeenCalledWith(NEW_CHANNEL);
      expect(log()).toHaveBeenCalledWith(`${NEW_CHANNEL}: linked with Zulip stream ${NEW_STREAM}`);
      expect(sut.handlesChannel(NEW_CHANNEL)).toBe(true);
      await fromZulip(zulipMessage({ streamId: NEW_STREAM, topic: '#new' }));
      expect(sent(0)).toEqual(expect.objectContaining({ channelId: NEW_CHANNEL }));
      expect(await sut.enable(created)).toBe(true);
      expect(discord.ensureMirrorWebhook).toHaveBeenCalledTimes(4);
    });

    it('should leave the setup of a new link to shardReady while Discord is not connected', async () => {
      await sut.init();
      await register();

      expect(await sut.enable(link({ discordChannelId: NEW_CHANNEL, zulipStreamId: NEW_STREAM }))).toBe(false);
      expect(discord.getMirrorChannel).not.toHaveBeenCalled();

      await sut.onDiscordReady();
      expect(sut.handlesChannel(NEW_CHANNEL)).toBe(true);
    });

    it('should report a new link whose channel fails the check as off', async () => {
      await start();
      discord.getMirrorChannel.mockResolvedValue(undefined);

      expect(await sut.enable(link({ discordChannelId: NEW_CHANNEL, zulipStreamId: NEW_STREAM }))).toBe(false);
      expect(error()).toHaveBeenCalledWith(
        `${NEW_CHANNEL}: Discord channel ${NEW_CHANNEL} does not exist, so the pair is off`,
      );
    });

    it('should stop mirroring an unlinked pair at once and find its conversations again on a new link', async () => {
      await start();
      await fromZulip(zulipMessage());
      const [main] = db.conversations;

      sut.disable(DEV_CHANNEL);
      sut.disable(DEV_CHANNEL);

      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(false);
      expect(log()).toHaveBeenCalledWith(`${DEV_CHANNEL}: unlinked from Zulip stream ${DEV_STREAM}`);
      await fromZulip(zulipMessage({ id: 1002 }));
      await fromDiscord(discordMessage());
      expect(discord.sendMirrorMessage).toHaveBeenCalledOnce();
      expect(zulip.sendMessage).not.toHaveBeenCalled();

      await sut.enable(link({ discordChannelId: DEV_CHANNEL, zulipStreamId: DEV_STREAM, mainTopic: '#dev' }));
      await sut.whenIdle();
      await fromZulip(zulipMessage({ id: 1003 }));

      expect(db.conversations).toEqual([main]);
      expect(db.messages.map(({ zulipMessageId, conversationId }) => [zulipMessageId, conversationId])).toEqual([
        [1001, main.id],
        [1003, main.id],
      ]);
    });

    it('should not retry the catch-up of a pair unlinked while it ran', async () => {
      vitest.useFakeTimers();
      seedRow({ zulipMessageId: 70 });
      const unavailable = new ZulipApiError(503, 'BAD_GATEWAY', 'Service unavailable', 'GET /messages');
      let fail: (error: Error) => void = () => {};
      zulip.getStreamMessagesBefore.mockImplementation(({ stream }) =>
        stream === DEV_STREAM ? Promise.reject(unavailable) : Promise.resolve([]),
      );
      zulip.getStreamMessagesBefore.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
      await sut.init();
      await sut.onDiscordReady();
      for (const handler of stub.handlers.registration) {
        handler({ subscribedStreamIds: [DEV_STREAM, OFF_TOPIC_STREAM, FORUM_STREAM] });
      }
      await vitest.advanceTimersByTimeAsync(0);

      sut.disable(DEV_CHANNEL);
      fail(unavailable);
      await vitest.advanceTimersByTimeAsync(30 * 60 * 1000);

      expect(log().mock.calls.filter(([message]) => String(message).includes('catching up again'))).toEqual([]);
    });

    it('should not catch up what was posted before the link was made', async () => {
      const now = Date.now();
      seedRow({ zulipMessageId: 70 });
      zulip.getStreamMessagesBefore.mockImplementation(async ({ stream }) =>
        stream === DEV_STREAM
          ? [
              zulipMessage({ id: 71, timestamp: Math.floor((now - 120_000) / 1000) }),
              zulipMessage({ id: 72, timestamp: Math.floor((now - 30_000) / 1000) }),
            ]
          : [],
      );
      db.links[0].createdAt = new Date(now - 60_000);

      await start();

      expect(db.messages.map(({ zulipMessageId }) => zulipMessageId)).toEqual([70, 72]);
      expect(log()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: catch-up skipped 1 message older than 6 hours or than the link`,
      );
    });

    it('should use a newly linked identity at once, and stop using a removed one', async () => {
      db.identities.splice(0);
      await start();
      await fromZulip(zulipMessage({ senderId: TEAM_ZULIP_ID, senderFullName: 'Alex Tran' }));

      db.identities.push({ zulipUserId: TEAM_ZULIP_ID, discordUserId: TEAM_DISCORD_ID, createdAt: new Date() });
      await sut.refreshIdentities();
      await fromZulip(zulipMessage({ id: 1002, senderId: TEAM_ZULIP_ID, senderFullName: 'Alex Tran' }));

      db.identities.splice(0);
      await sut.refreshIdentities();
      await fromZulip(zulipMessage({ id: 1003, senderId: TEAM_ZULIP_ID, senderFullName: 'Alex Tran' }));

      expect([0, 1, 2].map((index) => sent(index).username)).toEqual([
        'Alex Tran (Zulip)',
        'Alex',
        'Alex Tran (Zulip)',
      ]);
      expect(discord.getTeamMember).toHaveBeenCalledWith(GUILD, TEAM_DISCORD_ID);
    });
  });

  describe('onDiscordReady', () => {
    it('should set up the webhook and announce each pair once', async () => {
      await start();
      await sut.onDiscordReady();

      expect(discord.ensureMirrorWebhook).toHaveBeenCalledWith(DEV_CHANNEL);
      expect(discord.ensureMirrorWebhook).toHaveBeenCalledWith(FORUM);
      const announcements = log().mock.calls.filter(([message]) => String(message).includes('mirroring Discord'));
      expect(announcements).toEqual([
        [
          `${DEV_CHANNEL}: mirroring Discord channel ${DEV_CHANNEL} with Zulip stream ${DEV_STREAM} (main topic "#dev")`,
        ],
        [
          `${OFF_TOPIC_CHANNEL}: mirroring Discord channel ${OFF_TOPIC_CHANNEL} with Zulip stream ${OFF_TOPIC_STREAM} (main topic "#dev-off-topic")`,
        ],
        [`${FORUM}: mirroring Discord channel ${FORUM} with Zulip stream ${FORUM_STREAM}`],
      ]);
    });

    it.each([
      ['is missing', undefined, 'does not exist'],
      ['is not a text channel', { kind: 'forum' }, 'is not a text channel'],
    ])('should turn the pair off when the channel %s', async (_, overrides, problem) => {
      discord.getMirrorChannel.mockImplementation(async (channelId) =>
        channelId === DEV_CHANNEL && overrides === undefined
          ? undefined
          : ({ ...mirrorChannel(channelId), ...overrides } as DiscordMirrorChannel),
      );
      await sut.init();
      await sut.onDiscordReady();

      expect(error()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: Discord channel ${DEV_CHANNEL} ${problem}, so the pair is off`,
      );
      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(false);
      await fromZulip(zulipMessage());
      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();
    });

    it('should mirror a channel whoever can see it and wherever it is', async () => {
      discord.getMirrorChannel.mockImplementation(async (channelId) => ({
        ...mirrorChannel(channelId),
        guildId: '999999999999999999',
        everyoneCanView: true,
      }));
      await start();

      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(true);
      expect(error()).not.toHaveBeenCalled();
    });

    it('should warn about missing permissions and keep the pair when it can still work', async () => {
      discord.getMirrorChannel.mockImplementation(async (channelId) => ({
        ...mirrorChannel(channelId),
        missingPermissions: channelId === DEV_CHANNEL ? ['EmbedLinks'] : [],
      }));
      await start();

      expect(warn()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: the bot is missing EmbedLinks in Discord channel ${DEV_CHANNEL}`,
      );
      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(true);
    });

    it.each(['ViewChannel', 'ManageWebhooks'])('should turn the pair off without %s', async (permission) => {
      discord.getMirrorChannel.mockImplementation(async (channelId) => ({
        ...mirrorChannel(channelId),
        missingPermissions: channelId === DEV_CHANNEL ? [permission, 'EmbedLinks'] : [],
      }));
      await start();

      expect(warn()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: the bot is missing ${permission}, EmbedLinks in Discord channel ${DEV_CHANNEL}, so the pair is off`,
      );
      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(false);
    });

    it('should keep checking the other pairs when one channel cannot be read', async () => {
      discord.getMirrorChannel.mockImplementation(async (channelId) => {
        if (channelId === DEV_CHANNEL) {
          throw new DiscordMirrorError('forbidden', 50_001);
        }
        return mirrorChannel(channelId);
      });
      await start();

      expect(error()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: could not check Discord channel ${DEV_CHANNEL}: forbidden (50001), so the pair is off`,
      );
      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(false);
      await fromZulip(zulipMessage());
      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();
      await fromZulip(zulipMessage({ id: 1002, streamId: FORUM_STREAM, topic: 'idea' }));
      expect(discord.sendMirrorMessage).toHaveBeenCalledOnce();
    });

    it('should carry on when the webhook cannot be set up', async () => {
      discord.ensureMirrorWebhook.mockRejectedValue(new DiscordMirrorError('max-webhooks', 30_007));
      await start();

      expect(error()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: could not set up the mirror webhook in Discord channel ${DEV_CHANNEL}: max-webhooks (30007)`,
      );
      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(true);
    });

    it('should find a webhook it could not set up later, without using up the hourly recreation', async () => {
      discord.ensureMirrorWebhook.mockRejectedValueOnce(new DiscordMirrorError('unavailable', undefined, 'HTTP 503'));
      await start();

      discord.sendMirrorMessage.mockRejectedValueOnce(
        new DiscordMirrorError('unknown-webhook', undefined, 'The mirror webhook is not resolved'),
      );
      await fromZulip(zulipMessage());
      discord.sendMirrorMessage.mockRejectedValueOnce(new DiscordMirrorError('unknown-webhook', 10_015));
      await fromZulip(zulipMessage({ id: 1002 }));

      expect(discord.ensureMirrorWebhook).toHaveBeenCalledTimes(5);
      expect(db.messages.map(({ zulipMessageId }) => zulipMessageId)).toEqual([1001, 1002]);
    });

    it('should recreate a deleted webhook again when the last recreation failed', async () => {
      await start();

      discord.sendMirrorMessage.mockRejectedValueOnce(new DiscordMirrorError('unknown-webhook', 10_015));
      discord.ensureMirrorWebhook.mockRejectedValueOnce(new DiscordMirrorError('forbidden', 50_013));
      await fromZulip(zulipMessage());
      discord.sendMirrorMessage.mockRejectedValueOnce(
        new DiscordMirrorError('unknown-webhook', undefined, 'The mirror webhook is not resolved'),
      );
      await fromZulip(zulipMessage({ id: 1002 }));

      expect(db.messages.map(({ zulipMessageId }) => zulipMessageId)).toEqual([1002]);
    });

    it('should turn a pair off as soon as its channel is deleted', async () => {
      vitest.useFakeTimers();
      await start();
      discord.getMirrorChannel.mockImplementation(async (channelId) =>
        channelId === DEV_CHANNEL ? undefined : mirrorChannel(channelId),
      );

      await vitest.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(error()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: Discord channel ${DEV_CHANNEL} does not exist, so the pair is off`,
      );
      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(false);
      expect(sut.handlesChannel(OFF_TOPIC_CHANNEL)).toBe(true);
    });

    it.each([
      [
        'is denied View Channel',
        () =>
          discord.getMirrorChannel.mockResolvedValue({
            ...mirrorChannel(DEV_CHANNEL),
            missingPermissions: ['ViewChannel'],
          }),
        `${DEV_CHANNEL}: the bot is missing ViewChannel in Discord channel ${DEV_CHANNEL}, so the pair is off`,
      ],
      [
        'is denied Manage Webhooks',
        () =>
          discord.getMirrorChannel.mockResolvedValue({
            ...mirrorChannel(DEV_CHANNEL),
            missingPermissions: ['ManageWebhooks', 'EmbedLinks'],
          }),
        `${DEV_CHANNEL}: the bot is missing ManageWebhooks, EmbedLinks in Discord channel ${DEV_CHANNEL}, so the pair is off`,
      ],
      [
        'loses access to the channel',
        () => discord.getMirrorChannel.mockRejectedValue(new DiscordMirrorError('forbidden', 50_001)),
        `${DEV_CHANNEL}: could not check Discord channel ${DEV_CHANNEL}: forbidden (50001), so the pair is off`,
      ],
    ])('should stop mirroring both ways within ten minutes once the bot %s', async (_, arrange, reason) => {
      vitest.useFakeTimers();
      await start();
      arrange();

      await vitest.advanceTimersByTimeAsync(10 * 60 * 1000);
      await fromZulip(zulipMessage());
      await fromDiscord(discordMessage());

      expect(vitest.mocked(Logger.prototype[reason.includes('forbidden') ? 'error' : 'warn'])).toHaveBeenCalledWith(
        reason,
      );
      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(false);
      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();
      expect(zulip.sendMessage).not.toHaveBeenCalled();
    });

    it('should not create what was already queued once the pair turns off', async () => {
      vitest.useFakeTimers();
      await start();
      await vitest.advanceTimersByTimeAsync(10 * 60 * 1000 - 1000);
      let resolveSend!: (value: { id: number }) => void;
      zulip.sendMessage.mockReturnValueOnce(new Promise((resolve) => (resolveSend = resolve)));
      sut.onDiscordMessage(discordMessage({ content: 'first' }));
      sut.onDiscordMessage(discordMessage({ id: '300000000000000002', content: 'second' }));
      discord.getMirrorChannel.mockResolvedValue({
        ...mirrorChannel(DEV_CHANNEL),
        missingPermissions: ['ViewChannel'],
      });

      await vitest.advanceTimersByTimeAsync(2000);
      resolveSend({ id: 5001 });
      await sut.whenIdle();

      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(false);
      expect(zulip.sendMessage).toHaveBeenCalledOnce();
    });

    it('should turn a pair on again once its channel can be mirrored again, and catch up', async () => {
      vitest.useFakeTimers();
      seedRow({ zulipMessageId: 1000 });
      await start();
      discord.getMirrorChannel.mockImplementation(async (channelId) =>
        channelId === DEV_CHANNEL ? undefined : mirrorChannel(channelId),
      );
      await vitest.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(false);
      zulip.getStreamMessagesBefore.mockResolvedValue([zulipMessage({ id: 1001, content: 'posted while off' })]);

      discord.getMirrorChannel.mockImplementation(async (channelId) => mirrorChannel(channelId));
      await vitest.advanceTimersByTimeAsync(10 * 60 * 1000);
      await sut.whenIdle();

      expect(error()).toHaveBeenCalledExactlyOnceWith(
        `${DEV_CHANNEL}: Discord channel ${DEV_CHANNEL} does not exist, so the pair is off`,
      );
      expect(log()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: Discord channel ${DEV_CHANNEL} can be mirrored again, so the pair is on`,
      );
      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(true);
      expect(sent(0)).toEqual(
        expect.objectContaining({ channelId: DEV_CHANNEL, content: expect.stringMatching(/^posted while off\n/) }),
      );
    });

    it('should set up a pair whose first check failed for now at the next check', async () => {
      vitest.useFakeTimers();
      discord.getMirrorChannel.mockRejectedValueOnce(new DiscordMirrorError('unavailable', undefined, 'HTTP 503'));
      await start();
      await fromZulip(zulipMessage());
      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();

      await vitest.advanceTimersByTimeAsync(10 * 60 * 1000);
      await fromZulip(zulipMessage({ id: 1002, content: 'later' }));

      expect(discord.ensureMirrorWebhook).toHaveBeenCalledWith(DEV_CHANNEL);
      expect(sent(0)).toEqual(expect.objectContaining({ channelId: DEV_CHANNEL, content: 'later' }));
    });

    it('should warn about the same missing permissions only once', async () => {
      vitest.useFakeTimers();
      discord.getMirrorChannel.mockImplementation(async (channelId) => ({
        ...mirrorChannel(channelId),
        missingPermissions: channelId === DEV_CHANNEL ? ['EmbedLinks'] : [],
      }));
      await start();
      await sut.onDiscordReady();
      await vitest.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(warn()).toHaveBeenCalledExactlyOnceWith(
        `${DEV_CHANNEL}: the bot is missing EmbedLinks in Discord channel ${DEV_CHANNEL}`,
      );
    });

    it('should keep a pair on while its channel cannot be checked', async () => {
      vitest.useFakeTimers();
      await start();
      discord.getMirrorChannel.mockRejectedValue(new DiscordMirrorError('unavailable', undefined, 'HTTP 503'));

      await vitest.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(error()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: could not check Discord channel ${DEV_CHANNEL}: unavailable`,
      );
      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(true);
    });

    it('should warn about a mirror stream the Zulip bot is not subscribed to', async () => {
      await sut.init();
      await sut.onDiscordReady();
      await register([DEV_STREAM, OFF_TOPIC_STREAM]);

      expect(warn()).toHaveBeenCalledExactlyOnceWith(
        `${FORUM}: the Zulip bot is not subscribed to stream ${FORUM_STREAM}, so nothing posted there is mirrored until an admin subscribes it`,
      );
    });
  });

  describe('Zulip to Discord', () => {
    beforeEach(start);

    it('should post a message in the main topic in the channel', async () => {
      await fromZulip(zulipMessage());

      expect(discord.sendMirrorMessage).toHaveBeenCalledExactlyOnceWith({
        channelId: DEV_CHANNEL,
        username: 'Bea (Zulip)',
        content: 'hello',
        files: [],
        pingUserIds: [],
        suppressEmbeds: false,
      });
      expect(db.conversations).toEqual([
        expect.objectContaining({ discordThreadId: null, zulipTopic: '#dev', zulipAnchorMessageId: null }),
      ]);
      expect(db.messages).toEqual([
        expect.objectContaining({
          origin: 'zulip',
          zulipMessageId: 1001,
          zulipSenderId: 20,
          part: 0,
          discordThreadId: null,
          discordWebhookId: WEBHOOK,
          conversationId: db.conversations[0].id,
        }),
      ]);
    });

    it('should start a thread for a new topic and post the other parts in it', async () => {
      await fromZulip(zulipMessage({ topic: 'Crash on upload', content: paragraphs('a', 'b') }));

      const first = sent(0);
      expect(first).toEqual(expect.objectContaining({ channelId: DEV_CHANNEL, content: 'a'.repeat(1500) }));
      expect(first.threadId).toBeUndefined();
      expect(first.threadName).toBeUndefined();
      const threadId = (await discord.sendMirrorMessage.mock.results[0].value).messageId;
      expect(discord.startMirrorThread).toHaveBeenCalledExactlyOnceWith(DEV_CHANNEL, threadId, 'Crash on upload');
      expect(sent(1)).toEqual({
        channelId: DEV_CHANNEL,
        threadId,
        username: 'Bea (Zulip)',
        content: 'b'.repeat(1500),
        pingUserIds: [],
        suppressEmbeds: false,
      });
      expect(db.conversations).toEqual([
        expect.objectContaining({
          discordThreadId: threadId,
          zulipTopic: 'Crash on upload',
          zulipTopicKey: 'crash on upload',
          zulipAnchorMessageId: 1001,
        }),
      ]);
      expect(db.messages.map(({ part, discordThreadId }) => [part, discordThreadId])).toEqual([
        [0, null],
        [1, threadId],
      ]);

      await fromZulip(zulipMessage({ id: 1002, topic: 'crash ON upload', content: 'more' }));
      expect(sent(2)).toEqual(expect.objectContaining({ threadId, content: 'more' }));
      expect(discord.startMirrorThread).toHaveBeenCalledOnce();
    });

    it('should create a forum post for a new topic in the forum stream', async () => {
      await fromZulip(zulipMessage({ streamId: FORUM_STREAM, topic: 'Feature idea' }));

      expect(sent(0)).toEqual({
        channelId: FORUM,
        threadName: 'Feature idea',
        username: 'Bea (Zulip)',
        content: 'hello',
        files: [],
        pingUserIds: [],
        suppressEmbeds: false,
      });
      const postId = (await discord.sendMirrorMessage.mock.results[0].value).channelId;
      expect(db.conversations).toEqual([
        expect.objectContaining({ discordChannelId: FORUM, discordThreadId: postId, zulipAnchorMessageId: 1001 }),
      ]);
      expect(discord.startMirrorThread).not.toHaveBeenCalled();
    });

    it('should find a renamed topic again through its recent messages', async () => {
      const thread = seedThread({ zulipTopic: 'old name', zulipTopicKey: 'old name' });
      seedRow({ zulipMessageId: 70, conversationId: thread.id, discordThreadId: thread.discordThreadId });
      zulip.getMessages.mockResolvedValue([zulipMessage({ id: 70 }), zulipMessage({ id: 1001 })]);

      await fromZulip(zulipMessage({ topic: 'new name' }));

      expect(zulip.getMessages).toHaveBeenCalledWith({ stream: DEV_STREAM, topic: 'new name', numBefore: 20 });
      expect(sent(0)).toEqual(expect.objectContaining({ threadId: thread.discordThreadId }));
      expect(db.conversations[0]).toEqual(
        expect.objectContaining({ zulipTopic: 'new name', zulipTopicKey: 'new name' }),
      );
      expect(discord.startMirrorThread).not.toHaveBeenCalled();
    });

    it('should not take a thread along with messages moved away from its anchor', async () => {
      await fromZulip(zulipMessage({ topic: 'Crash' }));
      await fromZulip(zulipMessage({ id: 1002, topic: 'Crash' }));
      zulip.getMessages.mockResolvedValue([zulipMessage({ id: 1002, topic: 'Elsewhere' })]);

      await fromZulip(zulipMessage({ id: 1003, topic: 'Elsewhere' }));

      expect(zulip.getMessage).toHaveBeenCalledWith(1001);
      expect(discord.startMirrorThread).toHaveBeenCalledTimes(2);
      expect(db.conversations.map(({ zulipTopic }) => zulipTopic)).toEqual(['Crash', 'Elsewhere']);
    });

    it('should find a renamed topic again through its anchor', async () => {
      const thread = seedThread({ zulipTopic: 'old name', zulipTopicKey: 'old name', zulipAnchorMessageId: 60 });
      seedRow({ zulipMessageId: 70, conversationId: thread.id, discordThreadId: thread.discordThreadId });
      zulip.getMessages.mockResolvedValue([zulipMessage({ id: 70, topic: 'new name' })]);
      zulip.getMessage.mockResolvedValue({ id: 60, topic: 'New Name', streamId: DEV_STREAM });

      await fromZulip(zulipMessage({ topic: 'new name' }));

      expect(sent(0).threadId).toBe(thread.discordThreadId);
      expect(db.conversations[0].zulipTopic).toBe('new name');
    });

    it('should start a new thread when the anchor of the conversation found again is gone', async () => {
      const thread = seedThread({ zulipTopic: 'old name', zulipTopicKey: 'old name', zulipAnchorMessageId: 60 });
      seedRow({ zulipMessageId: 70, conversationId: thread.id, discordThreadId: thread.discordThreadId });
      zulip.getMessages.mockResolvedValue([zulipMessage({ id: 70, topic: 'new name' })]);
      zulip.getMessage.mockRejectedValue(
        new ZulipApiError(400, 'BAD_REQUEST', 'Invalid message(s)', 'GET /messages/60'),
      );

      await fromZulip(zulipMessage({ topic: 'new name' }));

      expect(discord.startMirrorThread).toHaveBeenCalledOnce();
      expect(db.conversations.map(({ zulipTopic }) => zulipTopic)).toEqual(['old name', 'new name']);
    });

    it('should find a topic moved to the empty topic again through its anchor', async () => {
      const thread = seedThread({ zulipTopic: 'Foo', zulipTopicKey: 'foo', zulipAnchorMessageId: 60 });
      seedRow({ zulipMessageId: 70, conversationId: thread.id, discordThreadId: thread.discordThreadId });
      zulip.getMessages.mockResolvedValue([zulipMessage({ id: 70, topic: 'general chat' })]);
      zulip.getMessage.mockResolvedValue({ id: 60, topic: '', streamId: DEV_STREAM });

      await fromZulip(zulipMessage({ topic: 'general chat' }));

      expect(sent(0).threadId).toBe(thread.discordThreadId);
      expect(db.conversations[0]).toEqual(expect.objectContaining({ zulipTopic: '', zulipTopicKey: '' }));
    });

    it('should leave a new topic for catch-up when its anchor cannot be read for now', async () => {
      const thread = seedThread({ zulipTopic: 'old name', zulipTopicKey: 'old name', zulipAnchorMessageId: 60 });
      seedRow({ zulipMessageId: 70, conversationId: thread.id, discordThreadId: thread.discordThreadId });
      zulip.getMessages.mockResolvedValue([zulipMessage({ id: 70, topic: 'new name' })]);
      zulip.getMessage.mockRejectedValue(new TypeError('fetch failed'));
      vitest.useFakeTimers();

      for (const handler of stub.handlers.message) {
        await handler(zulipMessage({ topic: 'new name' }));
      }
      await vitest.advanceTimersByTimeAsync(6000);
      await sut.whenIdle();

      expect(zulip.getMessage).toHaveBeenCalledTimes(3);
      expect(discord.startMirrorThread).not.toHaveBeenCalled();
      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();
      expect(log()).toHaveBeenCalledWith(`${DEV_CHANNEL}: catching up again in 30 seconds`);
    });

    it('should keep the empty topic apart from a topic named General Chat', async () => {
      await fromZulip(zulipMessage({ topic: 'General Chat' }));
      await fromZulip(zulipMessage({ id: 1002, topic: 'general chat' }));

      expect(discord.startMirrorThread).toHaveBeenCalledTimes(2);
      expect(db.conversations.map(({ zulipTopicKey }) => zulipTopicKey)).toEqual(['general chat', '']);
    });

    it('should never adopt the main conversation for another topic', async () => {
      await fromZulip(zulipMessage({ id: 70 }));
      zulip.getMessages.mockResolvedValue([zulipMessage({ id: 70 })]);

      await fromZulip(zulipMessage({ id: 1002, topic: 'moved out of main' }));

      expect(discord.startMirrorThread).toHaveBeenCalledOnce();
      expect(db.conversations.find(({ discordThreadId }) => discordThreadId === null)?.zulipTopic).toBe('#dev');
    });

    it('should keep the message in the channel and post a notice when the thread cannot start', async () => {
      discord.startMirrorThread.mockRejectedValue(new DiscordMirrorError('forbidden', 50_013));

      await fromZulip(zulipMessage({ topic: 'Crash', content: paragraphs('a', 'b') }));
      await fromZulip(zulipMessage({ id: 1002, topic: 'Crash' }));

      expect(db.conversations).toEqual([]);
      expect(db.messages.map(({ conversationId, discordThreadId }) => [conversationId, discordThreadId])).toEqual([
        [null, null],
        [null, null],
        [null, null],
      ]);
      expect(discord.startMirrorThread).toHaveBeenCalledTimes(2);
      expect(error()).toHaveBeenCalledExactlyOnceWith(
        `${DEV_CHANNEL}: could not start a Discord thread for Zulip message 1001: forbidden (50013)`,
      );
      expect(sentMessages()).toEqual([
        {
          stream: DEV_STREAM,
          topic: 'Crash',
          content: '⚠ Not mirrored to Discord: the bot could not start a Discord thread for this topic.',
        },
      ]);
    });

    it('should use the verified Discord identity of a mapped team member', async () => {
      await fromZulip(zulipMessage({ senderId: TEAM_ZULIP_ID, senderFullName: 'Alex Tran' }));

      expect(discord.getTeamMember).toHaveBeenCalledWith(GUILD, TEAM_DISCORD_ID);
      expect(sent(0)).toEqual(
        expect.objectContaining({ username: 'Alex', avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png' }),
      );
      expect(warn()).not.toHaveBeenCalled();
    });

    it('should break up "discord" in a team member name, which Discord refuses in a webhook name', async () => {
      discord.getTeamMember.mockResolvedValue({ ...TEAM_MEMBER, displayName: 'Discord Mod' });

      await fromZulip(zulipMessage({ senderId: TEAM_ZULIP_ID }));

      expect(sent(0).username).toBe('D\u200Aiscord Mod');
    });

    it('should fall back and warn once for a team member without the role', async () => {
      discord.getTeamMember.mockResolvedValue({ displayName: 'Alex', avatarUrl: 'x', roleIds: ['1'] });

      await fromZulip(zulipMessage({ senderId: TEAM_ZULIP_ID, senderFullName: 'Alex Tran' }));
      await fromZulip(zulipMessage({ id: 1002, senderId: TEAM_ZULIP_ID, senderFullName: 'Alex Tran' }));

      expect(sent(0).username).toBe('Alex Tran (Zulip)');
      expect(sent(0).avatarUrl).toBeUndefined();
      expect(warn()).toHaveBeenCalledExactlyOnceWith(
        `Zulip user ${TEAM_ZULIP_ID} is linked to Discord user ${TEAM_DISCORD_ID}, who is not in the guild or holds neither the Team nor the Immich role, so the link is not used`,
      );
    });

    it('should name an unmapped sender with a suffix, no avatar and one warning', async () => {
      await fromZulip(zulipMessage());
      await fromZulip(zulipMessage({ id: 1002 }));

      expect(sent(1)).toEqual(expect.objectContaining({ username: 'Bea (Zulip)' }));
      expect(sent(1).avatarUrl).toBeUndefined();
      expect(warn()).toHaveBeenCalledExactlyOnceWith(
        'Zulip user 20 has not linked a Discord account; their messages appear on Discord as "Name (Zulip)"',
      );
    });

    it('should translate a verified mention to a pill that pings nobody', async () => {
      await fromZulip(zulipMessage({ content: `thanks @**Alex|${TEAM_ZULIP_ID}** and @**all**` }));

      expect(sent(0)).toEqual(
        expect.objectContaining({ content: `thanks <@${TEAM_DISCORD_ID}> and @\u200Ball`, pingUserIds: [] }),
      );
    });

    it('should ping the Discord author a Zulip user quote-replies to', async () => {
      seedRow({
        discordMessageId: '300000000000000005',
        origin: 'discord',
        discordAuthorId: CONTRIBUTOR,
        discordWebhookId: null,
        zulipMessageId: 77,
        zulipSenderId: null,
      });

      await fromZulip(
        zulipMessage({
          content: `@_**${BOT.fullName}|${BOT.userId}** [said](#narrow/channel/${DEV_STREAM}/topic/.23dev/near/77):\n\`\`\`quote\nhi\n\`\`\`\nthanks`,
        }),
      );

      expect(sent(0)).toEqual(
        expect.objectContaining({
          content: `-# ↩ replying to <@${CONTRIBUTOR}> · [jump](https://discord.com/channels/${GUILD}/${DEV_CHANNEL}/300000000000000005)\nthanks`,
          pingUserIds: [CONTRIBUTOR],
        }),
      );
    });

    it('should jump to the first part of a Zulip message mirrored in several parts', async () => {
      seedRow({ discordMessageId: '800000000000000001', zulipMessageId: 77, part: 0 });
      seedRow({ discordMessageId: '800000000000000002', zulipMessageId: 77, part: 1 });

      await fromZulip(
        zulipMessage({
          content: `@_**Bea|20** [said](#narrow/channel/${DEV_STREAM}/topic/.23dev/near/77):\n\`\`\`quote\nhi\n\`\`\`\nthanks`,
        }),
      );

      expect(sent(0).content).toBe(
        `-# ↩ replying to Bea · [jump](https://discord.com/channels/${GUILD}/${DEV_CHANNEL}/800000000000000001)\nthanks`,
      );
    });

    it('should ping and attach on the first part only', async () => {
      seedRow({
        discordMessageId: '300000000000000005',
        origin: 'discord',
        discordAuthorId: CONTRIBUTOR,
        discordWebhookId: null,
        zulipMessageId: 77,
        zulipSenderId: null,
      });

      await fromZulip(
        zulipMessage({
          content: `@_**Contrib|${BOT.userId}** [said](#narrow/channel/${DEV_STREAM}/topic/.23dev/near/77):\n\`\`\`quote\nhi\n\`\`\`\n${paragraphs('a', 'b')}\n[shot.png](/user_uploads/2/ab/cdef/shot.png)`,
        }),
      );

      expect(sent(0)).toEqual(
        expect.objectContaining({ pingUserIds: [CONTRIBUTOR], files: [expect.objectContaining({ name: 'shot.png' })] }),
      );
      expect(sent(1)).toEqual({
        channelId: DEV_CHANNEL,
        username: 'Bea (Zulip)',
        content: 'b'.repeat(1500),
        pingUserIds: [],
        suppressEmbeds: false,
      });
    });

    it('should post a message that is only an upload as the file alone', async () => {
      await fromZulip(zulipMessage({ content: '[shot.png](/user_uploads/2/ab/cdef/shot.png)' }));

      expect(discord.sendMirrorMessage).toHaveBeenCalledExactlyOnceWith({
        channelId: DEV_CHANNEL,
        username: 'Bea (Zulip)',
        content: '',
        files: [expect.objectContaining({ name: 'shot.png' })],
        pingUserIds: [],
        suppressEmbeds: false,
      });
      expect(db.messages).toEqual([expect.objectContaining({ origin: 'zulip', zulipMessageId: 1001, part: 0 })]);
    });

    it('should anchor a thread without an anchor to its next message', async () => {
      seedThread({ zulipAnchorMessageId: null });

      await fromZulip(zulipMessage({ topic: 'Crash on upload' }));

      expect(db.conversations[0].zulipAnchorMessageId).toBe(1001);
    });

    it('should check a verified identity again after ten minutes', async () => {
      vitest.useFakeTimers();
      await fromZulip(zulipMessage({ senderId: TEAM_ZULIP_ID }));
      await fromZulip(zulipMessage({ id: 1002, senderId: TEAM_ZULIP_ID }));
      const checks = discord.getTeamMember.mock.calls.length;

      vitest.advanceTimersByTime(10 * 60 * 1000);
      discord.getTeamMember.mockResolvedValue({ ...TEAM_MEMBER, displayName: 'Alex T' });
      await fromZulip(zulipMessage({ id: 1003, senderId: TEAM_ZULIP_ID }));

      expect(discord.getTeamMember).toHaveBeenCalledTimes(checks + 1);
      expect(sent(2).username).toBe('Alex T');
    });

    it('should resolve unicode and custom emoji', async () => {
      discord.getEmotes.mockResolvedValue([
        {
          id: '500000000000000001',
          identifier: 'PartyParrot:500000000000000001',
          name: 'PartyParrot',
          url: 'x',
          animated: false,
        },
        { id: '500000000000000002', identifier: 'a:Dance:500000000000000002', name: 'Dance', url: 'y', animated: true },
        { id: '500000000000000003', identifier: 'fire:500000000000000003', name: 'fire', url: 'z', animated: false },
        {
          id: '500000000000000004',
          identifier: 'unsynced:500000000000000004',
          name: 'unsynced',
          url: 'w',
          animated: false,
        },
      ]);
      zulip.listEmoji.mockResolvedValue([
        { id: '1', name: 'partyparrot', deactivated: false },
        { id: '2', name: 'dance', deactivated: false },
        { id: '3', name: 'fire2', deactivated: false },
      ]);

      await fromZulip(
        zulipMessage({ content: 'nice :smile: :partyparrot: :dance: :fire: :fire2: :unsynced: :unknown:' }),
      );
      await fromZulip(zulipMessage({ id: 1002, content: ':smile:' }));

      expect(sent(0).content).toBe(
        'nice 😄 <:PartyParrot:500000000000000001> <a:Dance:500000000000000002> 🔥 <:fire:500000000000000003> :unsynced: :unknown:',
      );
      expect(zulip.getEmojiCodes).toHaveBeenCalledOnce();
      expect(discord.getEmotes).toHaveBeenCalledOnce();
      expect(zulip.listEmoji).toHaveBeenCalledOnce();
    });

    it('should leave emoji names as they are while the emoji table cannot be read', async () => {
      zulip.getEmojiCodes.mockRejectedValue(new Error('Could not fetch the Zulip emoji codes: 404'));

      await fromZulip(zulipMessage({ content: ':smile:' }));
      await fromZulip(zulipMessage({ id: 1002, content: ':smile:' }));

      expect(sent(0).content).toBe(':smile:');
      expect(zulip.getEmojiCodes).toHaveBeenCalledOnce();
      expect(warn()).toHaveBeenCalledWith(
        'Could not load the Zulip emoji table, so emoji names stay as text for an hour: Could not fetch the Zulip emoji codes: 404',
      );
    });

    it('should attach the uploads of the message and note the ones it could not', async () => {
      zulip.downloadUpload.mockImplementation(async (path) => {
        if (path.endsWith('big.zip')) {
          return undefined;
        }
        return new File(['bytes'], 'shot.png');
      });

      await fromZulip(
        zulipMessage({
          content: `look\n[shot.png](/user_uploads/2/ab/cdef/shot.png)\n[big.zip](/user_uploads/2/ab/cdef/big.zip)`,
        }),
      );

      expect(zulip.downloadUpload).toHaveBeenCalledWith(
        '/user_uploads/2/ab/cdef/shot.png',
        Constants.Mirror.MaxFileBytes,
        expect.any(AbortSignal),
      );
      expect(sent(0).content).toBe('look\n*(attachment not mirrored: big.zip)*');
      expect(sent(0).files?.map(({ name }) => name)).toEqual(['shot.png']);
    });

    it('should attach at most ten files and note the rest', async () => {
      const names = Array.from({ length: 11 }, (_, index) => `f${index + 1}.png`);

      await fromZulip(
        zulipMessage({ content: names.map((name) => `[${name}](/user_uploads/2/ab/cdef/${name})`).join('\n') }),
      );

      expect(zulip.downloadUpload).toHaveBeenCalledTimes(10);
      expect(sent(0).files?.map(({ name }) => name)).toEqual(names.slice(0, 10));
      expect(sent(0).content).toBe('*(attachment not mirrored: f11.png)*');
    });

    it('should attach files up to 24 MiB together and note the ones past that', async () => {
      zulip.downloadUpload.mockImplementation(
        async (path) => new File([new Uint8Array(10 * 1024 * 1024)], path.slice(path.lastIndexOf('/') + 1)),
      );

      await fromZulip(
        zulipMessage({
          content: ['a.bin', 'b.bin', 'c.bin'].map((name) => `[${name}](/user_uploads/2/ab/cdef/${name})`).join('\n'),
        }),
      );

      expect(sent(0).files?.map(({ name }) => name)).toEqual(['a.bin', 'b.bin']);
      expect(sent(0).content).toBe('*(attachment not mirrored: c.bin)*');
    });

    it('should note the uploads it has no time left for, well before the queue gives up on the message', async () => {
      vitest.useFakeTimers();
      zulip.downloadUpload.mockImplementation(async (path, _maxBytes, signal) => {
        await new Promise((resolve) => setTimeout(resolve, 70_000));
        signal?.throwIfAborted();
        return new File(['bytes'], path.slice(path.lastIndexOf('/') + 1));
      });

      for (const handler of stub.handlers.message) {
        await handler(
          zulipMessage({
            content: ['a.png', 'b.png', 'c.png'].map((name) => `[${name}](/user_uploads/2/ab/cdef/${name})`).join('\n'),
          }),
        );
      }
      await vitest.advanceTimersByTimeAsync(150_000);
      await sut.whenIdle();

      expect(zulip.downloadUpload).toHaveBeenCalledTimes(2);
      expect(sent(0).files?.map(({ name }) => name)).toEqual(['a.png']);
      expect(sent(0).content).toBe('*(attachment not mirrored: b.png)*\n*(attachment not mirrored: c.png)*');
      expect(warn()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: could not download upload 2 of Zulip message 1001: The files of this message took too long to transfer`,
      );
    });

    it('should resend without files when Discord finds the message too large', async () => {
      discord.sendMirrorMessage.mockRejectedValueOnce(new DiscordMirrorError('too-large', 40_005));

      await fromZulip(zulipMessage({ content: 'look\n[shot.png](/user_uploads/2/ab/cdef/shot.png)' }));

      expect(discord.sendMirrorMessage).toHaveBeenCalledTimes(2);
      expect(sent(1)).toEqual(
        expect.objectContaining({ content: 'look\n*(attachment not mirrored: shot.png)*', files: [] }),
      );
      expect(db.messages).toHaveLength(1);
    });

    it('should attach an upload linked inside a spoiler as a spoiler, and hide its note too', async () => {
      zulip.downloadUpload.mockImplementation(async (path) =>
        path.endsWith('big.zip') ? undefined : new File(['bytes'], 'shot.png', { type: 'image/png' }),
      );

      await fromZulip(
        zulipMessage({
          content:
            'look\n```spoiler Plot twist\n[shot.png](/user_uploads/2/ab/cdef/shot.png)\n[big.zip](/user_uploads/2/ab/cdef/big.zip)\n```',
        }),
      );

      expect(sent(0).files?.map(({ name, type }) => [name, type])).toEqual([['SPOILER_shot.png', 'image/png']]);
      expect(sent(0).content).toBe('look\n**Plot twist**\n||*(attachment not mirrored: big.zip)*||');
    });

    it('should keep the note of a spoilered file hidden when Discord finds the message too large', async () => {
      discord.sendMirrorMessage.mockRejectedValueOnce(new DiscordMirrorError('too-large', 40_005));

      await fromZulip(zulipMessage({ content: '```spoiler\n[shot.png](/user_uploads/2/ab/cdef/shot.png)\n```' }));

      expect(sent(1).content).toBe('**Spoiler**\n||*(attachment not mirrored: shot.png)*||');
    });

    it('should recreate a deleted webhook and retry once, at most once an hour', async () => {
      discord.sendMirrorMessage.mockRejectedValueOnce(new DiscordMirrorError('unknown-webhook', 10_015));
      await fromZulip(zulipMessage());

      expect(discord.ensureMirrorWebhook).toHaveBeenCalledWith(DEV_CHANNEL);
      expect(discord.ensureMirrorWebhook).toHaveBeenLastCalledWith(DEV_CHANNEL);
      expect(discord.sendMirrorMessage).toHaveBeenCalledTimes(2);
      expect(db.messages).toHaveLength(1);

      discord.sendMirrorMessage.mockRejectedValueOnce(new DiscordMirrorError('unknown-webhook', 10_015));
      await fromZulip(zulipMessage({ id: 1002 }));

      expect(discord.ensureMirrorWebhook).toHaveBeenCalledWith(DEV_CHANNEL);
      expect(error()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: the Zulip mirror webhook in #dev (${DEV_CHANNEL}) was deleted again; deny the bot Manage Webhooks there to stop the mirror, or wait an hour`,
      );
      expect(zulip.sendMessage).not.toHaveBeenCalled();

      vitest.useFakeTimers();
      vitest.advanceTimersByTime(60 * 60 * 1000);
      discord.sendMirrorMessage.mockRejectedValueOnce(new DiscordMirrorError('unknown-webhook', 10_015));
      await fromZulip(zulipMessage({ id: 1003 }));

      expect(discord.ensureMirrorWebhook).toHaveBeenCalledTimes(5);
      expect(db.messages.map(({ zulipMessageId }) => zulipMessageId)).toEqual([1001, 1003]);
    });

    it('should start a new thread when the Discord thread no longer exists', async () => {
      const thread = seedThread();
      discord.sendMirrorMessage.mockRejectedValueOnce(new DiscordMirrorError('unknown-channel', 10_003));

      await fromZulip(zulipMessage({ topic: 'Crash on upload' }));

      expect(sent(0).threadId).toBe(thread.discordThreadId);
      expect(sent(1).threadId).toBeUndefined();
      expect(discord.startMirrorThread).toHaveBeenCalledOnce();
      expect(db.conversations).toEqual([
        expect.objectContaining({ zulipTopicKey: 'crash on upload', zulipAnchorMessageId: 1001 }),
      ]);
      expect(db.conversations[0].discordThreadId).not.toBe(thread.discordThreadId);
    });

    it('should post a throttled notice when the channel refuses the bot', async () => {
      discord.sendMirrorMessage.mockRejectedValue(new DiscordMirrorError('forbidden', 50_013));

      await fromZulip(zulipMessage());
      await fromZulip(zulipMessage({ id: 1002 }));

      expect(sentMessages()).toEqual([
        {
          stream: DEV_STREAM,
          topic: '#dev',
          content: '⚠ Not mirrored to Discord: the bot is missing permissions in the Discord channel.',
        },
      ]);
      expect(error()).toHaveBeenCalledExactlyOnceWith(
        `${DEV_CHANNEL}: could not mirror Zulip message 1001 to Discord: forbidden (50013)`,
      );
    });

    it('should only warn when the Discord thread is locked', async () => {
      seedThread();
      discord.sendMirrorMessage.mockRejectedValue(new DiscordMirrorError('locked', 160_005));

      await fromZulip(zulipMessage({ topic: 'Crash on upload' }));

      expect(warn()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: could not mirror Zulip message 1001 to Discord: the Discord thread is locked`,
      );
      expect(zulip.sendMessage).not.toHaveBeenCalled();
    });

    it('should mark a message mirrored late', async () => {
      const timestamp = Math.floor(Date.now() / 1000) - 600;
      await fromZulip(zulipMessage({ timestamp }));

      expect(sent(0).content).toBe(`hello\n-# sent <t:${timestamp}:f>`);
    });

    it('should put the notes before the text when they do not fit next to the first part', async () => {
      zulip.downloadUpload.mockResolvedValue(undefined);

      await fromZulip(zulipMessage({ content: `${'x'.repeat(1990)}\n[big.zip](/user_uploads/2/ab/cdef/big.zip)` }));

      expect(discord.sendMirrorMessage.mock.calls.map(([{ content }]) => content)).toEqual([
        '*(attachment not mirrored: big.zip)*',
        'x'.repeat(1990),
      ]);
    });

    it('should post the notes alone when the only upload could not be attached', async () => {
      zulip.downloadUpload.mockRejectedValue(new Error('Zulip answered the download with status 404'));

      await fromZulip(zulipMessage({ content: '[shot.png](/user_uploads/2/ab/cdef/shot.png)' }));

      expect(sent(0)).toEqual(expect.objectContaining({ content: '*(attachment not mirrored: shot.png)*', files: [] }));
      expect(warn()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: could not download upload 1 of Zulip message 1001: Zulip answered the download with status 404`,
      );
    });

    it('should keep the parts already posted when a later part fails', async () => {
      discord.sendMirrorMessage.mockImplementation(async ({ channelId, content }) => {
        if (content.startsWith('b')) {
          throw new DiscordMirrorError('other', undefined, 'HTTP 503');
        }
        return { messageId: '600000000000000001', channelId, webhookId: WEBHOOK };
      });

      await fromZulip(zulipMessage({ content: paragraphs('a', 'b', 'c') }));

      expect(discord.sendMirrorMessage).toHaveBeenCalledTimes(2);
      expect(db.messages.map(({ part }) => part)).toEqual([0]);
      expect(error()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: could not mirror part 2 of Zulip message 1001 to Discord: other`,
      );
    });

    it('should move the main conversation to a main topic that changed', async () => {
      seedThread({ discordThreadId: null, zulipTopic: '#old', zulipTopicKey: '#old', zulipAnchorMessageId: null });

      await fromZulip(zulipMessage());

      expect(sent(0).threadId).toBeUndefined();
      expect(db.conversations).toEqual([expect.objectContaining({ zulipTopic: '#dev', zulipTopicKey: '#dev' })]);
    });

    it('should let a thread go whose topic a changed main topic now names', async () => {
      seedThread({ discordThreadId: null, zulipTopic: '#old', zulipTopicKey: '#old', zulipAnchorMessageId: null });
      seedThread({ zulipTopic: '#Dev', zulipTopicKey: '#dev' });

      await fromDiscord(discordMessage());
      await fromZulip(zulipMessage());

      expect(sentMessages()[0].topic).toBe('#dev');
      expect(sent(0).threadId).toBeUndefined();
      expect(db.conversations).toEqual([
        expect.objectContaining({ discordThreadId: null, zulipTopic: '#dev', zulipTopicKey: '#dev' }),
      ]);
      expect(log()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: detached the conversation of Discord thread 200000000000000001: its Zulip topic is now the main topic`,
      );
    });

    it('should post in the channel from a main topic a thread still holds', async () => {
      seedThread({ zulipTopic: '#Dev', zulipTopicKey: '#dev' });

      await fromZulip(zulipMessage());

      expect(sent(0).threadId).toBeUndefined();
      expect(db.conversations).toEqual([expect.objectContaining({ discordThreadId: null, zulipTopicKey: '#dev' })]);
    });

    it('should log a notice that cannot be posted', async () => {
      discord.sendMirrorMessage.mockRejectedValue(new DiscordMirrorError('forbidden', 50_013));
      zulip.sendMessage.mockRejectedValue(new TypeError('fetch failed'));

      await fromZulip(zulipMessage());

      expect(error()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: could not post the not-mirrored notice in Zulip stream ${DEV_STREAM}: fetch failed`,
      );
    });

    it('should log an unexpected failure with its stack', async () => {
      const failure = new Error('bug');
      db.repository.getMirrorConversationByZulipTopic.mockRejectedValueOnce(failure);

      await fromZulip(zulipMessage());

      expect(error()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: could not mirror Zulip message 1001 to Discord: bug`,
        failure,
      );
    });

    it('should not wait for Discord when it is not ready, and say so once', async () => {
      discord.isReady.mockReturnValue(false);

      await fromZulip(zulipMessage());
      await fromZulip(zulipMessage({ id: 1002 }));

      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();
      expect(warn()).toHaveBeenCalledExactlyOnceWith(
        `${DEV_CHANNEL}: not mirroring yet: Discord is not ready; catch-up picks it up once both sides are`,
      );
    });
  });

  describe('the general chat main topic', () => {
    beforeEach(async () => {
      db.links[0].mainTopic = '';
      await start();
    });

    it('should post the channel messages to the empty topic', async () => {
      await fromDiscord(discordMessage());

      expect(sentMessages()).toEqual([
        { stream: DEV_STREAM, topic: '', content: '**Contrib** (&#64;contrib123): hello' },
      ]);
      expect(db.conversations).toEqual([
        expect.objectContaining({ discordThreadId: null, zulipTopic: '', zulipTopicKey: '' }),
      ]);
    });

    it('should take a message in the topic events call general chat into the channel, not a thread', async () => {
      await fromZulip(zulipMessage({ topic: 'general chat' }));
      await fromDiscord(discordMessage());

      expect(sent(0)).toEqual(expect.objectContaining({ channelId: DEV_CHANNEL, content: 'hello' }));
      expect(sent(0).threadId).toBeUndefined();
      expect(discord.startMirrorThread).not.toHaveBeenCalled();
      expect(db.conversations).toHaveLength(1);
    });

    it('should know the empty topic by the name the realm gave at registration', async () => {
      stub.service.emptyTopicName = 'allgemein';

      await fromZulip(zulipMessage({ topic: 'allgemein' }));

      expect(discord.startMirrorThread).not.toHaveBeenCalled();
      expect(db.conversations).toEqual([expect.objectContaining({ zulipTopic: '', discordThreadId: null })]);
    });

    it('should give a topic really named General Chat a thread of its own', async () => {
      await fromZulip(zulipMessage({ topic: 'General Chat' }));

      expect(discord.startMirrorThread).toHaveBeenCalledExactlyOnceWith(
        DEV_CHANNEL,
        expect.any(String),
        'General Chat',
      );
      expect(db.conversations).toEqual([
        expect.objectContaining({ zulipTopic: 'General Chat', zulipTopicKey: 'general chat' }),
      ]);
    });

    it('should catch up the empty topic into the channel', async () => {
      seedRow({ zulipMessageId: 900, createdAt: new Date() });
      zulip.getStreamMessagesBefore.mockResolvedValue([zulipMessage({ id: 1001, topic: 'general chat' })]);

      await register();

      expect(sent(0)).toEqual(expect.objectContaining({ channelId: DEV_CHANNEL, content: 'hello' }));
      expect(discord.startMirrorThread).not.toHaveBeenCalled();
    });
  });

  describe('filters', () => {
    beforeEach(start);

    it.each([
      ['a stream without a pair', { streamId: 107 }],
      ['a direct message', { type: 'private' as const, streamId: undefined }],
      ['a command to the bot', { content: `@**${BOT.fullName}** help` }],
      ['an email Zulip received', { senderEmail: 'EmailGateway@zulip.com', senderFullName: 'Email Gateway' }],
    ])('should ignore %s', async (_, overrides) => {
      await fromZulip(zulipMessage(overrides));

      expect(db.repository.getMirrorMessagesByZulipIds).not.toHaveBeenCalled();
      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();
    });

    it('should mirror a Zulip message only once', async () => {
      await fromZulip(zulipMessage());
      await fromZulip(zulipMessage());

      expect(discord.sendMirrorMessage).toHaveBeenCalledOnce();
    });

    it('should mirror a Discord message only once', async () => {
      await fromDiscord(discordMessage());
      await fromDiscord(discordMessage());

      expect(zulip.sendMessage).toHaveBeenCalledOnce();
    });

    it('should ignore a Discord message in a channel without a pair', async () => {
      await fromDiscord(discordMessage({ channelId: '100000000000000555' }));

      expect(sut.handlesChannel('100000000000000555')).toBe(false);
      expect(db.repository.getMirrorMessagesByDiscordIds).not.toHaveBeenCalled();
    });

    it('should ignore updates and deletions of messages it did not mirror', async () => {
      await updateFromZulip({ messageId: 42, content: 'edited' });
      await deleteFromZulip({ messageIds: [42] });
      sut.onDiscordMessageEdited(discordMessage());
      sut.onDiscordMessagesDeleted(DEV_CHANNEL, ['300000000000000001']);
      await sut.whenIdle();

      expect(discord.editMirrorMessage).not.toHaveBeenCalled();
      expect(discord.deleteMirrorMessage).not.toHaveBeenCalled();
      expect(zulip.updateMessage).not.toHaveBeenCalled();
      expect(zulip.deleteMessage).not.toHaveBeenCalled();
    });

    it('should ignore updates in a stream without a pair, and deletions there of messages it did not mirror', async () => {
      await updateFromZulip({ messageId: 42, content: 'edited', streamId: 107 });
      expect(db.repository.getMirrorMessagesByZulipIds).not.toHaveBeenCalled();

      await deleteFromZulip({ messageIds: [42], streamId: 107 });
      await deleteFromZulip({ messageIds: [43], streamId: undefined });

      expect(db.repository.markMirrorMessagesDeleted).not.toHaveBeenCalled();
      expect(discord.deleteMirrorMessage).not.toHaveBeenCalled();
    });
  });

  describe('Discord to Zulip', () => {
    beforeEach(start);

    it('should post a channel message in the main topic', async () => {
      await fromDiscord(discordMessage());

      expect(sentMessages()).toEqual([
        { stream: DEV_STREAM, topic: '#dev', content: '**Contrib** (&#64;contrib123): hello' },
      ]);
      expect(db.messages).toEqual([
        expect.objectContaining({
          discordMessageId: '300000000000000001',
          origin: 'discord',
          discordAuthorId: CONTRIBUTOR,
          discordThreadId: null,
          zulipMessageId: 5001,
          zulipHeader: '**Contrib** (&#64;contrib123)',
          zulipAttachments: null,
          conversationId: db.conversations[0].id,
        }),
      ]);
    });

    it('should open a new topic for a thread, never one that exists on Zulip', async () => {
      zulip.getMessages.mockImplementation(async ({ topic }) =>
        topic === 'Crash on upload' ? [zulipMessage({ id: 1 })] : [],
      );

      await fromDiscord(
        discordMessage({ threadId: '200000000000000001', threadName: '  Crash on upload ', content: 'it crashes' }),
      );

      expect(zulip.getMessages).toHaveBeenCalledWith({ stream: DEV_STREAM, topic: 'Crash on upload', numBefore: 1 });
      expect(sentMessages()).toEqual([
        { stream: DEV_STREAM, topic: 'Crash on upload (2)', content: '**Contrib** (&#64;contrib123): it crashes' },
      ]);
      expect(db.conversations).toEqual([
        expect.objectContaining({
          discordThreadId: '200000000000000001',
          zulipTopic: 'Crash on upload (2)',
          zulipAnchorMessageId: 5001,
        }),
      ]);
    });

    it('should give a second thread of the same name a topic of its own', async () => {
      await fromDiscord(discordMessage({ threadId: '200000000000000001', threadName: 'Bug' }));
      await fromDiscord(
        discordMessage({ id: '300000000000000002', threadId: '200000000000000002', threadName: 'Bug' }),
      );

      expect(sentMessages().map(({ topic }) => topic)).toEqual(['Bug', 'Bug (2)']);
    });

    it('should never give a thread the main topic', async () => {
      await fromDiscord(discordMessage({ threadId: '200000000000000001', threadName: '#DEV' }));

      expect(sentMessages()[0].topic).toBe('#DEV (2)');
    });

    it('should never open a topic that is already resolved', async () => {
      const postId = '300000000000000007';
      await fromDiscord(
        discordMessage({ id: postId, channelId: FORUM, threadId: postId, threadName: '✔ quick question' }),
      );

      expect(sentMessages()[0]).toEqual(expect.objectContaining({ stream: FORUM_STREAM, topic: 'quick question' }));
    });

    describe('the thread context line', () => {
      const THREAD = '300000000000000050';
      const starter = (overrides: Partial<DiscordSourceMessage> = {}) =>
        discordMessage({
          id: THREAD,
          content: 'is it the thumbnails?',
          author: { id: '400000000000000050', username: 'alex', displayName: 'Alex' },
          ...overrides,
        });
      const inThread = (id: string) =>
        discordMessage({ id, threadId: THREAD, threadName: 'Thumbnails', content: 'yes' });

      it('should link the Zulip copy of the message a thread started from, and quote it, in the first message only', async () => {
        const main = await db.repository.createMirrorConversation({
          discordChannelId: DEV_CHANNEL,
          discordThreadId: null,
          zulipStreamId: DEV_STREAM,
          zulipTopic: '#dev',
          zulipTopicKey: '#dev',
        });
        seedRow({ discordMessageId: THREAD, origin: 'discord', zulipMessageId: 70, conversationId: main.id });
        discord.fetchMirrorMessage.mockResolvedValue(starter());

        await fromDiscord(inThread('300000000000000051'));
        await fromDiscord(inThread('300000000000000052'));

        expect(discord.fetchMirrorMessage).toHaveBeenCalledExactlyOnceWith(DEV_CHANNEL, THREAD);
        expect(sentMessages().map(({ content }) => content)).toEqual([
          '↪ Thread started from [a message](#narrow/channel/900/topic/.23dev/with/70) by **Alex**:\n~~~ quote\nis it the thumbnails?\n~~~\n**Contrib** (&#64;contrib123): yes',
          '**Contrib** (&#64;contrib123): yes',
        ]);
        expect(
          db.messages.find(({ discordMessageId }) => discordMessageId === '300000000000000051')?.zulipHeader,
        ).toMatch(/^↪ Thread started from/);
      });

      it('should link the Discord message a thread started from when it was never mirrored', async () => {
        discord.fetchMirrorMessage.mockResolvedValue(starter({ content: '' }));

        await fromDiscord(inThread('300000000000000051'));

        expect(sentMessages()[0].content).toBe(
          `↪ Thread started from [a message](https://discord.com/channels/${GUILD}/${DEV_CHANNEL}/${THREAD}) by **Alex** on Discord\n**Contrib** (&#64;contrib123): yes`,
        );
      });

      it('should add nothing to a thread started without a message, or whose message cannot be read', async () => {
        await fromDiscord(inThread('300000000000000051'));
        discord.fetchMirrorMessage.mockRejectedValue(new DiscordMirrorError('forbidden', 50_001));
        await fromDiscord(
          discordMessage({ id: '300000000000000053', threadId: '300000000000000060', threadName: 'Other' }),
        );

        expect(sentMessages().map(({ content }) => content)).toEqual([
          '**Contrib** (&#64;contrib123): yes',
          '**Contrib** (&#64;contrib123): hello',
        ]);
        expect(warn()).toHaveBeenCalledWith(
          `${DEV_CHANNEL}: could not read the message Discord thread 300000000000000060 was started from: forbidden (50001)`,
        );
      });

      it('should not look for one in a forum, whose posts start with their first message', async () => {
        const post = '300000000000000007';
        await fromDiscord(discordMessage({ id: post, channelId: FORUM, threadId: post, threadName: 'Feature idea' }));

        expect(discord.fetchMirrorMessage).not.toHaveBeenCalled();
      });
    });

    describe('forum tags', () => {
      const POST = '300000000000000007';
      const starter = (threadTags: string[], content = 'the post') =>
        discordMessage({ id: POST, channelId: FORUM, threadId: POST, threadName: 'Feature idea', threadTags, content });
      const tagsChanged = async (tags: string[]) => {
        sut.onDiscordThreadTagsChanged({ channelId: FORUM, threadId: POST, tags });
        await sut.whenIdle();
      };

      it('should show the tags of a new post in the first message of its topic', async () => {
        await fromDiscord(starter(['bug', 'mobile']));
        await fromDiscord(
          discordMessage({
            id: '300000000000000008',
            channelId: FORUM,
            threadId: POST,
            threadName: 'Feature idea',
            threadTags: ['bug'],
          }),
        );

        expect(sentMessages().map(({ content }) => content)).toEqual([
          '**Tags:** bug, mobile\n**Contrib** (&#64;contrib123): the post',
          '**Contrib** (&#64;contrib123): hello',
        ]);
      });

      it('should edit the tags of the first message when they change, keeping the post as it is now', async () => {
        await fromDiscord(starter(['bug']));
        discord.fetchMirrorMessage.mockResolvedValue(starter(['bug', 'mobile'], 'the post, edited'));
        zulip.getMessage.mockResolvedValue({ id: 5001, topic: 'Feature idea', streamId: FORUM_STREAM });

        await tagsChanged(['bug', 'mobile']);

        expect(discord.fetchMirrorMessage).toHaveBeenCalledExactlyOnceWith(POST, POST);
        expect(zulip.updateMessage).toHaveBeenCalledExactlyOnceWith(5001, {
          content: '**Tags:** bug, mobile\n**Contrib** (&#64;contrib123): the post, edited',
        });
        expect(db.messages[0].zulipHeader).toBe('**Tags:** bug, mobile\n**Contrib** (&#64;contrib123)');
        expect(zulip.sendMessage).toHaveBeenCalledOnce();

        await tagsChanged(['bug', 'mobile']);
        expect(zulip.updateMessage).toHaveBeenCalledOnce();
      });

      it('should post the tags when Zulip refuses the edit, or a Zulip user started the topic', async () => {
        await fromDiscord(starter([]));
        discord.fetchMirrorMessage.mockResolvedValue(starter(['bug']));
        zulip.getMessage.mockResolvedValue({ id: 5001, topic: 'Feature idea', streamId: FORUM_STREAM });
        zulip.updateMessage.mockRejectedValueOnce(
          new ZulipApiError(400, 'BAD_REQUEST', 'The time limit for editing this message has passed', 'PATCH'),
        );

        await tagsChanged(['bug']);

        expect(sentMessages().at(-1)).toEqual({
          stream: FORUM_STREAM,
          topic: 'Feature idea',
          content: 'Tags changed: bug',
        });
        expect(db.messages[0].zulipHeader).toBe('**Contrib** (&#64;contrib123)');
      });

      it('should post the tags in a topic started on Zulip, and nothing for a post that is not mirrored', async () => {
        await fromZulip(zulipMessage({ streamId: FORUM_STREAM, topic: 'From Zulip' }));
        const postId = db.conversations[0].discordThreadId!;
        zulip.getMessage.mockResolvedValue({ id: 1001, topic: 'From Zulip', streamId: FORUM_STREAM });

        sut.onDiscordThreadTagsChanged({ channelId: FORUM, threadId: postId, tags: [] });
        sut.onDiscordThreadTagsChanged({ channelId: FORUM, threadId: '300000000000000099', tags: ['bug'] });
        await sut.whenIdle();

        expect(sentMessages()).toEqual([{ stream: FORUM_STREAM, topic: 'From Zulip', content: 'Tags changed: none' }]);
        expect(discord.fetchMirrorMessage).not.toHaveBeenCalled();
      });
    });

    it('should post a forum starter once, as the first message of its topic', async () => {
      const post = '300000000000000007';
      await fromDiscord(discordMessage({ id: post, channelId: FORUM, threadId: post, threadName: 'Feature idea' }));

      expect(sentMessages()).toEqual([
        { stream: FORUM_STREAM, topic: 'Feature idea', content: '**Contrib** (&#64;contrib123): hello' },
      ]);
      expect(db.conversations).toEqual([
        expect.objectContaining({ discordChannelId: FORUM, discordThreadId: post, zulipAnchorMessageId: 5001 }),
      ]);
    });

    it('should re-read the topic of a conversation once per queue registration', async () => {
      const thread = seedThread({ zulipTopic: 'old', zulipTopicKey: 'old', zulipAnchorMessageId: 42 });
      zulip.getMessage.mockResolvedValue({ id: 42, topic: 'New', streamId: DEV_STREAM });

      await fromDiscord(discordMessage({ threadId: thread.discordThreadId, threadName: 'old' }));
      await fromDiscord(
        discordMessage({ id: '300000000000000002', threadId: thread.discordThreadId, threadName: 'old' }),
      );

      expect(zulip.getMessage).toHaveBeenCalledExactlyOnceWith(42);
      expect(sentMessages().map(({ topic }) => topic)).toEqual(['New', 'New']);
      expect(db.conversations[0]).toEqual(expect.objectContaining({ zulipTopic: 'New', zulipTopicKey: 'new' }));

      await register();
      await fromDiscord(
        discordMessage({ id: '300000000000000003', threadId: thread.discordThreadId, threadName: 'old' }),
      );
      expect(zulip.getMessage).toHaveBeenCalledTimes(2);
    });

    it('should keep the stored topic when the anchor is in the empty topic', async () => {
      const thread = seedThread({ zulipTopic: '', zulipTopicKey: '' });
      zulip.getMessage.mockResolvedValue({ id: 70, topic: '', streamId: DEV_STREAM });

      await fromDiscord(discordMessage({ threadId: thread.discordThreadId }));

      expect(sentMessages()[0].topic).toBe('');
      expect(db.repository.updateMirrorConversation).not.toHaveBeenCalled();
    });

    it('should follow an anchor moved to the empty topic', async () => {
      const thread = seedThread();
      zulip.getMessage.mockResolvedValue({ id: 70, topic: '', streamId: DEV_STREAM });

      await fromDiscord(discordMessage({ threadId: thread.discordThreadId }));

      expect(sentMessages()[0].topic).toBe('');
      expect(db.conversations[0]).toEqual(expect.objectContaining({ zulipTopic: '', zulipTopicKey: '' }));
    });

    it('should re-anchor a conversation whose anchor is gone', async () => {
      const thread = seedThread({ zulipAnchorMessageId: 42 });
      seedRow({ zulipMessageId: 60, conversationId: thread.id });
      zulip.getMessage.mockRejectedValue(new ZulipApiError(400, 'BAD_REQUEST', 'Invalid message(s)', 'GET'));

      await fromDiscord(discordMessage({ threadId: thread.discordThreadId }));

      expect(db.conversations[0].zulipAnchorMessageId).toBe(60);
      expect(sentMessages()[0].topic).toBe('Crash on upload');
    });

    it('should keep the anchor when its topic cannot be read for now', async () => {
      const thread = seedThread({ zulipAnchorMessageId: 42 });
      vitest.useFakeTimers();
      zulip.getMessage.mockRejectedValue(new TypeError('fetch failed'));

      sut.onDiscordMessage(discordMessage({ threadId: thread.discordThreadId }));
      await vitest.advanceTimersByTimeAsync(6000);
      await sut.whenIdle();

      expect(zulip.getMessage).toHaveBeenCalledTimes(3);
      expect(warn()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: could not check the Zulip topic of Discord thread ${thread.discordThreadId}: fetch failed`,
      );
      expect(db.conversations[0].zulipAnchorMessageId).toBe(42);
      expect(sentMessages()[0].topic).toBe('Crash on upload');
    });

    it('should anchor a thread without an anchor to the next Discord message', async () => {
      const thread = seedThread({ zulipAnchorMessageId: null });

      await fromDiscord(discordMessage({ threadId: thread.discordThreadId }));

      expect(zulip.getMessage).not.toHaveBeenCalled();
      expect(db.conversations[0].zulipAnchorMessageId).toBe(5001);
    });

    it('should detach a conversation whose anchor was moved to another stream', async () => {
      const thread = seedThread({ zulipAnchorMessageId: 42 });
      zulip.getMessage.mockResolvedValue({ id: 42, topic: 'Crash on upload', streamId: 950 });

      await fromDiscord(discordMessage({ threadId: thread.discordThreadId, threadName: 'Crash on upload' }));

      expect(log()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: detached the conversation of Discord thread ${thread.discordThreadId}: its Zulip topic was moved to another stream`,
      );
      expect(sentMessages()).toEqual([expect.objectContaining({ stream: DEV_STREAM, topic: 'Crash on upload' })]);
      expect(db.conversations).toEqual([
        expect.objectContaining({ discordThreadId: thread.discordThreadId, zulipAnchorMessageId: 5001 }),
      ]);
    });

    it('should detach a conversation whose topic became the main topic', async () => {
      const thread = seedThread({ zulipAnchorMessageId: 42 });
      zulip.getMessage.mockResolvedValue({ id: 42, topic: '#dev', streamId: DEV_STREAM });

      await fromDiscord(discordMessage({ threadId: thread.discordThreadId, threadName: 'Crash on upload' }));

      expect(sentMessages()).toEqual([expect.objectContaining({ topic: 'Crash on upload' })]);
      expect(db.conversations).toEqual([expect.objectContaining({ zulipTopicKey: 'crash on upload' })]);
    });

    it('should detach a conversation whose topic was merged into another one', async () => {
      seedThread({ id: 'other', discordThreadId: '200000000000000009', zulipTopic: 'Other', zulipTopicKey: 'other' });
      const thread = seedThread({ zulipAnchorMessageId: 42 });
      zulip.getMessage.mockResolvedValue({ id: 42, topic: 'other', streamId: DEV_STREAM });

      await fromDiscord(discordMessage({ threadId: thread.discordThreadId, threadName: 'Crash on upload' }));

      expect(db.conversations.map(({ id }) => id)).toEqual(['other', expect.any(String)]);
      expect(sentMessages()[0].topic).toBe('Crash on upload');
    });

    it('should translate a verified team member mention, or name them as text when the message is silent', async () => {
      const mentions = { users: { [TEAM_DISCORD_ID]: 'Alex' }, roles: {}, channels: {} };
      await fromDiscord(discordMessage({ content: `<@${TEAM_DISCORD_ID}> look`, mentions }));
      await fromDiscord(
        discordMessage({ id: '300000000000000002', content: `<@${TEAM_DISCORD_ID}> look`, mentions, silent: true }),
      );

      expect(sentMessages().map(({ content }) => content)).toEqual([
        `**Contrib** (&#64;contrib123): @**|${TEAM_ZULIP_ID}** look`,
        `**Contrib** (&#64;contrib123): &#64;Alex look`,
      ]);
    });

    it('should stop presenting a Discord user as a team member soon after they lose the role', async () => {
      vitest.useFakeTimers();
      const author = { id: TEAM_DISCORD_ID, username: 'alex.t', displayName: 'Alex' };
      await fromDiscord(discordMessage({ author }));
      discord.getTeamMember.mockResolvedValue({ ...TEAM_MEMBER, roleIds: [GUILD] });
      await fromDiscord(discordMessage({ id: '300000000000000002', author }));
      const checks = discord.getTeamMember.mock.calls.length;

      vitest.advanceTimersByTime(10 * 60 * 1000);
      await fromDiscord(
        discordMessage({
          id: '300000000000000003',
          author: { id: CONTRIBUTOR, username: 'contrib123', displayName: 'Contrib' },
          content: `<@${TEAM_DISCORD_ID}> hi`,
          mentions: { users: { [TEAM_DISCORD_ID]: 'Alex' }, roles: {}, channels: {} },
        }),
      );
      await fromDiscord(discordMessage({ id: '300000000000000004', author }));

      expect(discord.getTeamMember).toHaveBeenCalledTimes(checks + 1);
      expect(sentMessages().map(({ content }) => content)).toEqual([
        `@_**|${TEAM_ZULIP_ID}**: hello`,
        `@_**|${TEAM_ZULIP_ID}**: hello`,
        '**Contrib** (&#64;contrib123): &#64;Alex hi',
        '**Alex** (&#64;alex.t): hello',
      ]);
    });

    it('should mention the team member a contributor replies to on Zulip', async () => {
      await fromZulip(zulipMessage({ id: 55, senderId: TEAM_ZULIP_ID }));
      const copy = db.messages[0].discordMessageId;

      await fromDiscord(
        discordMessage({
          replyTo: { messageId: copy, authorDisplayName: 'Alex', content: 'hello' },
          content: 'thanks',
        }),
      );

      expect(sentMessages()[0].content).toBe(
        `**Contrib** (&#64;contrib123) ↩ @**|${TEAM_ZULIP_ID}** [said](#narrow/channel/${DEV_STREAM}/topic/.23dev/with/55):\n~~~ quote\nhello\n~~~\nthanks`,
      );
    });

    it('should name the author of a reply to a message that was not mirrored', async () => {
      await fromDiscord(
        discordMessage({ replyTo: { messageId: '300000000000000000', authorDisplayName: 'Sam', content: null } }),
      );

      expect(sentMessages()[0].content).toBe('**Contrib** (&#64;contrib123) ↩ **Sam**: hello');
    });

    it('should upload attachments and note the ones it could not', async () => {
      vitest
        .mocked(downloadDiscordAttachment)
        .mockResolvedValueOnce(new File(['log'], 'log [1].txt', { type: 'text/plain' }))
        .mockRejectedValueOnce(new Error('Discord answered the attachment download with status 404'));
      const attachment = {
        id: 'a1',
        name: 'log [1].txt',
        url: 'https://cdn.discordapp.com/a/1',
        size: 3,
        contentType: 'text/plain',
        spoiler: false,
      };

      await fromDiscord(
        discordMessage({ content: '', attachments: [attachment, { ...attachment, id: 'a2', name: 'gone.txt' }] }),
      );

      expect(downloadDiscordAttachment).toHaveBeenCalledWith(
        attachment,
        Constants.Mirror.MaxUploadBytes,
        expect.any(AbortSignal),
      );
      expect(zulip.uploadFile).toHaveBeenCalledExactlyOnceWith(expect.any(File), expect.any(AbortSignal));
      const content = sentMessages()[0].content;
      expect(content).toContain(`[log 1.txt](${UPLOAD_URL})`);
      expect(content).toContain('*(attachment not mirrored: gone.txt, see [Discord](https://discord.com/channels/');
      expect(db.messages[0].zulipAttachments).toContain(`[log 1.txt](${UPLOAD_URL})`);
      expect(warn()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: could not mirror attachment a2 of Discord message 300000000000000001: Discord answered the attachment download with status 404`,
      );
    });

    it('should note the attachments it has no time left for, well before the queue gives up on the message', async () => {
      vitest.useFakeTimers();
      vitest.mocked(downloadDiscordAttachment).mockImplementation(async (attachment, _maxBytes, signal) => {
        await new Promise((resolve) => setTimeout(resolve, 70_000));
        signal?.throwIfAborted();
        return new File(['log'], attachment.name);
      });
      const attachment = (name: string) => ({
        id: name,
        name,
        url: `https://cdn.discordapp.com/a/${name}`,
        size: 3,
        contentType: 'text/plain',
        spoiler: false,
      });

      sut.onDiscordMessage(
        discordMessage({
          content: 'logs',
          attachments: [attachment('a.txt'), attachment('b.txt'), attachment('c.txt')],
        }),
      );
      await vitest.advanceTimersByTimeAsync(150_000);
      await sut.whenIdle();

      expect(downloadDiscordAttachment).toHaveBeenCalledTimes(2);
      expect(zulip.uploadFile).toHaveBeenCalledOnce();
      const content = sentMessages()[0].content;
      expect(content).toContain('attachment not mirrored: b.txt');
      expect(content).toContain('attachment not mirrored: c.txt');
    });

    it('should not upload an attachment over the size limit', async () => {
      const attachment = {
        id: 'a1',
        name: 'huge.bin',
        url: 'https://cdn.discordapp.com/a/1',
        size: Constants.Mirror.MaxUploadBytes + 1,
        contentType: null,
        spoiler: false,
      };

      await fromDiscord(discordMessage({ attachments: [attachment] }));

      expect(downloadDiscordAttachment).not.toHaveBeenCalled();
      expect(sentMessages()[0].content).toContain('attachment not mirrored: huge.bin');
    });

    it('should skip an empty message', async () => {
      await fromDiscord(discordMessage({ content: '   ' }));

      expect(zulip.sendMessage).not.toHaveBeenCalled();
    });

    it('should mark a message mirrored late', async () => {
      const createdTimestamp = Date.now() - 600_000;
      await fromDiscord(discordMessage({ createdTimestamp }));

      expect(sentMessages()[0].content).toBe(
        `**Contrib** (&#64;contrib123) · <time:${new Date(createdTimestamp).toISOString()}>: hello`,
      );
    });

    it('should log a refused post and carry on', async () => {
      zulip.sendMessage.mockRejectedValueOnce(
        new ZulipApiError(400, 'BAD_REQUEST', 'Content too long', 'POST /messages'),
      );

      await fromDiscord(discordMessage());
      await fromDiscord(discordMessage({ id: '300000000000000002' }));

      expect(error()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: could not mirror Discord message 300000000000000001 to Zulip: Zulip POST /messages failed with 400 BAD_REQUEST: Content too long`,
      );
      expect(zulip.sendMessage).toHaveBeenCalledTimes(2);
      expect(db.messages.map(({ discordMessageId }) => discordMessageId)).toEqual(['300000000000000002']);
    });

    it('should hold the next messages back for catch-up after a post Zulip never took', async () => {
      zulip.sendMessage.mockRejectedValueOnce(
        new ZulipApiError(429, 'RATE_LIMIT_HIT', 'API usage exceeded rate limit', 'POST /messages'),
      );

      await fromDiscord(discordMessage());
      await fromDiscord(discordMessage({ id: '300000000000000002' }));

      expect(error()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: could not mirror Discord message 300000000000000001 to Zulip: Zulip POST /messages failed with 429 RATE_LIMIT_HIT: API usage exceeded rate limit`,
      );
      expect(zulip.sendMessage).toHaveBeenCalledOnce();
      expect(db.messages).toEqual([]);
    });

    it('should carry on after a post Zulip may have taken', async () => {
      zulip.sendMessage.mockRejectedValueOnce(new ZulipApiError(502, 'BAD_GATEWAY', 'down', 'POST /messages'));

      await fromDiscord(discordMessage());
      await fromDiscord(discordMessage({ id: '300000000000000002' }));

      expect(zulip.sendMessage).toHaveBeenCalledTimes(2);
      expect(db.messages.map(({ discordMessageId }) => discordMessageId)).toEqual(['300000000000000002']);
    });

    it('should not wait for Zulip when it is not ready, and say so once', async () => {
      zulip.isInitialised.mockReturnValue(false);

      await fromDiscord(discordMessage());
      await fromDiscord(discordMessage({ id: '300000000000000002' }));

      expect(zulip.sendMessage).not.toHaveBeenCalled();
      expect(warn()).toHaveBeenCalledExactlyOnceWith(
        `${DEV_CHANNEL}: not mirroring yet: Zulip is not ready; catch-up picks it up once both sides are`,
      );
    });
  });

  describe('edits', () => {
    beforeEach(start);

    it('should leave Zulip alone when the Discord source is unchanged', async () => {
      await fromDiscord(discordMessage());
      sut.onDiscordMessageEdited(discordMessage({ attachments: [] }));
      await sut.whenIdle();

      expect(zulip.updateMessage).not.toHaveBeenCalled();
    });

    it('should edit the Zulip copy with the stored header and attachments', async () => {
      await fromDiscord(discordMessage());
      sut.onDiscordMessageEdited(discordMessage({ content: 'hello again' }));
      await sut.whenIdle();

      expect(zulip.updateMessage).toHaveBeenCalledExactlyOnceWith(5001, {
        content: '**Contrib** (&#64;contrib123): hello again',
      });
      expect(db.messages[0].sourceHash).not.toBe(db.repository.createMirrorMessages.mock.calls[0][0][0].sourceHash);
    });

    it('should only log when Zulip refuses a late edit', async () => {
      await fromDiscord(discordMessage());
      const hash = db.messages[0].sourceHash;
      zulip.updateMessage.mockRejectedValue(
        new ZulipApiError(400, 'BAD_REQUEST', 'The time limit for editing this message has passed', 'PATCH'),
      );

      sut.onDiscordMessageEdited(discordMessage({ content: 'hello again' }));
      await sut.whenIdle();

      expect(log()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: Zulip refused the edit of message 5001 (the copy of Discord message 300000000000000001): Zulip PATCH failed with 400 BAD_REQUEST: The time limit for editing this message has passed`,
      );
      expect(zulip.sendMessage).toHaveBeenCalledOnce();
      expect(db.messages[0].sourceHash).toBe(hash);
    });

    it('should count an edit Zulip already has as done', async () => {
      await fromDiscord(discordMessage());
      zulip.updateMessage.mockRejectedValue(new ZulipApiError(400, 'BAD_REQUEST', 'Nothing to change', 'PATCH'));

      sut.onDiscordMessageEdited(discordMessage({ content: 'hello  ' }));
      await sut.whenIdle();

      expect(error()).not.toHaveBeenCalled();
      expect(zulip.updateMessage).toHaveBeenCalledOnce();
      expect(db.messages[0].sourceHash).toBe(discordSourceHash(discordMessage({ content: 'hello  ' })));
    });

    it('should keep the old source hash when an edit fails on the way, so a later edit tries again', async () => {
      await fromDiscord(discordMessage());
      const hash = db.messages[0].sourceHash;
      vitest.useFakeTimers();
      zulip.updateMessage.mockRejectedValue(new ZulipApiError(500, 'BAD_GATEWAY', 'down', 'PATCH'));

      sut.onDiscordMessageEdited(discordMessage({ content: 'hello again' }));
      await vitest.advanceTimersByTimeAsync(6000);
      await sut.whenIdle();

      expect(zulip.updateMessage).toHaveBeenCalledTimes(3);
      expect(db.messages[0].sourceHash).toBe(hash);
      expect(error()).toHaveBeenCalledExactlyOnceWith(
        `${DEV_CHANNEL}: could not edit Zulip message 5001 (the copy of Discord message 300000000000000001): Zulip PATCH failed with 500 BAD_GATEWAY: down`,
      );
    });

    it('should grow and shrink the Discord copy, never deleting part 0', async () => {
      await fromZulip(zulipMessage({ content: paragraphs('a', 'b') }));
      const [part0, part1] = db.messages.map((row) => row.discordMessageId);

      await updateFromZulip({ messageId: 1001, content: paragraphs('c', 'd', 'e') });

      expect(discord.editMirrorMessage.mock.calls).toEqual([
        [expect.objectContaining({ messageId: part0 }), { content: 'c'.repeat(1500), suppressEmbeds: false }],
        [expect.objectContaining({ messageId: part1 }), { content: 'd'.repeat(1500), suppressEmbeds: false }],
      ]);
      expect(sent(2)).toEqual({
        channelId: DEV_CHANNEL,
        username: 'Bea (Zulip)',
        content: 'e'.repeat(1500),
        pingUserIds: [],
        suppressEmbeds: false,
      });
      expect(db.messages.map(({ part }) => part)).toEqual([0, 1, 2]);

      discord.editMirrorMessage.mockClear();
      await updateFromZulip({ messageId: 1001, content: 'short' });

      expect(discord.editMirrorMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ messageId: part0, threadId: null, webhookId: WEBHOOK }),
        { content: 'short', suppressEmbeds: false },
      );
      expect(discord.deleteMirrorMessage).toHaveBeenCalledTimes(2);
      expect(db.messages.map(({ discordMessageId }) => discordMessageId)).toEqual([part0]);
    });

    it('should not post a part again after a Discord moderator removed one', async () => {
      await fromZulip(zulipMessage({ content: paragraphs('a', 'b', 'c') }));
      sut.onDiscordMessagesDeleted(DEV_CHANNEL, [db.messages[1].discordMessageId]);
      await sut.whenIdle();

      await updateFromZulip({ messageId: 1001, content: paragraphs('a', 'b', 'c', 'd') });

      expect(discord.editMirrorMessage).toHaveBeenCalledTimes(2);
      expect(discord.sendMirrorMessage).toHaveBeenCalledTimes(3);
    });

    it("should ask Zulip for the sender's name when an edit grows a message mirrored before a restart", async () => {
      seedRow({ zulipMessageId: 1001, zulipSenderId: 20, sourceHash: 'before the restart' });
      zulip.getMessage.mockResolvedValue({ id: 1001, topic: '#dev', streamId: DEV_STREAM, senderFullName: 'Bea' });

      await updateFromZulip({ messageId: 1001, content: paragraphs('a', 'b') });

      expect(zulip.getMessage).toHaveBeenCalledWith(1001);
      expect(sent(0)).toEqual(expect.objectContaining({ username: 'Bea (Zulip)', content: 'b'.repeat(1500) }));
    });

    it('should not quote back a message deleted since the reply to it was mirrored', async () => {
      await fromZulip(zulipMessage({ content: 'said by mistake' }));
      const reply = `@_**Bea|20** [said](https://zulip.example.com/#narrow/channel/900-dev/topic/.23dev/near/1001):\n\`\`\`quote\nsaid by mistake\n\`\`\`\nno worries`;
      await fromZulip(zulipMessage({ id: 1002, content: reply }));
      await deleteFromZulip({ messageIds: [1001] });

      await updateFromZulip({ messageId: 1002, content: `${reply}!` });

      expect(discord.editMirrorMessage).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        content: '-# ↩ replying to a deleted message\nno worries!',
        suppressEmbeds: false,
      });
    });

    it('should skip a Zulip edit that leaves the content as it was', async () => {
      await fromZulip(zulipMessage());
      await updateFromZulip({ messageId: 1001, content: 'hello' });

      expect(discord.editMirrorMessage).not.toHaveBeenCalled();
    });

    it('should unarchive the thread and retry an edit once', async () => {
      await fromZulip(zulipMessage({ topic: 'Crash', content: paragraphs('a', 'b') }));
      const threadId = db.conversations[0].discordThreadId;
      discord.editMirrorMessage
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new DiscordMirrorError('archived', 50_083));

      await updateFromZulip({ messageId: 1001, content: paragraphs('c', 'd') });

      expect(discord.unarchiveMirrorThread).toHaveBeenCalledExactlyOnceWith(threadId);
      expect(discord.editMirrorMessage).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['locked', new DiscordMirrorError('locked', 160_005), 'the Discord thread is locked'],
      [
        'replaced-webhook',
        new DiscordMirrorError('replaced-webhook'),
        'it was posted by a webhook that has since been replaced',
      ],
    ])('should warn when the copy cannot be edited: %s', async (_, failure, reason) => {
      await fromZulip(zulipMessage());
      discord.editMirrorMessage.mockRejectedValue(failure);

      await updateFromZulip({ messageId: 1001, content: 'edited' });

      expect(warn()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: could not update Discord message ${db.messages[0].discordMessageId} (the copy of Zulip message 1001): ${reason}`,
      );
    });

    it.each([
      ['unavailable', new DiscordMirrorError('unavailable', undefined, 'HTTP 503')],
      ['unreachable', new DiscordMirrorError('unreachable', undefined, 'getaddrinfo ENOTFOUND')],
    ])('should edit again soon when Discord is %s for now, before any later edit', async (_, failure) => {
      await fromZulip(zulipMessage({ content: paragraphs('a', 'b') }));
      vitest.useFakeTimers();
      discord.editMirrorMessage.mockResolvedValueOnce().mockRejectedValueOnce(failure);

      await updateFromZulip({ messageId: 1001, content: paragraphs('c', 'd') });
      await updateFromZulip({ messageId: 1001, content: paragraphs('e', 'f') });
      expect(discord.editMirrorMessage).toHaveBeenCalledTimes(2);
      expect(db.messages.map(({ sourceHash }) => sourceHash)).toEqual([expect.any(String), expect.any(String)]);
      expect(warn()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: Discord failed an edit or deletion for now, so it is tried again soon`,
      );

      await vitest.advanceTimersByTimeAsync(30_000);
      await sut.whenIdle();

      expect(discord.editMirrorMessage.mock.calls.map(([, { content }]) => content[0])).toEqual([
        'c',
        'd',
        'c',
        'd',
        'e',
        'f',
      ]);
      expect(error()).not.toHaveBeenCalled();
    });

    it('should give up on an edit Discord keeps failing after about ten minutes', async () => {
      await fromZulip(zulipMessage());
      vitest.useFakeTimers();
      discord.editMirrorMessage.mockRejectedValue(new DiscordMirrorError('unavailable', undefined, 'HTTP 503'));

      await updateFromZulip({ messageId: 1001, content: 'edited' });
      await vitest.advanceTimersByTimeAsync(20 * 30_000);
      await sut.whenIdle();

      expect(discord.editMirrorMessage).toHaveBeenCalledTimes(20);
      expect(error()).toHaveBeenCalledExactlyOnceWith(
        `${DEV_CHANNEL}: could not update Discord message ${db.messages[0].discordMessageId} (the copy of Zulip message 1001): unavailable`,
      );
    });

    it('should let a thread that no longer exists go, and say so in its topic, when an edit finds it gone', async () => {
      await fromZulip(zulipMessage({ topic: 'Crash' }));
      await fromZulip(zulipMessage({ id: 1002, topic: 'Crash' }));
      discord.editMirrorMessage.mockRejectedValue(new DiscordMirrorError('unknown-channel', 10_003));

      await updateFromZulip({ messageId: 1002, content: 'edited' });

      expect(db.conversations).toEqual([]);
      expect(sentMessages()).toEqual([
        {
          stream: DEV_STREAM,
          topic: 'Crash',
          content: 'The Discord thread for this topic was deleted; the next message here starts a new one.',
        },
      ]);
      expect(error()).not.toHaveBeenCalled();
    });

    it('should forget a copy a moderator deleted on Discord', async () => {
      await fromZulip(zulipMessage());
      discord.editMirrorMessage.mockRejectedValue(new DiscordMirrorError('unknown-message', 10_008));

      await updateFromZulip({ messageId: 1001, content: 'edited' });

      expect(db.messages).toEqual([expect.objectContaining({ deletedAt: expect.any(Date) })]);
      await updateFromZulip({ messageId: 1001, content: 'edited again' });
      expect(discord.editMirrorMessage).toHaveBeenCalledOnce();
    });

    it('should not post the last part again after a Discord moderator removed it', async () => {
      await fromZulip(zulipMessage({ content: paragraphs('a', 'b', 'c') }));
      sut.onDiscordMessagesDeleted(DEV_CHANNEL, [db.messages[2].discordMessageId]);
      await sut.whenIdle();

      await updateFromZulip({ messageId: 1001, content: paragraphs('a', 'b', 'c', 'd') });

      expect(discord.editMirrorMessage).toHaveBeenCalledTimes(2);
      expect(discord.sendMirrorMessage).toHaveBeenCalledTimes(3);
    });
  });

  describe('channel and topic links', () => {
    const streams: Record<number, string> = {
      [DEV_STREAM]: 'immich-dev',
      [OFF_TOPIC_STREAM]: 'immich-dev-off-topic',
      [FORUM_STREAM]: 'immich-dev-focus-topic',
    };

    beforeEach(async () => {
      zulip.getStream.mockImplementation(async (streamId) => ({ streamId, name: streams[streamId], inviteOnly: true }));
      await start();
    });

    it('should turn a Zulip link to a linked stream or mirrored topic into a Discord mention', async () => {
      const thread = seedThread({ zulipAnchorMessageId: 60 });

      await fromZulip(
        zulipMessage({
          content: `#**IMMICH-DEV** #**immich-dev>#dev** #**immich-dev>crash on upload** #narrow/channel/${FORUM_STREAM}-x #**immich-dev>new**`,
        }),
      );

      expect(sent(0).content).toBe(
        `<#${DEV_CHANNEL}> <#${DEV_CHANNEL}> <#${thread.discordThreadId}> <#${FORUM}> *(Zulip link)*`,
      );
      expect(zulip.getStream).toHaveBeenCalledOnce();
    });

    it('should read the stream names again after a queue registration', async () => {
      await fromZulip(zulipMessage({ content: '#**immich-dev**' }));
      await register();
      await fromZulip(zulipMessage({ id: 1002, content: '#**immich-dev**' }));

      expect(zulip.getStream).toHaveBeenCalledTimes(2);
    });

    it('should turn a Discord mention of a linked channel or mirrored thread into a Zulip link', async () => {
      const thread = seedThread();
      zulip.getMessage.mockResolvedValue({ id: 70, topic: 'Crash on upload', streamId: DEV_STREAM });

      await fromDiscord(
        discordMessage({
          content: `see <#${DEV_CHANNEL}>, <#${FORUM}>, <#${thread.discordThreadId}> and <#100000000000000555>`,
          mentions: { users: {}, roles: {}, channels: { '100000000000000555': 'rules' } },
        }),
      );

      expect(sentMessages()[0].content).toBe(
        '**Contrib** (&#64;contrib123): see #**immich-dev>#dev**, #**immich-dev-focus-topic**, #**immich-dev>Crash on upload** and &#35;rules',
      );
    });

    it('should leave a mention as text when the stream name cannot be read', async () => {
      zulip.getStream.mockRejectedValue(new Error('Zulip returned no stream 900'));

      await fromDiscord(
        discordMessage({
          content: `see <#${DEV_CHANNEL}>`,
          mentions: { users: {}, roles: {}, channels: { [DEV_CHANNEL]: 'dev' } },
        }),
      );

      expect(sentMessages()[0].content).toBe('**Contrib** (&#64;contrib123): see &#35;dev');
    });
  });

  describe('reactions', () => {
    const SOURCE = '300000000000000001';
    const EMOTE = '500000000000000003';
    const thumbsUp = { id: null, name: '👍', animated: false };
    const heart = { id: null, name: '❤', animated: false };
    const byBot = (emoji: object) => ({ ...emoji, userId: BOT.userId });

    const reactOnZulip = async (messageId: number) => {
      for (const handler of stub.handlers.reaction) {
        await handler({ op: 'add', userId: 20, messageId, emoji: { name: 'x', code: 'x', type: 'unicode_emoji' } });
      }
      await sut.whenIdle();
    };

    const reactOnDiscord = async (messageId = SOURCE) => {
      sut.onDiscordReactionsChanged(DEV_CHANNEL, messageId);
      await sut.whenIdle();
    };

    const zulipReactions = (reactions: object[]) =>
      zulip.getMessage.mockResolvedValue({ id: 70, topic: '', streamId: DEV_STREAM, reactions } as never);

    beforeEach(async () => {
      await start();
      discord.getEmotes.mockResolvedValue([
        { id: EMOTE, identifier: `fire:${EMOTE}`, name: 'fire', url: 'x', animated: false },
        {
          id: '500000000000000004',
          identifier: 'unsynced:500000000000000004',
          name: 'unsynced',
          url: 'y',
          animated: false,
        },
      ]);
      zulip.listEmoji.mockResolvedValue([{ id: '3', name: 'fire2', deactivated: false }]);
    });

    it('should write a Discord emote in a message as the realm emoji the emote sync made of it', async () => {
      await fromDiscord(discordMessage({ id: '300000000000000005', content: `hot <:fire:${EMOTE}>` }));

      expect(sentMessages()[0].content).toBe('**Contrib** (&#64;contrib123): hot :fire2:');
    });

    describe('Discord to Zulip', () => {
      beforeEach(() => {
        seedRow({ discordMessageId: SOURCE, origin: 'discord', discordWebhookId: null, zulipMessageId: 70 });
        zulipReactions([]);
      });

      it('should react on the Zulip copy as the bot once a Discord user reacts, by the emoji Zulip names', async () => {
        discord.getMirrorReactions.mockResolvedValue([
          { emoji: thumbsUp, count: 3, me: false },
          { emoji: { id: null, name: '❤️', animated: false }, count: 1, me: false },
          { emoji: { id: null, name: '👍🏽', animated: false }, count: 1, me: false },
        ]);

        await reactOnDiscord();

        expect(discord.getMirrorReactions).toHaveBeenCalledExactlyOnceWith({
          channelId: DEV_CHANNEL,
          threadId: null,
          messageId: SOURCE,
          webhookId: null,
        });
        expect(zulip.addReaction.mock.calls).toEqual([
          [70, { name: '+1', code: '1f44d', type: 'unicode_emoji' }],
          [70, { name: 'heart', code: '2764', type: 'unicode_emoji' }],
        ]);
        expect(zulip.removeReaction).not.toHaveBeenCalled();
      });

      it('should react with the realm emoji the emote sync made of a custom emote, renamed or not, and skip one it never made', async () => {
        discord.getMirrorReactions.mockResolvedValue([
          { emoji: { id: EMOTE, name: 'fire', animated: false }, count: 1, me: false },
          { emoji: { id: '500000000000000004', name: 'unsynced', animated: false }, count: 1, me: false },
        ]);

        await reactOnDiscord();

        expect(zulip.addReaction).toHaveBeenCalledExactlyOnceWith(70, {
          name: 'fire2',
          code: '3',
          type: 'realm_emoji',
        });
      });

      it("should take the bot's reaction back once no Discord user reacts with it, and leave Zulip users' alone", async () => {
        discord.getMirrorReactions.mockResolvedValue([{ emoji: thumbsUp, count: 1, me: true }]);
        zulipReactions([
          byBot({ name: '+1', code: '1f44d', type: 'unicode_emoji' }),
          { name: 'heart', code: '2764', type: 'unicode_emoji', userId: 20 },
        ]);

        await reactOnDiscord();

        expect(zulip.addReaction).not.toHaveBeenCalled();
        expect(zulip.removeReaction).toHaveBeenCalledExactlyOnceWith(70, {
          name: '+1',
          code: '1f44d',
          type: 'unicode_emoji',
        });
      });

      it('should count the reactions on every part of a split Zulip message', async () => {
        seedRow({ discordMessageId: '800000000000000001', zulipMessageId: 71, part: 0 });
        seedRow({ discordMessageId: '800000000000000002', zulipMessageId: 71, part: 1 });
        discord.getMirrorReactions.mockImplementation(async ({ messageId }) =>
          messageId === '800000000000000002' ? [{ emoji: thumbsUp, count: 1, me: false }] : [],
        );

        await reactOnDiscord('800000000000000001');

        expect(discord.getMirrorReactions).toHaveBeenCalledTimes(2);
        expect(zulip.getMessage).toHaveBeenCalledExactlyOnceWith(71);
        expect(zulip.addReaction).toHaveBeenCalledExactlyOnceWith(71, expect.objectContaining({ name: '+1' }));
      });

      it('should sync once for changes queued before it runs', async () => {
        sut.onDiscordReactionsChanged(DEV_CHANNEL, SOURCE);
        sut.onDiscordReactionsChanged(DEV_CHANNEL, SOURCE);
        await sut.whenIdle();
        await reactOnDiscord();

        expect(discord.getMirrorReactions).toHaveBeenCalledTimes(2);
      });

      it('should take a reaction Zulip already has, or has already lost, as done', async () => {
        discord.getMirrorReactions.mockResolvedValue([{ emoji: thumbsUp, count: 1, me: false }]);
        zulipReactions([byBot({ name: 'heart', code: '2764', type: 'unicode_emoji' })]);
        zulip.addReaction.mockRejectedValue(
          new ZulipApiError(400, 'REACTION_ALREADY_EXISTS', 'Reaction already exists.', 'POST'),
        );
        zulip.removeReaction.mockRejectedValue(
          new ZulipApiError(400, 'REACTION_DOES_NOT_EXIST', "Reaction doesn't exist.", 'DELETE'),
        );

        await reactOnDiscord();

        expect(zulip.addReaction).toHaveBeenCalledOnce();
        expect(zulip.removeReaction).toHaveBeenCalledOnce();
        expect(error()).not.toHaveBeenCalled();
      });

      it('should ignore a message that is not mirrored', async () => {
        await reactOnDiscord('300000000000000999');

        expect(discord.getMirrorReactions).not.toHaveBeenCalled();
        expect(zulip.getMessage).not.toHaveBeenCalled();
      });
    });

    describe('Zulip to Discord', () => {
      beforeEach(() => {
        seedRow({ discordMessageId: '800000000000000001', zulipMessageId: 70, part: 0 });
        seedRow({ discordMessageId: '800000000000000002', zulipMessageId: 70, part: 1 });
      });

      const target = { channelId: DEV_CHANNEL, threadId: null, messageId: '800000000000000001', webhookId: WEBHOOK };

      it('should react on the first part of the Discord copy as the bot, leaving out its own Zulip reactions', async () => {
        zulipReactions([
          { name: 'heart', code: '2764', type: 'unicode_emoji', userId: 20 },
          { name: 'heart', code: '2764', type: 'unicode_emoji', userId: 21 },
          { name: 'fire2', code: '3', type: 'realm_emoji', userId: 20 },
          { name: 'zulip', code: 'zulip', type: 'zulip_extra_emoji', userId: 20 },
          { name: 'other', code: '9', type: 'realm_emoji', userId: 20 },
          byBot({ name: '+1', code: '1f44d', type: 'unicode_emoji' }),
        ]);

        await reactOnZulip(70);

        expect(discord.addMirrorReaction.mock.calls).toEqual([
          [target, heart],
          [target, { id: EMOTE, name: 'fire', animated: false }],
        ]);
        expect(discord.removeMirrorReaction).not.toHaveBeenCalled();
      });

      it('should change none of its reactions while the emotes cannot be matched', async () => {
        discord.getMirrorReactions.mockResolvedValue([
          { emoji: { id: EMOTE, name: 'fire', animated: false }, count: 2, me: true },
        ]);
        zulipReactions([{ name: 'fire2', code: '3', type: 'realm_emoji', userId: BOT.userId }]);
        zulip.listEmoji.mockRejectedValueOnce(new ZulipApiError(401, 'UNAUTHORIZED', 'Invalid API key', 'GET'));
        discord.getEmotes.mockResolvedValueOnce([]).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);

        await reactOnZulip(70);
        await reactOnZulip(70);
        sut.onDiscordReactionsChanged(DEV_CHANNEL, '800000000000000001');
        await sut.whenIdle();

        expect(discord.removeMirrorReaction).not.toHaveBeenCalled();
        expect(zulip.removeReaction).not.toHaveBeenCalled();
        expect(error()).toHaveBeenCalledWith(
          `Could not match the Discord emotes of guild ${GUILD} with the Zulip realm emoji: Zulip GET failed with 401 UNAUTHORIZED: Invalid API key`,
        );
      });

      it('should try an emoji Discord does not know again with its variation selector', async () => {
        zulipReactions([{ name: 'heart', code: '2764', type: 'unicode_emoji', userId: 20 }]);
        discord.addMirrorReaction.mockRejectedValueOnce(new DiscordMirrorError('unknown-emoji', 10_014));

        await reactOnZulip(70);

        expect(discord.addMirrorReaction.mock.calls.map(([, emoji]) => emoji.name)).toEqual(['❤', '❤️']);
        expect(error()).not.toHaveBeenCalled();
      });

      it('should take its reaction back once no Zulip user reacts with it, whatever form Discord reports it in', async () => {
        zulipReactions([{ name: 'heart', code: '2764', type: 'unicode_emoji', userId: 20 }]);
        discord.getMirrorReactions.mockResolvedValue([
          { emoji: { id: null, name: '❤️', animated: false }, count: 2, me: true },
          { emoji: thumbsUp, count: 1, me: true },
          { emoji: { id: null, name: '🎉', animated: false }, count: 1, me: false },
        ]);

        await reactOnZulip(70);

        expect(discord.addMirrorReaction).not.toHaveBeenCalled();
        expect(discord.removeMirrorReaction).toHaveBeenCalledExactlyOnceWith(target, thumbsUp);
      });

      it('should look for the message in every pair, and touch only the one that has it', async () => {
        zulipReactions([{ name: 'heart', code: '2764', type: 'unicode_emoji', userId: 20 }]);

        await reactOnZulip(70);
        await reactOnZulip(9999);

        expect(zulip.getMessage).toHaveBeenCalledExactlyOnceWith(70);
        expect(discord.addMirrorReaction).toHaveBeenCalledOnce();
      });

      it('should wait while Discord is not ready', async () => {
        zulipReactions([{ name: 'heart', code: '2764', type: 'unicode_emoji', userId: 20 }]);
        discord.isReady.mockReturnValue(false);

        await reactOnZulip(70);
        expect(discord.addMirrorReaction).not.toHaveBeenCalled();

        discord.isReady.mockReturnValue(true);
        await sut.onDiscordReady();
        await sut.whenIdle();
        expect(discord.addMirrorReaction).toHaveBeenCalledOnce();
      });
    });
  });

  describe('deletions', () => {
    beforeEach(start);

    it('should delete the Zulip copy of a deleted Discord message, marking the row deleted first', async () => {
      await fromDiscord(discordMessage());

      sut.onDiscordMessagesDeleted(DEV_CHANNEL, ['300000000000000001']);
      await sut.whenIdle();

      expect(zulip.deleteMessage).toHaveBeenCalledExactlyOnceWith(5001);
      expect(db.repository.markMirrorMessagesDeleted.mock.invocationCallOrder[0]).toBeLessThan(
        zulip.deleteMessage.mock.invocationCallOrder[0],
      );
      expect(db.messages).toEqual([expect.objectContaining({ deletedAt: expect.any(Date) })]);

      await deleteFromZulip({ messageIds: [5001] });
      expect(discord.deleteMirrorMessage).not.toHaveBeenCalled();
      expect(zulip.deleteMessage).toHaveBeenCalledOnce();
    });

    it('should warn when Zulip refuses to delete a copy', async () => {
      await fromDiscord(discordMessage());
      zulip.deleteMessage.mockRejectedValue(
        new ZulipApiError(400, 'BAD_REQUEST', 'The time limit for deleting this message has passed', 'DELETE'),
      );

      sut.onDiscordMessagesDeleted(DEV_CHANNEL, ['300000000000000001']);
      await sut.whenIdle();

      expect(warn()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: Zulip refused to delete message 5001 (the copy of Discord message 300000000000000001); add the bot to the stream's can_delete_any_message_group`,
      );
    });

    it('should re-anchor without complaint when the Zulip copy is already gone', async () => {
      const thread = { threadId: '200000000000000001', threadName: 'Crash' };
      await fromDiscord(discordMessage(thread));
      await fromDiscord(discordMessage({ id: '300000000000000002', ...thread }));
      zulip.deleteMessage.mockRejectedValue(new ZulipApiError(400, 'BAD_REQUEST', 'Invalid message(s)', 'DELETE'));

      sut.onDiscordMessagesDeleted(DEV_CHANNEL, ['300000000000000001']);
      await sut.whenIdle();

      expect(warn()).not.toHaveBeenCalledWith(expect.stringContaining('refused'));
      expect(error()).not.toHaveBeenCalled();
      expect(db.conversations[0].zulipAnchorMessageId).toBe(5002);
    });

    it('should retry a delete that failed on the way', async () => {
      await fromDiscord(discordMessage());
      vitest.useFakeTimers();
      zulip.deleteMessage.mockRejectedValueOnce(new TypeError('fetch failed'));

      sut.onDiscordMessagesDeleted(DEV_CHANNEL, ['300000000000000001']);
      await vitest.advanceTimersByTimeAsync(1000);
      await sut.whenIdle();

      expect(zulip.deleteMessage).toHaveBeenCalledTimes(2);
    });

    it('should only forget a webhook copy a Discord moderator deleted', async () => {
      await fromZulip(zulipMessage());

      sut.onDiscordMessagesDeleted(DEV_CHANNEL, [db.messages[0].discordMessageId]);
      await sut.whenIdle();

      expect(db.messages).toEqual([expect.objectContaining({ deletedAt: expect.any(Date) })]);
      expect(zulip.deleteMessage).not.toHaveBeenCalled();
    });

    it('should delete every part of a deleted Zulip message on Discord', async () => {
      await fromZulip(zulipMessage({ content: paragraphs('a', 'b') }));
      const targets = db.messages.map((row) => ({
        channelId: DEV_CHANNEL,
        threadId: row.discordThreadId,
        messageId: row.discordMessageId,
        webhookId: WEBHOOK,
      }));

      await deleteFromZulip({ messageIds: [1001] });

      expect(discord.deleteMirrorMessage.mock.calls).toEqual(targets.map((target) => [target]));
      expect(db.messages.map(({ deletedAt }) => deletedAt)).toEqual([expect.any(Date), expect.any(Date)]);
    });

    it('should delete again soon when Discord fails for now, before any later deletion', async () => {
      await fromZulip(zulipMessage({ content: paragraphs('a', 'b') }));
      await fromZulip(zulipMessage({ id: 1002 }));
      vitest.useFakeTimers();
      discord.deleteMirrorMessage
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new DiscordMirrorError('unavailable', undefined, 'HTTP 503'));

      await deleteFromZulip({ messageIds: [1001] });
      await deleteFromZulip({ messageIds: [1002] });
      expect(discord.deleteMirrorMessage).toHaveBeenCalledTimes(2);

      await vitest.advanceTimersByTimeAsync(30_000);
      await sut.whenIdle();

      expect(discord.deleteMirrorMessage.mock.calls.map(([{ messageId }]) => messageId)).toEqual([
        db.messages[0].discordMessageId,
        db.messages[1].discordMessageId,
        db.messages[1].discordMessageId,
        db.messages[2].discordMessageId,
      ]);
      expect(error()).not.toHaveBeenCalled();
    });

    it('should name the copy it could not delete', async () => {
      await fromZulip(zulipMessage());
      discord.deleteMirrorMessage.mockRejectedValue(new DiscordMirrorError('forbidden', 50_013));

      await deleteFromZulip({ messageIds: [1001] });

      expect(error()).toHaveBeenCalledExactlyOnceWith(
        `${DEV_CHANNEL}: could not delete Discord message ${db.messages[0].discordMessageId} (the copy of Zulip message 1001): forbidden (50013)`,
      );
    });

    it('should let a thread that no longer exists go, and say so in its topic, when a deletion finds it gone', async () => {
      await fromZulip(zulipMessage({ topic: 'Crash' }));
      await fromZulip(zulipMessage({ id: 1002, topic: 'Crash' }));
      discord.deleteMirrorMessage.mockRejectedValue(new DiscordMirrorError('unknown-channel', 10_003));

      await deleteFromZulip({ messageIds: [1002] });

      expect(db.conversations).toEqual([]);
      expect(sentMessages()).toEqual([
        {
          stream: DEV_STREAM,
          topic: 'Crash',
          content: 'The Discord thread for this topic was deleted; the next message here starts a new one.',
        },
      ]);
      expect(error()).not.toHaveBeenCalled();
    });

    it('should not delete Discord copies older than 7 days', async () => {
      await fromZulip(zulipMessage({ content: paragraphs('a', 'b') }));
      await fromZulip(zulipMessage({ id: 1002 }));
      for (const row of db.messages) {
        row.createdAt = new Date(Date.now() - 8 * DAY);
      }
      const ids = db.messages.map(({ discordMessageId }) => discordMessageId);

      await deleteFromZulip({ messageIds: [1001, 1002] });

      expect(discord.deleteMirrorMessage).not.toHaveBeenCalled();
      expect(warn()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: Zulip deleted 2 mirrored messages older than 7 days; not deleting their Discord copies (Discord messages ${ids.join(', ')}); delete them there by hand if this was intended`,
      );
    });

    it('should never delete a Discord message when Zulip deletes its copy', async () => {
      await fromDiscord(discordMessage());

      await deleteFromZulip({ messageIds: [5001] });

      expect(discord.deleteMirrorMessage).not.toHaveBeenCalled();
      expect(db.messages).toEqual([expect.objectContaining({ deletedAt: expect.any(Date) })]);
    });

    it('should delete the copy of a message moved out of the stream once it is deleted there', async () => {
      await fromZulip(zulipMessage());
      await updateFromZulip({ messageId: 1001, newStreamId: 107, propagateMode: 'change_one' });

      await updateFromZulip({ messageId: 1001, content: 'edited', streamId: 107 });
      await deleteFromZulip({ messageIds: [1001], streamId: 107 });

      expect(discord.editMirrorMessage).not.toHaveBeenCalled();
      expect(discord.deleteMirrorMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ channelId: DEV_CHANNEL, messageId: db.messages[0].discordMessageId }),
      );
      expect(db.messages[0].deletedAt).toEqual(expect.any(Date));
    });

    it('should re-anchor a conversation whose anchor was deleted', async () => {
      await fromZulip(zulipMessage({ topic: 'Crash' }));
      await fromZulip(zulipMessage({ id: 1002, topic: 'Crash' }));
      await fromZulip(zulipMessage({ id: 1003, topic: 'Crash' }));

      await deleteFromZulip({ messageIds: [1001] });
      expect(db.conversations[0].zulipAnchorMessageId).toBe(1003);
      expect(discord.deleteMirrorMessage).toHaveBeenCalledOnce();

      await deleteFromZulip({ messageIds: [1003] });
      expect(db.conversations[0].zulipAnchorMessageId).toBe(1002);
    });

    it('should delete the Discord copies and let the thread go when its whole topic disappears from Zulip', async () => {
      await fromZulip(zulipMessage({ topic: 'Crash' }));
      await fromZulip(zulipMessage({ id: 1002, topic: 'Crash' }));
      const threadId = db.conversations[0].discordThreadId!;
      await fromDiscord(discordMessage({ threadId, threadName: 'Crash' }));
      const copies = db.messages
        .filter(({ origin }) => origin === 'zulip')
        .map(({ discordMessageId }) => discordMessageId);

      await deleteFromZulip({ messageIds: [1001, 1002, 5001], topic: 'Crash' });

      expect(discord.deleteMirrorMessage.mock.calls.map(([{ messageId }]) => messageId)).toEqual(copies);
      expect(db.conversations).toEqual([]);
      expect(log()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: detached the conversation of Discord thread ${threadId}: Zulip removed every mirrored message of its topic`,
      );
    });

    it('should delete the copy of the only message of a topic posted by mistake', async () => {
      await fromZulip(zulipMessage({ topic: 'Oops wrong stream' }));

      await deleteFromZulip({ messageIds: [1001], topic: 'Oops wrong stream' });

      expect(discord.deleteMirrorMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ messageId: db.messages[0].discordMessageId }),
      );
      expect(db.conversations).toEqual([]);
    });

    it('should delete the copy of the last message left in a topic', async () => {
      await fromZulip(zulipMessage({ topic: 'Crash' }));
      await fromZulip(zulipMessage({ id: 1002, topic: 'Crash' }));

      await deleteFromZulip({ messageIds: [1001] });
      await deleteFromZulip({ messageIds: [1002] });

      expect(discord.deleteMirrorMessage).toHaveBeenCalledTimes(2);
      expect(db.conversations).toEqual([]);
    });

    it('should still delete the copies when the rest of the thread stays', async () => {
      await fromZulip(zulipMessage({ topic: 'Crash' }));
      await fromZulip(zulipMessage({ id: 1002, topic: 'Crash' }));
      const threadId = db.conversations[0].discordThreadId!;
      await fromDiscord(discordMessage({ threadId, threadName: 'Crash' }));

      await deleteFromZulip({ messageIds: [1001, 1002], topic: 'Crash' });

      expect(discord.deleteMirrorMessage).toHaveBeenCalledTimes(2);
      expect(db.conversations[0].zulipAnchorMessageId).toBe(5001);
    });
  });

  describe('moves and renames', () => {
    let threadId: string;

    beforeEach(async () => {
      await start();
      await fromZulip(zulipMessage({ topic: 'Crash' }));
      threadId = db.conversations[0].discordThreadId!;
    });

    it('should store a renamed topic before renaming the Discord thread', async () => {
      await updateFromZulip({
        messageId: 1001,
        topic: 'Crash on start',
        origTopic: 'Crash',
        propagateMode: 'change_all',
      });

      expect(discord.renameMirrorThread).toHaveBeenCalledExactlyOnceWith(threadId, 'Crash on start');
      expect(db.repository.updateMirrorConversation.mock.invocationCallOrder.at(-1)).toBeLessThan(
        discord.renameMirrorThread.mock.invocationCallOrder[0],
      );
      expect(db.conversations[0]).toEqual(
        expect.objectContaining({ zulipTopic: 'Crash on start', zulipTopicKey: 'crash on start' }),
      );

      sut.onDiscordThreadRenamed({ channelId: DEV_CHANNEL, threadId, name: 'Crash on start' });
      await sut.whenIdle();
      expect(zulip.updateMessage).not.toHaveBeenCalled();
    });

    it('should archive the thread of a resolved topic after renaming it, and take it out when the topic is unresolved', async () => {
      await updateFromZulip({ messageId: 1001, topic: '✔ Crash', propagateMode: 'change_all' });

      expect(discord.renameMirrorThread).toHaveBeenCalledExactlyOnceWith(threadId, '✔ Crash');
      expect(discord.archiveMirrorThread).toHaveBeenCalledExactlyOnceWith(threadId);
      expect(discord.renameMirrorThread.mock.invocationCallOrder[0]).toBeLessThan(
        discord.archiveMirrorThread.mock.invocationCallOrder[0],
      );

      await updateFromZulip({ messageId: 1001, topic: 'Crash', propagateMode: 'change_all' });
      expect(discord.unarchiveMirrorThread).toHaveBeenCalledExactlyOnceWith(threadId);
      expect(discord.renameMirrorThread).toHaveBeenLastCalledWith(threadId, 'Crash');

      await updateFromZulip({ messageId: 1001, topic: 'Crash on start', propagateMode: 'change_all' });
      expect(discord.archiveMirrorThread).toHaveBeenCalledOnce();
      expect(discord.unarchiveMirrorThread).toHaveBeenCalledOnce();
    });

    it('should say so when the thread cannot be archived, and archive it once Discord is back', async () => {
      discord.archiveMirrorThread.mockRejectedValueOnce(new DiscordMirrorError('forbidden', 50_013));
      await updateFromZulip({ messageId: 1001, topic: '✔ Crash', propagateMode: 'change_all' });

      expect(warn()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: could not archive Discord thread ${threadId} after its Zulip topic was resolved: forbidden (50013)`,
      );

      discord.isReady.mockReturnValue(false);
      await updateFromZulip({ messageId: 1001, topic: 'Crash', propagateMode: 'change_all' });
      expect(discord.unarchiveMirrorThread).not.toHaveBeenCalled();
      discord.isReady.mockReturnValue(true);
      await sut.onDiscordReady();
      await sut.whenIdle();
      expect(discord.unarchiveMirrorThread).toHaveBeenCalledExactlyOnceWith(threadId);
    });

    it('should skip the echo of a rename the mirror made before the next one it made', async () => {
      await updateFromZulip({ messageId: 1001, topic: 'bar', propagateMode: 'change_all' });
      await updateFromZulip({ messageId: 1001, topic: 'baz', propagateMode: 'change_all' });

      sut.onDiscordThreadRenamed({ channelId: DEV_CHANNEL, threadId, name: 'bar' });
      sut.onDiscordThreadRenamed({ channelId: DEV_CHANNEL, threadId, name: 'baz' });
      await sut.whenIdle();

      expect(zulip.updateMessage).not.toHaveBeenCalled();
      expect(db.conversations[0].zulipTopic).toBe('baz');

      sut.onDiscordThreadRenamed({ channelId: DEV_CHANNEL, threadId, name: 'bar' });
      await sut.whenIdle();
      expect(zulip.updateMessage).toHaveBeenCalledOnce();
    });

    it('should skip the echo of a resolved topic at the length limit', async () => {
      const topic = `✔ ${'x'.repeat(58)}`;
      await updateFromZulip({ messageId: 1001, topic, propagateMode: 'change_all' });
      expect(discord.renameMirrorThread).toHaveBeenCalledWith(threadId, topic);

      sut.onDiscordThreadRenamed({ channelId: DEV_CHANNEL, threadId, name: toDiscordThreadName(topic) });
      await sut.whenIdle();

      expect(zulip.updateMessage).not.toHaveBeenCalled();
      expect(zulip.getMessage).not.toHaveBeenCalled();
    });

    it('should detach a topic merged into another conversation', async () => {
      seedThread({ id: 'other', discordThreadId: '200000000000000009', zulipTopic: 'Other', zulipTopicKey: 'other' });

      await updateFromZulip({ messageId: 1001, topic: 'other', propagateMode: 'change_all' });

      expect(db.conversations.map(({ id }) => id)).toEqual(['other']);
      expect(discord.renameMirrorThread).not.toHaveBeenCalled();
    });

    it('should detach a topic moved to another stream', async () => {
      await updateFromZulip({ messageId: 1001, newStreamId: 950, propagateMode: 'change_all' });

      expect(db.conversations).toEqual([]);
      expect(db.messages[0].conversationId).toBeNull();
    });

    it('should leave the conversation alone when a partial move leaves out the anchor', async () => {
      await fromZulip(zulipMessage({ id: 1002, topic: 'Crash' }));

      await updateFromZulip({ messageId: 1002, messageIds: [1002], topic: 'Elsewhere', propagateMode: 'change_one' });

      expect(db.conversations[0].zulipTopic).toBe('Crash');
      expect(discord.renameMirrorThread).not.toHaveBeenCalled();
      expect(db.messages.find(({ zulipMessageId }) => zulipMessageId === 1002)?.conversationId).toBeNull();
    });

    it('should never re-anchor a thread to a message that left its stream', async () => {
      const conversationId = db.conversations[0].id;
      seedRow({
        discordMessageId: '300000000000000077',
        origin: 'discord',
        conversationId,
        discordThreadId: threadId,
        discordWebhookId: null,
        zulipMessageId: 999,
      });
      await fromZulip(zulipMessage({ id: 1002, topic: 'Crash' }));
      await updateFromZulip({ messageId: 1002, messageIds: [1002], newStreamId: 950, propagateMode: 'change_one' });

      await deleteFromZulip({ messageIds: [1001] });

      expect(db.conversations[0].zulipAnchorMessageId).toBe(999);
      expect(db.messages.find(({ zulipMessageId }) => zulipMessageId === 1002)).toEqual(
        expect.objectContaining({ conversationId: null, zulipStreamId: 950 }),
      );
    });

    it('should read the anchor again before renaming its topic, and detach it from another stream', async () => {
      zulip.getMessage.mockResolvedValue({ id: 1001, topic: 'Crash', streamId: 950 });

      sut.onDiscordThreadRenamed({ channelId: DEV_CHANNEL, threadId, name: 'general chat' });
      await sut.whenIdle();

      expect(zulip.getMessage).toHaveBeenCalledWith(1001);
      expect(zulip.updateMessage).not.toHaveBeenCalled();
      expect(db.conversations).toEqual([]);
    });

    it('should detach a thread renamed to the main topic before the main conversation exists', async () => {
      await updateFromZulip({ messageId: 1001, topic: '#DEV', propagateMode: 'change_all' });

      expect(db.conversations).toEqual([]);
      expect(discord.renameMirrorThread).not.toHaveBeenCalled();

      await fromDiscord(discordMessage());
      expect(sentMessages()).toEqual([expect.objectContaining({ topic: '#dev' })]);
      expect(error()).not.toHaveBeenCalled();
    });

    it('should never move the main conversation', async () => {
      await fromZulip(zulipMessage({ id: 1002 }));

      await updateFromZulip({ messageId: 1002, topic: 'Elsewhere', propagateMode: 'change_all' });

      expect(db.conversations.find(({ discordThreadId }) => discordThreadId === null)?.zulipTopic).toBe('#dev');
    });

    it('should unarchive the thread to rename it', async () => {
      discord.renameMirrorThread.mockRejectedValueOnce(new DiscordMirrorError('archived', 50_083));

      await updateFromZulip({ messageId: 1001, topic: 'Crash on start' });

      expect(discord.unarchiveMirrorThread).toHaveBeenCalledWith(threadId);
      expect(discord.renameMirrorThread).toHaveBeenCalledTimes(2);
    });

    it('should warn when the thread cannot be renamed', async () => {
      discord.renameMirrorThread.mockRejectedValue(new DiscordMirrorError('forbidden', 50_013));

      await updateFromZulip({ messageId: 1001, topic: 'Crash on start' });

      expect(warn()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: could not rename Discord thread ${threadId} after its Zulip topic moved: forbidden (50013)`,
      );
    });

    it('should rename the Zulip topic to a unique name, keeping it resolved and without notifications', async () => {
      db.conversations[0].zulipTopic = '✔ Crash';
      db.conversations[0].zulipTopicKey = '✔ crash';
      await register();
      zulip.getMessage.mockResolvedValue({ id: 1001, topic: '✔ Crash', streamId: DEV_STREAM });
      zulip.getMessages.mockImplementation(async ({ topic }) => (topic === '✔ Crash on start' ? [zulipMessage()] : []));

      sut.onDiscordThreadRenamed({ channelId: DEV_CHANNEL, threadId, name: 'Crash on start' });
      await sut.whenIdle();

      expect(zulip.updateMessage).toHaveBeenCalledExactlyOnceWith(1001, {
        topic: '✔ Crash on start (2)',
        propagateMode: 'change_all',
        sendNotificationToOldThread: false,
        sendNotificationToNewThread: false,
      });
      expect(db.conversations[0].zulipTopic).toBe('✔ Crash on start (2)');
    });

    it('should rename the Zulip topic to a case variant of its own name without a suffix', async () => {
      sut.onDiscordThreadRenamed({ channelId: DEV_CHANNEL, threadId, name: 'crash' });
      await sut.whenIdle();

      expect(zulip.updateMessage).toHaveBeenCalledExactlyOnceWith(1001, expect.objectContaining({ topic: 'crash' }));
      expect(zulip.getMessages).not.toHaveBeenCalledWith(expect.objectContaining({ topic: 'crash' }));
    });

    it('should detach a thread that no longer exists when its topic is renamed', async () => {
      discord.renameMirrorThread.mockRejectedValue(new DiscordMirrorError('unknown-channel', 10_003));

      await updateFromZulip({ messageId: 1001, topic: 'Crash on start', propagateMode: 'change_all' });

      expect(db.conversations).toEqual([]);
      expect(log()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: detached the conversation of Discord thread ${threadId}: the Discord thread no longer exists`,
      );
    });

    it('should count a rename Zulip had already made as done', async () => {
      zulip.updateMessage.mockRejectedValue(new ZulipApiError(400, 'BAD_REQUEST', 'Nothing to change', 'PATCH'));

      sut.onDiscordThreadRenamed({ channelId: DEV_CHANNEL, threadId, name: 'Crash on start' });
      await sut.whenIdle();

      expect(db.conversations[0]).toEqual(
        expect.objectContaining({ zulipTopic: 'Crash on start', zulipTopicKey: 'crash on start' }),
      );
      expect(warn()).not.toHaveBeenCalledWith(expect.stringContaining('refused'));
      expect(error()).not.toHaveBeenCalled();
    });

    it('should keep the stored topic when Zulip refuses the rename', async () => {
      zulip.updateMessage.mockRejectedValue(
        new ZulipApiError(400, 'BAD_REQUEST', "The time limit for editing this message's topic has passed.", 'PATCH'),
      );

      sut.onDiscordThreadRenamed({ channelId: DEV_CHANNEL, threadId, name: 'Crash on start' });
      await sut.whenIdle();

      expect(warn()).toHaveBeenCalledWith(
        expect.stringContaining(`${DEV_CHANNEL}: Zulip refused to rename the topic of Discord thread ${threadId}`),
      );
      expect(db.conversations[0].zulipTopic).toBe('Crash');
    });

    it('should detach a deleted thread and say so in its topic', async () => {
      sut.onDiscordThreadDeleted({ channelId: DEV_CHANNEL, threadId });
      await sut.whenIdle();

      expect(db.conversations).toEqual([]);
      expect(sentMessages()).toEqual([
        {
          stream: DEV_STREAM,
          topic: 'Crash',
          content: 'The Discord thread for this topic was deleted; the next message here starts a new one.',
        },
      ]);
    });
  });

  describe('readiness', () => {
    const zulipNotReady = `${DEV_CHANNEL}: Zulip is not ready, so edits, deletions and renames wait until it is`;
    const discordNotReady = `${DEV_CHANNEL}: Discord is not ready, so edits, deletions and renames wait until it is`;
    let threadId: string;

    beforeEach(async () => {
      await start();
      await fromZulip(zulipMessage({ topic: 'Crash' }));
      await fromZulip(zulipMessage({ id: 1002, topic: 'Crash' }));
      await fromDiscord(discordMessage({ threadId: '200000000000000009', threadName: 'Ideas' }));
      threadId = db.conversations[0].discordThreadId!;
    });

    const discordIsBack = async () => {
      discord.isReady.mockReturnValue(true);
      await sut.onDiscordReady();
      await sut.whenIdle();
    };

    const zulipIsBack = async () => {
      zulip.isInitialised.mockReturnValue(true);
      await register();
    };

    it('should hold a Zulip edit back until Discord is ready', async () => {
      discord.isReady.mockReturnValue(false);
      await updateFromZulip({ messageId: 1001, content: 'edited' });

      expect(discord.editMirrorMessage).not.toHaveBeenCalled();
      expect(warn()).toHaveBeenCalledWith(discordNotReady);

      await discordIsBack();
      expect(discord.editMirrorMessage).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        content: 'edited',
        suppressEmbeds: false,
      });
    });

    it('should keep later changes behind the ones held, and try again soon', async () => {
      vitest.useFakeTimers();
      discord.isReady.mockReturnValue(false);
      await updateFromZulip({ messageId: 1001, content: 'first edit' });
      discord.isReady.mockReturnValue(true);
      await updateFromZulip({ messageId: 1001, content: 'second edit' });

      expect(discord.editMirrorMessage).not.toHaveBeenCalled();

      await vitest.advanceTimersByTimeAsync(30_000);
      await sut.whenIdle();
      expect(discord.editMirrorMessage.mock.calls.map(([, { content }]) => content)).toEqual([
        'first edit',
        'second edit',
      ]);
    });

    it('should apply an edit back to the original content after the edit held before it', async () => {
      discord.isReady.mockReturnValue(false);
      await updateFromZulip({ messageId: 1001, content: 'edited' });
      await updateFromZulip({ messageId: 1001, content: 'hello' });

      await discordIsBack();

      expect(discord.editMirrorMessage.mock.calls.map(([, { content }]) => content)).toEqual(['edited', 'hello']);
    });

    it('should drop the changes held for a pair that was turned off', async () => {
      discord.isReady.mockReturnValue(false);
      await updateFromZulip({ messageId: 1001, content: 'edited' });
      discord.getMirrorChannel.mockImplementation(async (channelId) =>
        channelId === DEV_CHANNEL ? undefined : mirrorChannel(channelId),
      );

      await discordIsBack();

      expect(discord.editMirrorMessage).not.toHaveBeenCalled();
    });

    it('should hold a Zulip deletion back until Discord is ready', async () => {
      discord.isReady.mockReturnValue(false);
      await deleteFromZulip({ messageIds: [1002] });

      expect(discord.deleteMirrorMessage).not.toHaveBeenCalled();
      expect(db.messages.find(({ zulipMessageId }) => zulipMessageId === 1002)?.deletedAt).toEqual(expect.any(Date));
      expect(warn()).toHaveBeenCalledWith(discordNotReady);

      await discordIsBack();
      expect(discord.deleteMirrorMessage).toHaveBeenCalledOnce();
    });

    it('should store a Zulip rename at once and rename the thread once Discord is ready', async () => {
      discord.isReady.mockReturnValue(false);
      await updateFromZulip({ messageId: 1001, topic: 'Crash on start', propagateMode: 'change_all' });

      expect(db.conversations[0].zulipTopic).toBe('Crash on start');
      expect(discord.renameMirrorThread).not.toHaveBeenCalled();
      expect(warn()).toHaveBeenCalledWith(discordNotReady);

      await discordIsBack();
      expect(discord.renameMirrorThread).toHaveBeenCalledExactlyOnceWith(threadId, 'Crash on start');
    });

    it('should hold a Discord edit back until Zulip is ready', async () => {
      zulip.isInitialised.mockReturnValue(false);
      sut.onDiscordMessageEdited(discordMessage({ threadId: '200000000000000009', content: 'edited' }));
      await sut.whenIdle();

      expect(zulip.updateMessage).not.toHaveBeenCalled();
      expect(warn()).toHaveBeenCalledWith(zulipNotReady);

      await zulipIsBack();
      expect(zulip.updateMessage).toHaveBeenCalledExactlyOnceWith(5001, {
        content: expect.stringContaining('edited'),
      });
    });

    it('should hold a Discord deletion back until Zulip is ready', async () => {
      zulip.isInitialised.mockReturnValue(false);
      sut.onDiscordMessagesDeleted(DEV_CHANNEL, ['300000000000000001']);
      await sut.whenIdle();

      expect(zulip.deleteMessage).not.toHaveBeenCalled();
      expect(warn()).toHaveBeenCalledWith(zulipNotReady);

      await zulipIsBack();
      expect(zulip.deleteMessage).toHaveBeenCalledExactlyOnceWith(5001);
    });

    it('should hold a Discord rename back until Zulip is ready', async () => {
      zulip.isInitialised.mockReturnValue(false);
      sut.onDiscordThreadRenamed({ channelId: DEV_CHANNEL, threadId, name: 'Crash on start' });
      await sut.whenIdle();

      expect(zulip.updateMessage).not.toHaveBeenCalled();
      expect(warn()).toHaveBeenCalledWith(zulipNotReady);

      await zulipIsBack();
      expect(zulip.updateMessage).toHaveBeenCalledExactlyOnceWith(
        1001,
        expect.objectContaining({ topic: 'Crash on start' }),
      );
    });

    it('should detach a deleted thread at once and post its notice once Zulip is ready', async () => {
      zulip.isInitialised.mockReturnValue(false);
      sut.onDiscordThreadDeleted({ channelId: DEV_CHANNEL, threadId });
      await sut.whenIdle();

      expect(db.conversations.map(({ discordThreadId }) => discordThreadId)).toEqual(['200000000000000009']);
      expect(sentMessages()).toHaveLength(1);
      expect(warn()).toHaveBeenCalledWith(zulipNotReady);

      await zulipIsBack();
      expect(sentMessages().at(-1)).toEqual(expect.objectContaining({ topic: 'Crash', content: expect.any(String) }));
      expect(sentMessages()).toHaveLength(2);
    });
  });

  describe('recheck', () => {
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
    const EDITED = '300000000000000011';
    const DELETED = '300000000000000012';
    const KEPT = '300000000000000013';
    const discordRow = (id: string, zulipMessageId: number, content: string, overrides: Partial<MirrorMessage> = {}) =>
      seedRow({
        discordMessageId: id,
        origin: 'discord',
        discordWebhookId: null,
        discordAuthorId: CONTRIBUTOR,
        zulipMessageId,
        zulipSenderId: null,
        zulipHeader: '**Contrib** (&#64;contrib123)',
        sourceHash: discordSourceHash(discordMessage({ id, content })),
        ...overrides,
      });
    const zulipRow = (
      discordMessageId: string,
      zulipMessageId: number,
      content: string,
      overrides: Partial<MirrorMessage> = {},
    ) => seedRow({ discordMessageId, zulipMessageId, sourceHash: sha256(content), ...overrides });
    const onZulip = (...messages: ZulipReceivedMessage[]) =>
      zulip.getMessagesByIds.mockImplementation(async (ids) => messages.filter(({ id }) => ids.includes(id)));

    beforeEach(() => {
      discordRow(EDITED, 70, 'before');
      discordRow(DELETED, 71, 'gone soon');
      discordRow(KEPT, 72, 'same');
      zulipRow('800000000000000001', 1001, 'zulip before');
      zulipRow('800000000000000002', 1002, 'zulip gone soon');
      zulipRow('800000000000000003', 1003, 'zulip same');
      discord.fetchMirrorMessagesBefore.mockImplementation(async (channelId) => ({
        messages:
          channelId === DEV_CHANNEL
            ? [discordMessage({ id: EDITED, content: 'after' }), discordMessage({ id: KEPT, content: 'same' })]
            : [],
        oldestId: channelId === DEV_CHANNEL ? '300000000000000001' : null,
        full: false,
      }));
      onZulip(zulipMessage({ id: 1001, content: 'zulip after' }), zulipMessage({ id: 1003, content: 'zulip same' }));
    });

    it('should mirror the edits and deletions of recent messages made on either side while the bot was away', async () => {
      await start();

      expect(zulip.updateMessage).toHaveBeenCalledExactlyOnceWith(70, {
        content: '**Contrib** (&#64;contrib123): after',
      });
      expect(zulip.deleteMessage).toHaveBeenCalledExactlyOnceWith(71);
      expect(discord.editMirrorMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ messageId: '800000000000000001' }),
        { content: 'zulip after', suppressEmbeds: false },
      );
      expect(discord.deleteMirrorMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ messageId: '800000000000000002' }),
      );
      expect(zulip.getMessagesByIds).toHaveBeenCalledExactlyOnceWith([1001, 1002, 1003]);
      expect(log()).toHaveBeenCalledWith(`${DEV_CHANNEL}: mirroring 4 changes made while the bot was away`);
    });

    it('should read again only the side whose events may have been missed', async () => {
      await start();
      discord.fetchMirrorMessagesBefore.mockClear();
      zulip.getMessagesByIds.mockClear();

      await register();
      expect(zulip.getMessagesByIds).toHaveBeenCalledOnce();
      expect(discord.fetchMirrorMessagesBefore).toHaveBeenCalledExactlyOnceWith(DEV_CHANNEL, undefined, 100);

      zulip.getMessagesByIds.mockClear();
      sut.onDiscordDisconnected();
      await sut.onDiscordReady();
      await sut.whenIdle();
      expect(zulip.getMessagesByIds).not.toHaveBeenCalled();
    });

    it('should leave alone the rows older than a day, and a side that shows none of its messages', async () => {
      db.messages.splice(0);
      discordRow(DELETED, 71, 'old', { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
      zulipRow('800000000000000002', 1002, 'zulip gone', { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
      zulipRow('800000000000000004', 1004, 'zulip gone too');
      zulip.getMessagesByIds.mockResolvedValue([]);

      await start();

      expect(zulip.deleteMessage).not.toHaveBeenCalled();
      expect(discord.deleteMirrorMessage).not.toHaveBeenCalled();
      expect(zulip.getMessagesByIds).toHaveBeenCalledExactlyOnceWith([1004]);
    });

    it('should leave a Discord row the pages do not reach alone', async () => {
      discord.fetchMirrorMessagesBefore.mockImplementation(async (channelId) => ({
        messages: channelId === DEV_CHANNEL ? [discordMessage({ id: '300000000000000099' })] : [],
        oldestId: '300000000000000050',
        full: true,
      }));

      await start();

      expect(
        discord.fetchMirrorMessagesBefore.mock.calls.filter(([channelId]) => channelId === DEV_CHANNEL),
      ).toHaveLength(6);
      expect(zulip.deleteMessage).not.toHaveBeenCalled();
    });

    it('should drop what it read when the mirror lost track meanwhile, and read it again with the next catch-up', async () => {
      const messages = [
        zulipMessage({ id: 1001, content: 'zulip after' }),
        zulipMessage({ id: 1003, content: 'zulip same' }),
      ];
      zulip.getMessagesByIds.mockImplementationOnce(async () => {
        sut.onDiscordDisconnected();
        return messages;
      });

      await start();
      expect(discord.editMirrorMessage).not.toHaveBeenCalled();

      await sut.onDiscordReady();
      await sut.whenIdle();
      expect(zulip.getMessagesByIds).toHaveBeenCalledTimes(2);
      expect(discord.editMirrorMessage).toHaveBeenCalledOnce();
    });

    it('should not recheck after an incomplete catch-up', async () => {
      discord.fetchMirrorMessagesBefore.mockRejectedValue(new DiscordMirrorError('unavailable'));

      await start();

      expect(zulip.getMessagesByIds).not.toHaveBeenCalled();
      expect(zulip.deleteMessage).not.toHaveBeenCalled();
    });
  });

  describe('catch-up', () => {
    const HOUR = 60 * 60 * 1000;
    const snowflake = (at: number, sequence = 0) =>
      String(((BigInt(at) - 1_420_070_400_000n) << 22n) + BigInt(sequence));
    const contents = () => discord.sendMirrorMessage.mock.calls.map(([{ content }]) => content);
    const posted = () => sentMessages().map(({ content }) => content.replace('**Contrib** (&#64;contrib123): ', ''));

    let mainHighWater: string;
    const seedHighWaters = (at = Date.now() - HOUR) => {
      mainHighWater = snowflake(at);
      seedRow({
        discordMessageId: mainHighWater,
        origin: 'discord',
        discordWebhookId: null,
        discordAuthorId: CONTRIBUTOR,
        zulipMessageId: 5000,
        zulipSenderId: null,
      });
      seedRow({ discordMessageId: '800000000000000001', zulipMessageId: 1000 });
    };

    const missedOnDiscord = (overrides: Partial<DiscordSourceMessage> = {}) =>
      discordMessage({ id: snowflake(Date.now() - 60_000, 2), content: 'missed on discord', ...overrides });

    const missedOnZulip = (overrides: Partial<ZulipReceivedMessage> = {}) =>
      zulipMessage({ id: 1001, content: 'missed on zulip', ...overrides });

    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => (resolve = res));
      return { promise, resolve };
    };

    /** A bare ID stands for a message that is no mirror candidate. */
    const discordHistory = new Map<string, { id: string; message?: DiscordSourceMessage }[]>();
    const onDiscord = (channelId: string, ...items: (DiscordSourceMessage | string)[]) => {
      discordHistory.set(channelId, [
        ...(discordHistory.get(channelId) ?? []),
        ...items.map((item) => (typeof item === 'string' ? { id: item } : { id: item.id, message: item })),
      ]);
    };

    const zulipHistory: ZulipReceivedMessage[] = [];

    beforeEach(() => {
      discordHistory.clear();
      zulipHistory.length = 0;
      db.repository.getRecentMirrorMessages.mockResolvedValue([]);
      discord.fetchMirrorMessagesBefore.mockImplementation(async (channelId, before, limit) => {
        const page = (discordHistory.get(channelId) ?? [])
          .filter(({ id }) => before === undefined || BigInt(id) < BigInt(before))
          .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
          .slice(-limit);
        return {
          messages: page.flatMap(({ message }) => (message ? [message] : [])),
          oldestId: page[0]?.id ?? null,
          full: page.length === limit,
        };
      });
      zulip.getStreamMessagesBefore.mockImplementation(async ({ stream, before, count, excludeSenderId }) =>
        zulipHistory
          .filter(
            (message) =>
              message.streamId === stream &&
              message.senderId !== excludeSenderId &&
              (before === undefined || message.id < before),
          )
          .sort((a, b) => a.id - b.id)
          .slice(-count),
      );
    });

    describe('threads made while the bot was away', () => {
      it('should find a new thread and forum post in the window and mirror them from their first message', async () => {
        const thread = snowflake(Date.now() - 2 * HOUR);
        const post = snowflake(Date.now() - HOUR);
        const old = snowflake(Date.now() - 7 * HOUR);
        discord.listMirrorThreads.mockImplementation(async (channelId) =>
          channelId === DEV_CHANNEL
            ? [
                { id: thread, createdTimestamp: Date.now() - 2 * HOUR },
                { id: old, createdTimestamp: Date.now() - 7 * HOUR },
              ]
            : channelId === FORUM
              ? [{ id: post, createdTimestamp: Date.now() - HOUR }]
              : [],
        );
        onDiscord(
          thread,
          missedOnDiscord({
            id: snowflake(Date.now() - 2 * HOUR, 1),
            threadId: thread,
            threadName: 'Crash',
            content: 'first',
          }),
          missedOnDiscord({
            id: snowflake(Date.now() - HOUR, 1),
            threadId: thread,
            threadName: 'Crash',
            content: 'second',
          }),
        );
        onDiscord(
          post,
          missedOnDiscord({ id: post, channelId: FORUM, threadId: post, threadName: 'Idea', content: 'the post' }),
        );

        await start();

        expect(discord.fetchMirrorMessagesBefore).not.toHaveBeenCalledWith(old, undefined, 100);
        expect(
          sentMessages().map(({ topic, content }) => [
            topic,
            content.replace(/^\*\*Contrib\*\* \(&#64;contrib123\)(?: · <time:[^>]+>)?: /, ''),
          ]),
        ).toEqual(expect.arrayContaining([['Idea', 'the post']]));
        expect(sentMessages().filter(({ topic }) => topic === 'Crash')).toEqual([
          expect.objectContaining({ content: expect.stringMatching(/: first$/) }),
          expect.objectContaining({ content: expect.stringMatching(/: second$/) }),
        ]);
        expect(db.conversations.map(({ discordThreadId }) => discordThreadId).sort()).toEqual([thread, post].sort());
      });

      it('should leave a thread that has a conversation to its high-water mark', async () => {
        const known = seedThread({ discordThreadId: snowflake(Date.now() - HOUR) });
        discord.listMirrorThreads.mockImplementation(async (channelId) =>
          channelId === DEV_CHANNEL ? [{ id: known.discordThreadId!, createdTimestamp: Date.now() - HOUR }] : [],
        );

        await start();

        expect(discord.fetchMirrorMessagesBefore).not.toHaveBeenCalled();
      });

      it('should read the newest twenty and say which it leaves out', async () => {
        const threads = Array.from({ length: 22 }, (_, index) => ({
          id: snowflake(Date.now() - HOUR - index * 60_000),
          createdTimestamp: Date.now() - HOUR - index * 60_000,
        }));
        discord.listMirrorThreads.mockImplementation(async (channelId) => (channelId === DEV_CHANNEL ? threads : []));

        await start();

        expect(discord.fetchMirrorMessagesBefore).toHaveBeenCalledTimes(20);
        expect(warn()).toHaveBeenCalledWith(
          `${DEV_CHANNEL}: catch-up found 22 new Discord threads and reads the newest 20; the messages of the others (${threads[20].id}, ${threads[21].id}) are not mirrored`,
        );
      });

      it('should catch up again when the threads cannot be listed for now', async () => {
        discord.listMirrorThreads.mockImplementation(async (channelId) => {
          if (channelId === DEV_CHANNEL) {
            throw new DiscordMirrorError('unavailable');
          }
          return [];
        });

        await start();

        expect(error()).toHaveBeenCalledWith(
          `${DEV_CHANNEL}: catch-up could not list the threads of Discord channel ${DEV_CHANNEL}: unavailable`,
        );
        expect(log()).toHaveBeenCalledWith(`${DEV_CHANNEL}: catching up again in 30 seconds`);
      });
    });

    it('should fetch nothing without a high-water mark', async () => {
      await start();

      expect(db.repository.getMirrorDiscordHighWater).toHaveBeenCalledWith(DEV_CHANNEL, null);
      expect(db.repository.getMirrorZulipHighWater).toHaveBeenCalledWith(DEV_STREAM);
      expect(discord.fetchMirrorMessagesBefore).not.toHaveBeenCalled();
      expect(zulip.getStreamMessagesBefore).not.toHaveBeenCalled();
    });

    it('should wait until both sides are ready, whichever comes first', async () => {
      await sut.init();
      await register();
      expect(db.repository.getMirrorZulipHighWater).not.toHaveBeenCalled();

      await sut.onDiscordReady();
      await sut.whenIdle();
      expect(db.repository.getMirrorZulipHighWater).toHaveBeenCalledTimes(3);

      await register();
      expect(db.repository.getMirrorZulipHighWater).toHaveBeenCalledTimes(6);
    });

    it('should not start while Discord is away', async () => {
      await sut.init();
      await sut.onDiscordReady();
      discord.isReady.mockReturnValue(false);

      await register();

      expect(db.repository.getMirrorZulipHighWater).not.toHaveBeenCalled();
    });

    it('should queue one catch-up at a time', async () => {
      await sut.init();
      await sut.onDiscordReady();
      for (const handler of stub.handlers.registration) {
        handler({ subscribedStreamIds: [DEV_STREAM, OFF_TOPIC_STREAM, FORUM_STREAM] });
        handler({ subscribedStreamIds: [DEV_STREAM, OFF_TOPIC_STREAM, FORUM_STREAM] });
      }
      await sut.whenIdle();

      expect(db.repository.getMirrorZulipHighWater).toHaveBeenCalledTimes(3);
    });

    it('should mirror what was missed on both sides, Discord first', async () => {
      seedHighWaters();
      onDiscord(
        DEV_CHANNEL,
        missedOnDiscord(),
        missedOnDiscord({ id: snowflake(Date.now() - 30_000), content: 'second' }),
      );
      zulipHistory.push(
        missedOnZulip({ id: 999, content: 'before the mark' }),
        missedOnZulip({ id: 1000, content: 'the mark' }),
        missedOnZulip(),
        missedOnZulip({ id: 1002, content: 'later' }),
      );

      await start();

      expect(discord.fetchMirrorMessagesBefore).toHaveBeenCalledExactlyOnceWith(DEV_CHANNEL, undefined, 100);
      expect(zulip.getStreamMessagesBefore).toHaveBeenCalledExactlyOnceWith({
        stream: DEV_STREAM,
        before: undefined,
        count: 100,
        excludeSenderId: BOT.userId,
      });
      expect(posted()).toEqual(['missed on discord', 'second']);
      expect(contents()).toEqual(['missed on zulip', 'later']);
      expect(zulip.sendMessage.mock.invocationCallOrder.at(-1)).toBeLessThan(
        discord.sendMirrorMessage.mock.invocationCallOrder[0],
      );
      expect(log()).toHaveBeenCalledWith(`${DEV_CHANNEL}: catching up 2 Discord messages and 2 Zulip messages`);
    });

    it('should run what it found before anything queued after it', async () => {
      seedHighWaters();
      const page = deferred<DiscordMirrorPage>();
      discord.fetchMirrorMessagesBefore.mockReturnValue(page.promise);
      zulipHistory.push(missedOnZulip());
      await sut.init();
      await sut.onDiscordReady();
      for (const handler of stub.handlers.registration) {
        handler({ subscribedStreamIds: [DEV_STREAM, OFF_TOPIC_STREAM, FORUM_STREAM] });
      }
      await Promise.resolve();

      for (const handler of stub.handlers.message) {
        await handler(zulipMessage({ id: 1003, content: 'live' }));
      }
      page.resolve({ messages: [missedOnDiscord()], oldestId: null, full: false });
      await sut.whenIdle();

      expect(contents()).toEqual(['missed on zulip', 'live']);
      expect(zulip.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
        discord.sendMirrorMessage.mock.invocationCallOrder[0],
      );
    });

    it('should not mirror a message twice when catch-up finds one the live event already brought', async () => {
      seedHighWaters();
      await start();
      await fromZulip(missedOnZulip());
      zulipHistory.push(missedOnZulip());

      await register();

      expect(zulip.getStreamMessagesBefore).toHaveBeenCalled();
      expect(discord.sendMirrorMessage).toHaveBeenCalledOnce();
    });

    it('should not mirror a Zulip message again after a Discord moderator deleted its copy', async () => {
      seedHighWaters();
      await start();
      await fromZulip(missedOnZulip());
      sut.onDiscordMessagesDeleted(DEV_CHANNEL, [db.messages.at(-1)!.discordMessageId]);
      await sut.whenIdle();
      zulipHistory.push(missedOnZulip());

      await register();

      expect(discord.sendMirrorMessage).toHaveBeenCalledOnce();
    });

    it('should not mirror a Discord message again after Zulip deleted its copy', async () => {
      seedHighWaters();
      await start();
      const missed = missedOnDiscord();
      await fromDiscord(missed);
      await deleteFromZulip({ messageIds: [db.messages.at(-1)!.zulipMessageId] });
      onDiscord(DEV_CHANNEL, missed);

      await sut.onDiscordReady();
      await sut.whenIdle();

      expect(discord.fetchMirrorMessagesBefore).toHaveBeenCalled();
      expect(zulip.sendMessage).toHaveBeenCalledOnce();
    });

    it('should hold live messages back until catch-up has read what was missed', async () => {
      seedHighWaters();
      await sut.init();
      await register();
      const channel = deferred<DiscordMirrorChannel>();
      discord.getMirrorChannel.mockImplementation(async (channelId) =>
        channelId === DEV_CHANNEL ? channel.promise : mirrorChannel(channelId),
      );
      const missed = missedOnDiscord({ content: 'missed while down' });
      const live = missedOnDiscord({ id: snowflake(Date.now() - 1000), content: 'posted during startup' });
      onDiscord(DEV_CHANNEL, missed, live);

      const ready = sut.onDiscordReady();
      await fromDiscord(live);
      expect(zulip.sendMessage).not.toHaveBeenCalled();
      expect(warn()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: not mirroring yet: catch-up has to run first, and picks it up`,
      );

      channel.resolve(mirrorChannel(DEV_CHANNEL));
      await ready;
      await sut.whenIdle();

      expect(posted()).toEqual(['missed while down', 'posted during startup']);
    });

    it('should catch up again after a message could not reach Zulip', async () => {
      seedHighWaters();
      await start();
      vitest.useFakeTimers();
      zulip.sendMessage.mockRejectedValueOnce(new TypeError('fetch failed', { cause: refused() }));
      const first = missedOnDiscord({ content: 'first' });
      const second = missedOnDiscord({ id: snowflake(Date.now() - 1000), content: 'second' });
      onDiscord(DEV_CHANNEL, first, second);

      await fromDiscord(first);
      await fromDiscord(second);

      expect(zulip.sendMessage).toHaveBeenCalledOnce();
      expect(log()).toHaveBeenCalledWith(`${DEV_CHANNEL}: catching up again in 30 seconds`);

      await vitest.advanceTimersByTimeAsync(30_000);
      await sut.whenIdle();

      expect(posted()).toEqual(['first', 'first', 'second']);
    });

    it('should catch up again, later each time, while Discord cannot be reached', async () => {
      seedHighWaters();
      await start();
      vitest.useFakeTimers();
      discord.sendMirrorMessage
        .mockRejectedValueOnce(new DiscordMirrorError('unreachable', undefined, 'connect ECONNREFUSED'))
        .mockRejectedValueOnce(new DiscordMirrorError('unreachable', undefined, 'connect ECONNREFUSED'));
      zulipHistory.push(missedOnZulip({ content: 'first' }), missedOnZulip({ id: 1002, content: 'second' }));

      await fromZulip(zulipHistory[0]);
      await fromZulip(zulipHistory[1]);
      await vitest.advanceTimersByTimeAsync(30_000);
      await sut.whenIdle();

      expect(contents()).toEqual(['first', 'first']);
      expect(log()).toHaveBeenCalledWith(`${DEV_CHANNEL}: catching up again in 60 seconds`);

      await vitest.advanceTimersByTimeAsync(60_000);
      await sut.whenIdle();

      expect(contents()).toEqual(['first', 'first', 'first', 'second']);
    });

    it('should keep trying to catch up while the Discord gateway is reconnecting', async () => {
      seedHighWaters();
      await start();
      vitest.useFakeTimers();
      zulip.sendMessage.mockRejectedValueOnce(new TypeError('fetch failed', { cause: refused() }));
      const first = missedOnDiscord({ content: 'first' });
      onDiscord(DEV_CHANNEL, first);
      await fromDiscord(first);
      discord.isReady.mockReturnValue(false);

      await vitest.advanceTimersByTimeAsync(30_000);
      await sut.whenIdle();
      expect(posted()).toEqual(['first']);

      discord.isReady.mockReturnValue(true);
      await vitest.advanceTimersByTimeAsync(60_000);
      await sut.whenIdle();
      expect(posted()).toEqual(['first', 'first']);
    });

    it('should create nothing live once the gateway drops, until catch-up has read what the new session missed', async () => {
      seedHighWaters();
      await start();
      const missed = missedOnDiscord({ content: 'missed while disconnected' });
      const early = missedOnDiscord({ id: snowflake(Date.now() - 1000), content: 'before shardReady' });
      onDiscord(DEV_CHANNEL, missed, early);

      zulipHistory.push(missedOnZulip({ content: 'team' }));

      sut.onDiscordDisconnected();
      await fromDiscord(early);
      await fromZulip(zulipHistory[0]);
      expect(zulip.sendMessage).not.toHaveBeenCalled();
      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();

      await sut.onDiscordReady();
      await sut.whenIdle();

      expect(posted()).toEqual(['missed while disconnected', 'before shardReady']);
      expect(contents()).toEqual(['team']);
    });

    it('should not let a catch-up that ran while the gateway was down open the way for live creates', async () => {
      seedHighWaters();
      await start();
      sut.onDiscordDisconnected();
      await register();

      await fromZulip(missedOnZulip({ content: 'team' }));
      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();

      zulipHistory.push(missedOnZulip({ content: 'team' }));
      sut.onDiscordResumed();
      await sut.whenIdle();
      expect(contents()).toEqual(['team']);
    });

    it('should give up on a message that keeps failing, so that the rest can follow', async () => {
      seedHighWaters();
      await start();
      vitest.useFakeTimers();
      const lookUp = db.repository.getMirrorMessagesByDiscordIds.getMockImplementation()!;
      db.repository.getMirrorMessagesByDiscordIds.mockImplementation(async (ids, options) => {
        if (ids.includes('999')) {
          throw new Error('invalid input syntax');
        }
        return lookUp(ids, options);
      });
      const poison = missedOnDiscord({
        content: 'poison',
        replyTo: { messageId: '999', authorDisplayName: 'Alex', content: null },
      });
      const next = missedOnDiscord({ id: snowflake(Date.now() - 1000), content: 'next' });
      onDiscord(DEV_CHANNEL, poison, next);

      await fromDiscord(poison);
      await fromDiscord(next);
      await vitest.advanceTimersByTimeAsync(30_000);
      await vitest.advanceTimersByTimeAsync(60_000);
      await sut.whenIdle();

      expect(posted()).toEqual(['next']);
      expect(error()).toHaveBeenCalledWith(`${DEV_CHANNEL}: gave up on Discord message ${poison.id} after 3 attempts`);

      await vitest.advanceTimersByTimeAsync(10 * 60_000);
      await sut.whenIdle();
      expect(posted()).toEqual(['next']);
    });

    it.each([
      ['cannot be reached', () => new TypeError('fetch failed', { cause: refused() })],
      [
        'refuses every request for now',
        () => new ZulipApiError(429, 'RATE_LIMIT_HIT', 'API usage exceeded rate limit', 'POST /messages'),
      ],
    ])('should never give up on a message while Zulip %s', async (_, failure) => {
      seedHighWaters();
      await start();
      vitest.useFakeTimers();
      const first = missedOnDiscord({ content: 'first' });
      onDiscord(DEV_CHANNEL, first);
      for (let attempt = 0; attempt < 4; attempt++) {
        zulip.sendMessage.mockRejectedValueOnce(failure());
      }

      await fromDiscord(first);
      await vitest.advanceTimersByTimeAsync((30 + 60 + 120 + 240) * 1000);
      await sut.whenIdle();

      expect(zulip.sendMessage).toHaveBeenCalledTimes(5);
      expect(db.messages.map(({ discordMessageId }) => discordMessageId)).toContain(first.id);
      expect(error()).not.toHaveBeenCalledWith(expect.stringContaining('gave up'));
    });

    it('should not count failures against a message once catch-up finds that Zulip is down', async () => {
      seedHighWaters();
      await start();
      vitest.useFakeTimers();
      const unavailable = () => new ZulipApiError(503, 'UNKNOWN_ERROR', 'Service Unavailable', 'GET /messages');
      let down = true;
      zulip.getMessages.mockImplementation(async () => {
        if (down) {
          throw unavailable();
        }
        return [];
      });
      zulip.getStreamMessagesBefore.mockImplementation(async () => {
        if (down) {
          throw unavailable();
        }
        return [];
      });
      const threadId = snowflake(Date.now() - 1000);
      const starter = missedOnDiscord({ id: threadId, threadId, threadName: 'Idea', content: 'starter' });
      onDiscord(threadId, starter);

      sut.onDiscordMessage(starter);
      await vitest.advanceTimersByTimeAsync((30 + 60 + 120) * 1000);
      down = false;
      await vitest.advanceTimersByTimeAsync(240 * 1000);
      await sut.whenIdle();

      expect(posted()).toEqual([expect.stringMatching(/: starter$/)]);
      expect(error()).not.toHaveBeenCalledWith(expect.stringContaining('gave up'));
    });

    it('should try a create again when the database failed before anything was sent', async () => {
      seedHighWaters();
      await start();
      vitest.useFakeTimers();
      const first = missedOnDiscord({ content: 'first' });
      onDiscord(DEV_CHANNEL, first);
      db.repository.getMirrorMessagesByDiscordIds.mockRejectedValueOnce(
        new Error('Connection terminated unexpectedly'),
      );

      await fromDiscord(first);
      expect(zulip.sendMessage).not.toHaveBeenCalled();

      await vitest.advanceTimersByTimeAsync(30_000);
      await sut.whenIdle();
      expect(posted()).toEqual(['first']);
    });

    it('should catch up again when creates were turned away while a catch-up the queue gave up on still read', async () => {
      seedHighWaters();
      await start();
      vitest.useFakeTimers();
      const page = deferred<ZulipReceivedMessage[]>();
      zulip.getStreamMessagesBefore.mockReturnValueOnce(page.promise);
      for (const handler of stub.handlers.registration) {
        handler({ subscribedStreamIds: [DEV_STREAM, OFF_TOPIC_STREAM, FORUM_STREAM] });
      }
      await vitest.advanceTimersByTimeAsync(180_000);

      const live = missedOnDiscord({ content: 'live' });
      onDiscord(DEV_CHANNEL, live);
      await fromDiscord(live);
      expect(zulip.sendMessage).not.toHaveBeenCalled();

      page.resolve([]);
      await vitest.advanceTimersByTimeAsync(30_000);
      await sut.whenIdle();
      expect(posted()).toEqual([expect.stringMatching(/live$/)]);
    });

    it('should never send a message again after Zulip may have taken it', async () => {
      seedHighWaters();
      await start();
      const first = missedOnDiscord({ content: 'first' });
      onDiscord(DEV_CHANNEL, first);
      zulip.sendMessage.mockRejectedValueOnce(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      );

      await fromDiscord(first);
      await register();

      expect(posted()).toEqual(['first']);
      expect(log()).not.toHaveBeenCalledWith(expect.stringContaining('catching up again'));
    });

    it('should never send a message again after Discord may have taken it', async () => {
      seedHighWaters();
      await start();
      zulipHistory.push(missedOnZulip({ content: 'first' }));
      discord.sendMirrorMessage.mockRejectedValueOnce(new DiscordMirrorError('unavailable', undefined, 'HTTP 503'));

      await fromZulip(zulipHistory[0]);
      await register();

      expect(contents()).toEqual(['first']);
    });

    it('should catch up the start of a new thread it turned away while catch-up was due', async () => {
      seedHighWaters();
      await start();
      vitest.useFakeTimers();
      discord.sendMirrorMessage.mockRejectedValueOnce(
        new DiscordMirrorError('unreachable', undefined, 'connect ECONNREFUSED'),
      );
      zulipHistory.push(missedOnZulip({ content: 'team' }));
      await fromZulip(zulipHistory[0]);
      const threadId = snowflake(Date.now() - 1000);
      const inThread = { threadId, threadName: 'New idea' };
      const starter = missedOnDiscord({ id: threadId, ...inThread, content: 'starter' });
      onDiscord(threadId, starter);

      await fromDiscord(starter);
      expect(zulip.sendMessage).not.toHaveBeenCalled();

      await vitest.advanceTimersByTimeAsync(30_000);
      await sut.whenIdle();
      await fromDiscord(missedOnDiscord({ id: snowflake(Date.now()), ...inThread, content: 'reply' }));

      expect(posted()).toEqual(['starter', 'reply']);
      expect(sentMessages().map(({ topic }) => topic)).toEqual(['New idea', 'New idea']);
      expect(contents()).toEqual(['team', 'team']);
    });

    it('should catch up a thread it turned away even when it is long idle', async () => {
      const idle = seedThread({ id: 'idle' });
      seedRow({
        conversationId: idle.id,
        discordThreadId: idle.discordThreadId,
        createdAt: new Date(Date.now() - 30 * DAY),
      });
      seedHighWaters();
      await sut.init();
      await register();
      const message = missedOnDiscord({ threadId: idle.discordThreadId, threadName: 'Crash on upload' });
      onDiscord(idle.discordThreadId!, message);

      await fromDiscord(message);
      await sut.onDiscordReady();
      await sut.whenIdle();

      expect(sentMessages()).toEqual([expect.objectContaining({ topic: 'Crash on upload' })]);
      expect(db.messages.find(({ discordMessageId }) => discordMessageId === message.id)?.conversationId).toBe('idle');
    });

    it('should quietly pass over a thread it turned away that no longer exists', async () => {
      seedHighWaters();
      await sut.init();
      await register();
      const threadId = snowflake(Date.now() - 1000);
      discord.fetchMirrorMessagesBefore.mockImplementation(async (channelId) => {
        if (channelId === threadId) {
          throw new DiscordMirrorError('unknown-channel', 10_003);
        }
        return { messages: [], oldestId: null, full: false };
      });

      await fromDiscord(missedOnDiscord({ id: threadId, threadId, threadName: 'Gone' }));
      await sut.onDiscordReady();
      await sut.whenIdle();

      expect(discord.fetchMirrorMessagesBefore).toHaveBeenCalledWith(threadId, undefined, 100);
      expect(error()).not.toHaveBeenCalled();
    });

    it('should catch up a Zulip message it turned away in a stream it has not mirrored from yet', async () => {
      await start();
      vitest.useFakeTimers();
      zulip.sendMessage.mockRejectedValueOnce(new TypeError('fetch failed', { cause: refused() }));
      const postId = snowflake(Date.now() - 1000);
      const post = discordMessage({
        id: postId,
        channelId: FORUM,
        threadId: postId,
        threadName: 'Plugins',
        content: 'post',
      });
      onDiscord(postId, post);
      await fromDiscord(post);
      const team = zulipMessage({ id: 2001, streamId: FORUM_STREAM, topic: 'Roadmap', content: 'team' });
      zulipHistory.push(team);

      await fromZulip(team);
      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();

      await vitest.advanceTimersByTimeAsync(30_000);
      await sut.whenIdle();

      expect(posted()).toEqual(['post', 'post']);
      expect(sent(0)).toEqual(expect.objectContaining({ channelId: FORUM, threadName: 'Roadmap', content: 'team' }));
    });

    it('should read a Zulip message it turned away again when that read fails on the way', async () => {
      await start();
      vitest.useFakeTimers();
      zulip.sendMessage.mockRejectedValueOnce(new TypeError('fetch failed', { cause: refused() }));
      const postId = snowflake(Date.now() - 1000);
      const post = discordMessage({
        id: postId,
        channelId: FORUM,
        threadId: postId,
        threadName: 'Plugins',
        content: 'post',
      });
      onDiscord(postId, post);
      await fromDiscord(post);
      const team = zulipMessage({ id: 2001, streamId: FORUM_STREAM, topic: 'Roadmap', content: 'team' });
      zulipHistory.push(team);
      await fromZulip(team);
      const unavailable = new ZulipApiError(503, 'UNKNOWN_ERROR', 'Service Unavailable', 'GET /messages');
      zulip.getStreamMessagesBefore
        .mockRejectedValueOnce(unavailable)
        .mockRejectedValueOnce(unavailable)
        .mockRejectedValueOnce(unavailable);

      await vitest.advanceTimersByTimeAsync(36_000);
      await sut.whenIdle();
      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();

      await vitest.advanceTimersByTimeAsync(60_000);
      await sut.whenIdle();
      expect(sent(0)).toEqual(expect.objectContaining({ channelId: FORUM, threadName: 'Roadmap', content: 'team' }));
    });

    it('should catch up a Zulip message it turned away even after its topic was resolved', async () => {
      seedHighWaters();
      await start();
      vitest.useFakeTimers();
      discord.sendMirrorMessage.mockRejectedValueOnce(
        new DiscordMirrorError('unreachable', undefined, 'connect ECONNREFUSED'),
      );
      const first = missedOnZulip({ content: 'first' });
      const second = missedOnZulip({ id: 1002, topic: 'Crash', content: 'second' });
      zulipHistory.push(first, { ...second, topic: '✔ Crash', movedAt: Math.floor(Date.now() / 1000) });

      await fromZulip(first);
      await fromZulip(second);
      await vitest.advanceTimersByTimeAsync(30_000);
      await sut.whenIdle();

      expect(contents()).toEqual(['first', 'first', 'second']);
      expect(discord.startMirrorThread).toHaveBeenCalledWith(DEV_CHANNEL, expect.any(String), '✔ Crash');
    });

    it('should read a thread again when the catch-up that found it went out of date', async () => {
      seedHighWaters();
      await sut.init();
      await register();
      const threadId = snowflake(Date.now() - 1000);
      const inMain = missedOnDiscord({ content: 'in the channel' });
      const starter = missedOnDiscord({ id: threadId, threadId, threadName: 'Idea', content: 'starter' });
      onDiscord(DEV_CHANNEL, inMain);
      onDiscord(threadId, starter);
      await fromDiscord(starter);
      const send = deferred<{ id: number }>();
      zulip.sendMessage.mockReturnValueOnce(send.promise);

      const ready = sut.onDiscordReady();
      await vitest.waitFor(() => expect(zulip.sendMessage).toHaveBeenCalled());
      for (const handler of stub.handlers.registration) {
        handler({ subscribedStreamIds: [DEV_STREAM, OFF_TOPIC_STREAM, FORUM_STREAM] });
      }
      send.resolve({ id: 5001 });
      await ready;
      await sut.whenIdle();

      expect(posted()).toEqual(['in the channel', 'starter']);
    });

    it('should drop what a catch-up read once the mirror lost track again, and leave it to the next one', async () => {
      seedHighWaters();
      const page = deferred<DiscordMirrorPage>();
      discord.fetchMirrorMessagesBefore.mockReturnValueOnce(page.promise);
      await sut.init();
      await sut.onDiscordReady();
      for (const handler of stub.handlers.registration) {
        handler({ subscribedStreamIds: [DEV_STREAM, OFF_TOPIC_STREAM, FORUM_STREAM] });
      }
      await vitest.waitFor(() => expect(discord.fetchMirrorMessagesBefore).toHaveBeenCalled());
      const missed = missedOnDiscord({ content: 'missed in the second gap' });
      const live = missedOnDiscord({ id: snowflake(Date.now() - 1000), content: 'live' });
      onDiscord(DEV_CHANNEL, missed, live);

      sut.onDiscordMessage(live);
      const ready = sut.onDiscordReady();
      page.resolve({ messages: [], oldestId: null, full: false });
      await ready;
      await sut.whenIdle();

      expect(posted()).toEqual(['missed in the second gap', 'live']);
    });

    it('should read a thread it turned away again when the catch-up that read it went out of date', async () => {
      seedHighWaters();
      await sut.init();
      await register();
      const threadId = snowflake(Date.now() - 1000);
      const starter = missedOnDiscord({ id: threadId, threadId, threadName: 'Idea', content: 'starter' });
      onDiscord(threadId, starter);
      await fromDiscord(starter);
      const page = deferred<DiscordMirrorPage>();
      discord.fetchMirrorMessagesBefore.mockReturnValueOnce(page.promise);

      const first = sut.onDiscordReady();
      await vitest.waitFor(() => expect(discord.fetchMirrorMessagesBefore).toHaveBeenCalled());
      const second = sut.onDiscordReady();
      page.resolve({ messages: [], oldestId: null, full: false });
      await Promise.all([first, second]);
      await sut.whenIdle();

      expect(posted()).toEqual(['starter']);
    });

    it('should read a thread it turned away again when that read fails on the way', async () => {
      seedHighWaters();
      await sut.init();
      await register();
      const threadId = snowflake(Date.now() - 1000);
      const starter = missedOnDiscord({ id: threadId, threadId, threadName: 'Idea', content: 'starter' });
      onDiscord(threadId, starter);
      await fromDiscord(starter);
      const read = discord.fetchMirrorMessagesBefore.getMockImplementation()!;
      discord.fetchMirrorMessagesBefore
        .mockImplementationOnce(read)
        .mockRejectedValueOnce(new DiscordMirrorError('unavailable', undefined, 'HTTP 503'));
      vitest.useFakeTimers();

      await sut.onDiscordReady();
      await sut.whenIdle();
      expect(zulip.sendMessage).not.toHaveBeenCalled();

      await vitest.advanceTimersByTimeAsync(30_000);
      await sut.whenIdle();
      expect(posted()).toEqual(['starter']);
    });

    it('should never send a message again once it reached Zulip, even when storing its copy failed', async () => {
      seedHighWaters();
      await start();
      const first = missedOnDiscord({ content: 'first' });
      onDiscord(DEV_CHANNEL, first);
      db.repository.createMirrorMessages.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

      await fromDiscord(first);
      await register();

      expect(posted()).toEqual(['first']);
    });

    it('should hold live messages back while it cannot read Discord, and read again soon', async () => {
      seedHighWaters();
      onDiscord(DEV_CHANNEL, missedOnDiscord({ content: 'missed' }));
      discord.fetchMirrorMessagesBefore.mockRejectedValueOnce(
        new DiscordMirrorError('unavailable', undefined, 'HTTP 503'),
      );
      vitest.useFakeTimers();
      await start();
      const live = missedOnDiscord({ id: snowflake(Date.now() - 1000), content: 'live' });
      onDiscord(DEV_CHANNEL, live);

      await fromDiscord(live);
      expect(zulip.sendMessage).not.toHaveBeenCalled();

      await vitest.advanceTimersByTimeAsync(30_000);
      await sut.whenIdle();
      expect(posted()).toEqual(['missed', 'live']);
    });

    it('should hold live messages back while it cannot read Zulip, and read again soon', async () => {
      seedHighWaters();
      zulipHistory.push(missedOnZulip({ content: 'missed' }));
      const unavailable = new ZulipApiError(503, 'UNKNOWN_ERROR', 'Service Unavailable', 'GET /messages');
      zulip.getStreamMessagesBefore
        .mockRejectedValueOnce(unavailable)
        .mockRejectedValueOnce(unavailable)
        .mockRejectedValueOnce(unavailable);
      vitest.useFakeTimers();
      await sut.init();
      await sut.onDiscordReady();
      for (const handler of stub.handlers.registration) {
        handler({ subscribedStreamIds: [DEV_STREAM, OFF_TOPIC_STREAM, FORUM_STREAM] });
      }
      await vitest.advanceTimersByTimeAsync(6000);
      const live = missedOnZulip({ id: 1002, content: 'live' });
      zulipHistory.push(live);

      await fromZulip(live);
      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();

      await vitest.advanceTimersByTimeAsync(30_000);
      await sut.whenIdle();
      expect(contents()).toEqual(['missed', 'live']);
    });

    it('should catch up again when catch-up itself fails, and bring what it turned away meanwhile', async () => {
      seedHighWaters();
      db.repository.getMirrorDiscordHighWater.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
      vitest.useFakeTimers();
      await sut.init();
      await register();
      const threadId = snowflake(Date.now() - 1000);
      const starter = missedOnDiscord({ id: threadId, threadId, threadName: 'Idea', content: 'starter' });
      onDiscord(threadId, starter);
      await fromDiscord(starter);

      await sut.onDiscordReady();
      await sut.whenIdle();
      const live = missedOnZulip({ content: 'live on zulip' });
      zulipHistory.push(live);
      await fromZulip(live);

      expect(error()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: catch-up failed: Connection terminated unexpectedly`,
        expect.any(Error),
      );
      expect(zulip.sendMessage).not.toHaveBeenCalled();
      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();

      await vitest.advanceTimersByTimeAsync(30_000);
      await sut.whenIdle();

      expect(posted()).toEqual(['starter']);
      expect(contents()).toEqual(['live on zulip']);
    });

    it('should skip messages older than 6 hours and say how many', async () => {
      seedHighWaters(Date.now() - 8 * HOUR);
      const old = Date.now() - 7 * HOUR;
      onDiscord(DEV_CHANNEL, missedOnDiscord({ id: snowflake(old), createdTimestamp: old }));
      zulipHistory.push(missedOnZulip({ timestamp: Math.floor(old / 1000) }));

      await start();

      expect(zulip.sendMessage).not.toHaveBeenCalled();
      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();
      expect(log()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: catch-up skipped 2 messages older than 6 hours or than the link`,
      );
    });

    it('should reach the newest missed Zulip messages when older ones would fill the pages', async () => {
      seedHighWaters();
      const old = Math.floor((Date.now() - 7 * HOUR) / 1000);
      zulipHistory.push(
        ...Array.from({ length: 150 }, (_, index) => missedOnZulip({ id: 1001 + index, timestamp: old })),
        ...Array.from({ length: 30 }, (_, index) => missedOnZulip({ id: 1151 + index, content: `new ${index}` })),
      );

      await start();

      expect(contents()).toEqual(Array.from({ length: 30 }, (_, index) => `new ${index}`));
      expect(zulip.getStreamMessagesBefore).toHaveBeenCalledOnce();
    });

    it('should reach the newest missed Discord messages when older ones would fill the pages', async () => {
      seedHighWaters(Date.now() - 8 * HOUR);
      const old = Date.now() - 7 * HOUR;
      onDiscord(
        DEV_CHANNEL,
        ...Array.from({ length: 120 }, (_, index) =>
          missedOnDiscord({ id: snowflake(old, index), createdTimestamp: old }),
        ),
        ...Array.from({ length: 10 }, (_, index) =>
          missedOnDiscord({ id: snowflake(Date.now() - 60_000, index), content: `new ${index}` }),
        ),
      );

      await start();

      expect(posted()).toEqual(Array.from({ length: 10 }, (_, index) => `new ${index}`));
      expect(discord.fetchMirrorMessagesBefore).toHaveBeenCalledOnce();
    });

    it("should not let the bot's own posts use up the Zulip pages", async () => {
      seedHighWaters();
      zulipHistory.push(
        missedOnZulip({ content: 'team message' }),
        ...Array.from({ length: 600 }, (_, index) => missedOnZulip({ id: 1002 + index, senderId: BOT.userId })),
      );

      await start();

      expect(contents()).toEqual(['team message']);
      expect(zulip.getStreamMessagesBefore).toHaveBeenCalledOnce();
    });

    it('should read past a Discord page without any message to mirror', async () => {
      seedHighWaters();
      const copies = Array.from({ length: 150 }, (_, index) => snowflake(Date.now() - 60_000, index));
      onDiscord(DEV_CHANNEL, missedOnDiscord({ id: snowflake(Date.now() - 5 * 60_000) }), ...copies);

      await start();

      expect(posted()).toEqual(['missed on discord']);
      expect(discord.fetchMirrorMessagesBefore.mock.calls).toEqual([
        [DEV_CHANNEL, undefined, 100],
        [DEV_CHANNEL, copies[50], 100],
      ]);
    });

    it('should stop after five pages and say so', async () => {
      seedHighWaters();
      onDiscord(DEV_CHANNEL, ...Array.from({ length: 600 }, (_, index) => snowflake(Date.now() - 60_000, index)));
      zulipHistory.push(...Array.from({ length: 600 }, (_, index) => missedOnZulip({ id: 1001 + index, movedAt: 1 })));

      await start();

      expect(discord.fetchMirrorMessagesBefore).toHaveBeenCalledTimes(5);
      expect(zulip.getStreamMessagesBefore).toHaveBeenCalledTimes(5);
      expect(warn()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: catch-up stopped after reading 500 messages of Discord channel ${DEV_CHANNEL}; older missed messages are not mirrored`,
      );
      expect(warn()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: catch-up stopped after reading 500 messages of Zulip stream ${DEV_STREAM}; older missed messages are not mirrored`,
      );
    });

    it('should leave out moved messages, the bot, other bots and commands', async () => {
      seedHighWaters();
      zulip.getStreamMessagesBefore.mockImplementation(async ({ stream }) =>
        stream === DEV_STREAM
          ? [
              missedOnZulip({ id: 1001, movedAt: Math.floor(Date.now() / 1000) }),
              missedOnZulip({ id: 1002, senderId: BOT.userId }),
              missedOnZulip({ id: 1003, senderEmail: 'ci-bot@zulip.example.com' }),
              missedOnZulip({ id: 1007, senderEmail: 'emailgateway@zulip.com' }),
              missedOnZulip({ id: 1004, content: `@**${BOT.fullName}** help` }),
              missedOnZulip({ id: 1005, streamId: FORUM_STREAM }),
              missedOnZulip({ id: 1006, content: 'kept' }),
            ]
          : [],
      );

      await start();

      expect(discord.sendMirrorMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: 'kept' }));
    });

    it('should mark a message it catches up late', async () => {
      seedHighWaters();
      const timestamp = Math.floor(Date.now() / 1000) - 600;
      zulipHistory.push(missedOnZulip({ timestamp }));

      await start();

      expect(sent(0).content).toBe(`missed on zulip\n-# sent <t:${timestamp}:f>`);
    });

    it('should read the active threads back to their own high-water marks, or to their start', async () => {
      const withDiscordRow = seedThread({ id: 'with', discordThreadId: '200000000000000001', zulipTopicKey: 'a' });
      const zulipOnly = seedThread({ id: 'without', discordThreadId: '200000000000000002', zulipTopicKey: 'b' });
      seedThread({ id: 'idle', discordThreadId: '200000000000000003', zulipTopicKey: 'c' });
      seedRow({
        discordMessageId: '300000000000000009',
        conversationId: withDiscordRow.id,
        origin: 'discord',
        discordThreadId: withDiscordRow.discordThreadId,
        discordWebhookId: null,
        zulipMessageId: 71,
      });
      seedRow({
        discordMessageId: '800000000000000002',
        conversationId: zulipOnly.id,
        discordThreadId: zulipOnly.discordThreadId,
        zulipMessageId: 72,
      });
      const inThread = (threadId: string, id: string, content: string) =>
        missedOnDiscord({ id, threadId, threadName: 'Crash on upload', content });
      onDiscord(
        '200000000000000001',
        inThread('200000000000000001', '300000000000000009', 'already mirrored'),
        inThread('200000000000000001', '300000000000000010', 'missed in the thread'),
      );
      onDiscord(
        '200000000000000002',
        inThread('200000000000000002', '200000000000000002', 'the starter'),
        inThread('200000000000000002', '200000000000000005', 'missed in the other thread'),
      );

      await start();

      expect(db.repository.getActiveMirrorThreads).toHaveBeenCalledWith(DEV_CHANNEL, expect.any(Date), 20);
      expect(discord.fetchMirrorMessagesBefore.mock.calls).toEqual([
        ['200000000000000001', undefined, 100],
        ['200000000000000002', undefined, 100],
      ]);
      expect(posted()).toEqual(['missed in the thread', 'missed in the other thread']);
    });

    it('should log a side it cannot read and still catch up the other', async () => {
      seedHighWaters();
      discord.fetchMirrorMessagesBefore.mockRejectedValue(new DiscordMirrorError('forbidden', 50_001));
      zulipHistory.push(missedOnZulip());

      await start();

      expect(error()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: catch-up could not read Discord channel ${DEV_CHANNEL}: forbidden (50001)`,
      );
      expect(discord.sendMirrorMessage).toHaveBeenCalledOnce();
    });

    it('should detach an active thread that no longer exists on Discord', async () => {
      seedThread({ id: 'deleted' });
      seedRow({ conversationId: 'deleted', discordThreadId: '200000000000000001' });
      discord.fetchMirrorMessagesBefore.mockRejectedValue(new DiscordMirrorError('unknown-channel', 10_003));

      await start();

      expect(db.conversations).toEqual([]);
      expect(log()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: detached the conversation of Discord thread 200000000000000001: the Discord thread no longer exists`,
      );
      expect(error()).not.toHaveBeenCalled();
    });

    it('should log a Zulip stream it cannot read', async () => {
      seedHighWaters();
      zulip.getStreamMessagesBefore.mockRejectedValue(
        new ZulipApiError(403, 'BAD_REQUEST', 'Invalid channel ID', 'GET'),
      );

      await start();

      expect(error()).toHaveBeenCalledWith(
        `${DEV_CHANNEL}: catch-up could not read Zulip stream ${DEV_STREAM}: Zulip GET failed with 403 BAD_REQUEST: Invalid channel ID`,
      );
    });
  });

  describe('onModuleDestroy', () => {
    it('should stop taking new work', async () => {
      await start();
      await sut.onModuleDestroy();

      await fromZulip(zulipMessage());

      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();
    });
  });
});
