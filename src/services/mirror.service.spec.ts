import { Logger } from '@nestjs/common';
import { Constants, MirrorPairConfig, MirrorPairKey } from 'src/constants';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import {
  DiscordMirrorChannel,
  DiscordMirrorError,
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
import { downloadDiscordAttachment } from 'src/mirror/download';
import { toDiscordThreadName } from 'src/mirror/names';
import { ZulipApiError } from 'src/repositories/zulip.client';
import {
  MirrorConversation,
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
  | 'getNewestMirrorZulipMessageId'
  | 'updateMirrorMessages'
  | 'removeMirrorMessages'
  | 'getMirrorZulipHighWater'
  | 'getMirrorDiscordHighWater';

/** Behaves like the real tables, unique constraints included, and hands out copies as the database does. */
const newMirrorDatabase = () => {
  const conversations: MirrorConversation[] = [];
  const messages: MirrorMessage[] = [];
  let sequence = 0;
  const conversation = (id: string) => conversations.find((row) => row.id === id);
  const copy = <T extends object>(row: T | undefined) => (row ? { ...row } : undefined);

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
      Object.assign(conversation(id)!, changes);
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
        messages.push({ createdAt: new Date(), ...row, part } as MirrorMessage);
      }
    }),
    getMirrorMessagesByDiscordIds: vitest.fn(async (ids: string[]) =>
      messages.filter(({ discordMessageId }) => ids.includes(discordMessageId)).map((row) => ({ ...row })),
    ),
    getMirrorMessagesByZulipIds: vitest.fn(async (ids: number[]) =>
      messages
        .filter(({ zulipMessageId }) => ids.includes(zulipMessageId))
        .sort((a, b) => a.zulipMessageId - b.zulipMessageId || a.part - b.part)
        .map((row) => ({ ...row })),
    ),
    getNewestMirrorZulipMessageId: vitest.fn(async (id: string) => {
      const ids = messages.filter(({ conversationId }) => conversationId === id).map((row) => row.zulipMessageId);
      return ids.length > 0 ? Math.max(...ids) : undefined;
    }),
    updateMirrorMessages: vitest.fn(async (ids: string[], changes: UpdateMirrorMessage) => {
      for (const message of messages.filter(({ discordMessageId }) => ids.includes(discordMessageId))) {
        Object.assign(message, changes);
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
  };
  return { conversations, messages, repository };
};

const mirrorChannel = (channelId: string): DiscordMirrorChannel => ({
  id: channelId,
  guildId: GUILD,
  name: channelId === FORUM ? 'dev-focus-topic' : 'dev',
  kind: channelId === FORUM ? 'forum' : 'text',
  categoryId: null,
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
    getTeamMember: vitest.fn().mockResolvedValue(TEAM_MEMBER),
    fetchMirrorMessagesAfter: vitest.fn().mockResolvedValue([]),
  };
};

const newZulipMock = (): Mocked<IZulipInterface> => {
  let id = 5000;
  return {
    init: vitest.fn(),
    isInitialised: vitest.fn().mockReturnValue(true),
    sendMessage: vitest.fn(async () => ({ id: ++id })),
    getMessage: vitest.fn(),
    updateMessage: vitest.fn().mockResolvedValue(undefined),
    createEmote: vitest.fn(),
    listEmoji: vitest.fn(),
    getSubscriptions: vitest.fn(),
    getOwnUser: vitest.fn(),
    getMessages: vitest.fn().mockResolvedValue([]),
    registerQueue: vitest.fn(),
    getEvents: vitest.fn(),
    deleteQueue: vitest.fn(),
    deleteMessage: vitest.fn().mockResolvedValue(undefined),
    uploadFile: vitest.fn(async (file: File) => ({ url: UPLOAD_URL, filename: file.name })),
    downloadUpload: vitest.fn(async (path: string) => new File(['bytes'], path.slice(path.lastIndexOf('/') + 1))),
    getStreamMessagesAfter: vitest.fn().mockResolvedValue([]),
    getEmojiCodes: vitest.fn().mockResolvedValue({ smile: '😄' }),
  };
};

const newZulipServiceStub = () => {
  const handlers = {
    message: [] as ZulipMessageHandler[],
    update: [] as ZulipUpdateHandler[],
    deletion: [] as ZulipDeletionHandler[],
    registration: [] as ZulipRegistrationHandler[],
  };
  const service = {
    ownUser: BOT,
    onMessage: vitest.fn((handler: ZulipMessageHandler) => handlers.message.push(handler)),
    onMessageUpdate: vitest.fn((handler: ZulipUpdateHandler) => handlers.update.push(handler)),
    onMessagesDeleted: vitest.fn((handler: ZulipDeletionHandler) => handlers.deletion.push(handler)),
    onQueueRegistered: vitest.fn((handler: ZulipRegistrationHandler) => handlers.registration.push(handler)),
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

describe(MirrorService.name, () => {
  let sut: MirrorService;
  let zulip: Mocked<IZulipInterface>;
  let discord: Mocked<IDiscordMirrorInterface>;
  let db: ReturnType<typeof newMirrorDatabase>;
  let stub: ReturnType<typeof newZulipServiceStub>;
  let savedPairs: Record<MirrorPairKey, MirrorPairConfig>;

  const log = () => vitest.mocked(Logger.prototype.log);
  const warn = () => vitest.mocked(Logger.prototype.warn);
  const error = () => vitest.mocked(Logger.prototype.error);

  beforeEach(() => {
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vitest.spyOn(Logger.prototype, level).mockImplementation(() => {});
    }
    savedPairs = structuredClone(Constants.Mirror.Pairs);
    Object.assign(Constants.Mirror.Pairs, {
      Dev: { kind: 'text', discordChannelId: DEV_CHANNEL, zulipStreamId: DEV_STREAM, mainTopic: '#dev' },
      DevOffTopic: {
        kind: 'text',
        discordChannelId: OFF_TOPIC_CHANNEL,
        zulipStreamId: OFF_TOPIC_STREAM,
        mainTopic: '#dev-off-topic',
      },
      DevFocusTopic: { kind: 'forum', discordChannelId: FORUM, zulipStreamId: FORUM_STREAM },
    });
    Constants.Mirror.TeamMembers[TEAM_ZULIP_ID] = TEAM_DISCORD_ID;
    config.bot.token = 'bot-token';
    config.zulip.bot.apiKey = 'bot-key';
    vitest.mocked(downloadDiscordAttachment).mockReset();

    zulip = newZulipMock();
    discord = newDiscordMirrorMock();
    db = newMirrorDatabase();
    stub = newZulipServiceStub();
    sut = new MirrorService(
      zulip,
      discord,
      db.repository as unknown as IDatabaseRepository,
      stub.service as unknown as ZulipService,
    );
  });

  afterEach(() => {
    Object.assign(Constants.Mirror.Pairs, savedPairs);
    delete Constants.Mirror.TeamMembers[TEAM_ZULIP_ID];
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
    sut.init();
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
      pair: 'Dev',
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
      ...overrides,
    };
    db.messages.push(row);
    return row;
  };

  const sent = (index: number) => discord.sendMirrorMessage.mock.calls[index][0];
  const sentMessages = () => zulip.sendMessage.mock.calls.map(([payload]) => payload);

  describe('modes', () => {
    it('should register nothing when Discord runs with the dev token', () => {
      config.bot.token = 'dev';
      sut.init();

      expect(log()).toHaveBeenCalledWith('The Discord-Zulip mirror is off: Discord or Zulip is not configured');
      expect(stub.service.onMessage).not.toHaveBeenCalled();
      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(false);
    });

    it('should register nothing when Zulip runs with the dev keys', () => {
      config.zulip.bot.apiKey = 'dev';
      sut.init();

      expect(stub.service.onQueueRegistered).not.toHaveBeenCalled();
      expect(warn()).not.toHaveBeenCalled();
    });

    it('should warn exactly once and stay inert with the placeholder IDs', async () => {
      Object.assign(Constants.Mirror.Pairs, savedPairs);
      delete Constants.Mirror.TeamMembers[TEAM_ZULIP_ID];

      sut.init();
      await sut.onDiscordReady();

      expect(warn()).toHaveBeenCalledExactlyOnceWith(
        'The Discord-Zulip mirror is off for Dev, DevOffTopic, DevFocusTopic until their placeholder IDs in Constants.Mirror.Pairs are filled in',
      );
      expect(error()).not.toHaveBeenCalled();
      for (const method of Object.values(stub.service).filter((value) => typeof value === 'function')) {
        expect(method).not.toHaveBeenCalled();
      }
      expect(sut.handlesChannel(FORUM)).toBe(false);
      expect(discord.getMirrorChannel).not.toHaveBeenCalled();
    });

    it('should log each configuration problem as an error and leave the pair off', () => {
      Constants.Mirror.Pairs.Dev.zulipStreamId = Constants.Zulip.TeamStreams.ImmichGeneral;
      sut.init();

      expect(error()).toHaveBeenCalledWith(
        'Dev: Zulip stream 107 is an internal stream in Constants.Zulip, so the pair is off',
      );
      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(false);
      expect(sut.handlesChannel(FORUM)).toBe(true);
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
        [`Dev: mirroring Discord channel ${DEV_CHANNEL} with Zulip stream ${DEV_STREAM} (main topic "#dev")`],
        [
          `DevOffTopic: mirroring Discord channel ${OFF_TOPIC_CHANNEL} with Zulip stream ${OFF_TOPIC_STREAM} (main topic "#dev-off-topic")`,
        ],
        [`DevFocusTopic: mirroring Discord channel ${FORUM} with Zulip stream ${FORUM_STREAM}`],
      ]);
    });

    it.each([
      ['is missing', undefined, 'does not exist or is not in an Immich server'],
      ['is in another guild', { guildId: '999999999999999999' }, 'does not exist or is not in an Immich server'],
      ['is not a text channel', { kind: 'forum' }, 'is not a text channel'],
      ['is in the Team category', { categoryId: Constants.Discord.Categories.Team }, 'is in the Team category'],
      [
        'is visible to everyone',
        { everyoneCanView: true },
        'is visible to @everyone and the pair is not marked public',
      ],
    ])('should turn the pair off when the channel %s', async (_, overrides, problem) => {
      discord.getMirrorChannel.mockImplementation(async (channelId) =>
        channelId === DEV_CHANNEL && overrides === undefined
          ? undefined
          : ({ ...mirrorChannel(channelId), ...overrides } as DiscordMirrorChannel),
      );
      sut.init();
      await sut.onDiscordReady();

      expect(error()).toHaveBeenCalledWith(`Dev: Discord channel ${DEV_CHANNEL} ${problem}, so the pair is off`);
      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(false);
      await fromZulip(zulipMessage());
      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();
    });

    it('should accept a public channel when the pair says so', async () => {
      Constants.Mirror.Pairs.Dev.public = true;
      discord.getMirrorChannel.mockImplementation(async (channelId) => ({
        ...mirrorChannel(channelId),
        everyoneCanView: true,
      }));
      await start();

      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(true);
    });

    it('should warn about missing permissions and keep the pair when it can still work', async () => {
      discord.getMirrorChannel.mockImplementation(async (channelId) => ({
        ...mirrorChannel(channelId),
        missingPermissions: channelId === DEV_CHANNEL ? ['EmbedLinks'] : [],
      }));
      await start();

      expect(warn()).toHaveBeenCalledWith(`Dev: the bot is missing EmbedLinks in Discord channel ${DEV_CHANNEL}`);
      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(true);
    });

    it.each(['ViewChannel', 'ManageWebhooks'])('should turn the pair off without %s', async (permission) => {
      discord.getMirrorChannel.mockImplementation(async (channelId) => ({
        ...mirrorChannel(channelId),
        missingPermissions: channelId === DEV_CHANNEL ? [permission, 'EmbedLinks'] : [],
      }));
      await start();

      expect(warn()).toHaveBeenCalledWith(
        `Dev: the bot is missing ${permission}, EmbedLinks in Discord channel ${DEV_CHANNEL}, so the pair is off`,
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

      expect(error()).toHaveBeenCalledWith(`Dev: could not check Discord channel ${DEV_CHANNEL}: forbidden (50001)`);
      await fromZulip(zulipMessage());
      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();
      await fromZulip(zulipMessage({ id: 1002, streamId: FORUM_STREAM, topic: 'idea' }));
      expect(discord.sendMirrorMessage).toHaveBeenCalledOnce();
    });

    it('should carry on when the webhook cannot be set up', async () => {
      discord.ensureMirrorWebhook.mockRejectedValue(new DiscordMirrorError('max-webhooks', 30_007));
      await start();

      expect(error()).toHaveBeenCalledWith(
        `Dev: could not set up the mirror webhook in Discord channel ${DEV_CHANNEL}: max-webhooks (30007)`,
      );
      expect(sut.handlesChannel(DEV_CHANNEL)).toBe(true);
    });

    it('should warn about a mirror stream the Zulip bot is not subscribed to', async () => {
      sut.init();
      await sut.onDiscordReady();
      await register([DEV_STREAM, OFF_TOPIC_STREAM]);

      expect(warn()).toHaveBeenCalledExactlyOnceWith(
        `DevFocusTopic: the Zulip bot is not subscribed to stream ${FORUM_STREAM}, so nothing posted there is mirrored until an admin subscribes it`,
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
      expect(sent(1)).toEqual(expect.objectContaining({ threadId, content: 'b'.repeat(1500) }));
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

      expect(sent(0)).toEqual(expect.objectContaining({ channelId: FORUM, threadName: 'Feature idea' }));
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
        'Dev: could not start a Discord thread for Zulip message 1001: forbidden (50013)',
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

    it('should fall back and log one error for a team member without the role', async () => {
      discord.getTeamMember.mockResolvedValue({ displayName: 'Alex', avatarUrl: 'x', roleIds: ['1'] });

      await fromZulip(zulipMessage({ senderId: TEAM_ZULIP_ID, senderFullName: 'Alex Tran' }));
      await fromZulip(zulipMessage({ id: 1002, senderId: TEAM_ZULIP_ID, senderFullName: 'Alex Tran' }));

      expect(sent(0).username).toBe('Alex Tran (Zulip)');
      expect(sent(0).avatarUrl).toBeUndefined();
      expect(error()).toHaveBeenCalledExactlyOnceWith(
        `Constants.Mirror.TeamMembers maps Zulip user ${TEAM_ZULIP_ID} to Discord user ${TEAM_DISCORD_ID}, who is not in the guild or holds neither the Team nor the Immich role`,
      );
    });

    it('should name an unmapped sender with a suffix, no avatar and one warning', async () => {
      await fromZulip(zulipMessage());
      await fromZulip(zulipMessage({ id: 1002 }));

      expect(sent(1)).toEqual(expect.objectContaining({ username: 'Bea (Zulip)' }));
      expect(sent(1).avatarUrl).toBeUndefined();
      expect(warn()).toHaveBeenCalledExactlyOnceWith(
        'Zulip user 20 is not in Constants.Mirror.TeamMembers; their messages appear on Discord as "Name (Zulip)"',
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

    it('should resolve unicode and custom emoji', async () => {
      discord.getEmotes.mockResolvedValue([
        { identifier: 'PartyParrot:500000000000000001', name: 'PartyParrot', url: 'x', animated: false },
      ]);

      await fromZulip(zulipMessage({ content: 'nice :smile: :partyparrot: :unknown:' }));
      await fromZulip(zulipMessage({ id: 1002, content: ':smile:' }));

      expect(sent(0).content).toBe('nice 😄 <PartyParrot:500000000000000001> :unknown:');
      expect(zulip.getEmojiCodes).toHaveBeenCalledOnce();
      expect(discord.getEmotes).toHaveBeenCalledOnce();
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
      );
      expect(sent(0).content).toBe('look\n*(attachment not mirrored: big.zip)*');
      expect(sent(0).files?.map(({ name }) => name)).toEqual(['shot.png']);
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

    it('should recreate a deleted webhook and retry once, at most once an hour', async () => {
      discord.sendMirrorMessage.mockRejectedValueOnce(new DiscordMirrorError('unknown-webhook', 10_015));
      await fromZulip(zulipMessage());

      expect(discord.ensureMirrorWebhook).toHaveBeenCalledTimes(4);
      expect(discord.ensureMirrorWebhook).toHaveBeenLastCalledWith(DEV_CHANNEL);
      expect(discord.sendMirrorMessage).toHaveBeenCalledTimes(2);
      expect(db.messages).toHaveLength(1);

      discord.sendMirrorMessage.mockRejectedValueOnce(new DiscordMirrorError('unknown-webhook', 10_015));
      await fromZulip(zulipMessage({ id: 1002 }));

      expect(discord.ensureMirrorWebhook).toHaveBeenCalledTimes(4);
      expect(error()).toHaveBeenCalledWith(
        `Dev: the Zulip mirror webhook in #dev (${DEV_CHANNEL}) was deleted again; deny the bot Manage Webhooks there to stop the mirror, or wait an hour`,
      );
      expect(zulip.sendMessage).not.toHaveBeenCalled();
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
        'Dev: could not mirror Zulip message 1001 to Discord: forbidden (50013)',
      );
    });

    it('should only warn when the Discord thread is locked', async () => {
      seedThread();
      discord.sendMirrorMessage.mockRejectedValue(new DiscordMirrorError('locked', 160_005));

      await fromZulip(zulipMessage({ topic: 'Crash on upload' }));

      expect(warn()).toHaveBeenCalledWith(
        'Dev: could not mirror Zulip message 1001 to Discord: the Discord thread is locked',
      );
      expect(zulip.sendMessage).not.toHaveBeenCalled();
    });

    it('should mark a message mirrored late', async () => {
      const timestamp = Math.floor(Date.now() / 1000) - 600;
      await fromZulip(zulipMessage({ timestamp }));

      expect(sent(0).content).toBe(`hello\n-# sent <t:${timestamp}:f>`);
    });

    it('should post the notes alone when the only upload could not be attached', async () => {
      zulip.downloadUpload.mockRejectedValue(new Error('Zulip answered the download with status 404'));

      await fromZulip(zulipMessage({ content: '[shot.png](/user_uploads/2/ab/cdef/shot.png)' }));

      expect(sent(0)).toEqual(expect.objectContaining({ content: '*(attachment not mirrored: shot.png)*', files: [] }));
      expect(warn()).toHaveBeenCalledWith(
        'Dev: could not download upload 1 of Zulip message 1001: Zulip answered the download with status 404',
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
      expect(error()).toHaveBeenCalledWith('Dev: could not mirror part 2 of Zulip message 1001 to Discord: other');
    });

    it('should move the main conversation to a main topic that changed', async () => {
      seedThread({ discordThreadId: null, zulipTopic: '#old', zulipTopicKey: '#old', zulipAnchorMessageId: null });

      await fromZulip(zulipMessage());

      expect(sent(0).threadId).toBeUndefined();
      expect(db.conversations).toEqual([expect.objectContaining({ zulipTopic: '#dev', zulipTopicKey: '#dev' })]);
    });

    it('should log a notice that cannot be posted', async () => {
      discord.sendMirrorMessage.mockRejectedValue(new DiscordMirrorError('forbidden', 50_013));
      zulip.sendMessage.mockRejectedValue(new TypeError('fetch failed'));

      await fromZulip(zulipMessage());

      expect(error()).toHaveBeenCalledWith(
        `Dev: could not post the not-mirrored notice in Zulip stream ${DEV_STREAM}: fetch failed`,
      );
    });

    it('should log an unexpected failure with its stack', async () => {
      const failure = new Error('bug');
      db.repository.getMirrorConversationByZulipTopic.mockRejectedValueOnce(failure);

      await fromZulip(zulipMessage());

      expect(error()).toHaveBeenCalledWith('Dev: could not mirror Zulip message 1001 to Discord: bug', failure);
    });

    it('should not wait for Discord when it is not ready, and say so once', async () => {
      discord.isReady.mockReturnValue(false);

      await fromZulip(zulipMessage());
      await fromZulip(zulipMessage({ id: 1002 }));

      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();
      expect(warn()).toHaveBeenCalledExactlyOnceWith(
        'Dev: not mirroring yet: Discord is not ready; catch-up picks it up once both sides are',
      );
    });
  });

  describe('filters', () => {
    beforeEach(start);

    it.each([
      ['a stream without a pair', { streamId: 107 }],
      ['a direct message', { type: 'private' as const, streamId: undefined }],
      ['a command to the bot', { content: `@**${BOT.fullName}** help` }],
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

    it('should ignore updates and deletions in a stream without a pair', async () => {
      await updateFromZulip({ messageId: 42, content: 'edited', streamId: 107 });
      await deleteFromZulip({ messageIds: [42], streamId: 107 });

      expect(db.repository.getMirrorMessagesByZulipIds).not.toHaveBeenCalled();
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

    it('should never give a thread the main topic', async () => {
      await fromDiscord(discordMessage({ threadId: '200000000000000001', threadName: '#DEV' }));

      expect(sentMessages()[0].topic).toBe('#DEV (2)');
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
      zulip.getMessage.mockResolvedValue({ id: 42, topic: 'New' });

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
      const thread = seedThread({ zulipTopic: 'general chat', zulipTopicKey: 'general chat' });
      zulip.getMessage.mockResolvedValue({ id: 70, topic: '' });

      await fromDiscord(discordMessage({ threadId: thread.discordThreadId }));

      expect(sentMessages()[0].topic).toBe('general chat');
    });

    it('should re-anchor a conversation whose anchor is gone', async () => {
      const thread = seedThread({ zulipAnchorMessageId: 42 });
      seedRow({ zulipMessageId: 60, conversationId: thread.id });
      zulip.getMessage.mockRejectedValue(new ZulipApiError(400, 'BAD_REQUEST', 'Invalid message(s)', 'GET'));

      await fromDiscord(discordMessage({ threadId: thread.discordThreadId }));

      expect(db.conversations[0].zulipAnchorMessageId).toBe(60);
      expect(sentMessages()[0].topic).toBe('Crash on upload');
    });

    it('should detach a conversation whose topic was merged into another one', async () => {
      seedThread({ id: 'other', discordThreadId: '200000000000000009', zulipTopic: 'Other', zulipTopicKey: 'other' });
      const thread = seedThread({ zulipAnchorMessageId: 42 });
      zulip.getMessage.mockResolvedValue({ id: 42, topic: 'other' });

      await fromDiscord(discordMessage({ threadId: thread.discordThreadId, threadName: 'Crash on upload' }));

      expect(db.conversations.map(({ id }) => id)).toEqual(['other', expect.any(String)]);
      expect(sentMessages()[0].topic).toBe('Crash on upload');
    });

    it('should translate a verified team member mention, silently when the message is silent', async () => {
      await fromDiscord(discordMessage({ content: `<@${TEAM_DISCORD_ID}> look` }));
      await fromDiscord(
        discordMessage({ id: '300000000000000002', content: `<@${TEAM_DISCORD_ID}> look`, silent: true }),
      );

      expect(sentMessages().map(({ content }) => content)).toEqual([
        `**Contrib** (&#64;contrib123): @**|${TEAM_ZULIP_ID}** look`,
        `**Contrib** (&#64;contrib123): @_**|${TEAM_ZULIP_ID}** look`,
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

      expect(downloadDiscordAttachment).toHaveBeenCalledWith(attachment, Constants.Mirror.MaxUploadBytes);
      expect(zulip.uploadFile).toHaveBeenCalledOnce();
      const content = sentMessages()[0].content;
      expect(content).toContain(`[log 1.txt](${UPLOAD_URL})`);
      expect(content).toContain('*(attachment not mirrored: gone.txt, see [Discord](https://discord.com/channels/');
      expect(db.messages[0].zulipAttachments).toContain(`[log 1.txt](${UPLOAD_URL})`);
      expect(warn()).toHaveBeenCalledWith(
        'Dev: could not mirror attachment a2 of Discord message 300000000000000001: Discord answered the attachment download with status 404',
      );
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

    it('should log a failed post and carry on', async () => {
      zulip.sendMessage.mockRejectedValueOnce(new ZulipApiError(500, 'BAD_GATEWAY', 'down', 'POST /messages'));

      await fromDiscord(discordMessage());
      await fromDiscord(discordMessage({ id: '300000000000000002' }));

      expect(error()).toHaveBeenCalledWith(
        'Dev: could not mirror Discord message 300000000000000001 to Zulip: Zulip POST /messages failed with 500 BAD_GATEWAY: down',
      );
      expect(zulip.sendMessage).toHaveBeenCalledTimes(2);
      expect(db.messages.map(({ discordMessageId }) => discordMessageId)).toEqual(['300000000000000002']);
    });

    it('should not wait for Zulip when it is not ready, and say so once', async () => {
      zulip.isInitialised.mockReturnValue(false);

      await fromDiscord(discordMessage());
      await fromDiscord(discordMessage({ id: '300000000000000002' }));

      expect(zulip.sendMessage).not.toHaveBeenCalled();
      expect(warn()).toHaveBeenCalledExactlyOnceWith(
        'Dev: not mirroring yet: Zulip is not ready; catch-up picks it up once both sides are',
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
        'Dev: Zulip refused the edit of message 5001 (the copy of Discord message 300000000000000001): Zulip PATCH failed with 400 BAD_REQUEST: The time limit for editing this message has passed',
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
    });

    it('should grow and shrink the Discord copy, never deleting part 0', async () => {
      await fromZulip(zulipMessage({ content: paragraphs('a', 'b') }));
      const [part0, part1] = db.messages.map((row) => row.discordMessageId);

      await updateFromZulip({ messageId: 1001, content: paragraphs('c', 'd', 'e') });

      expect(discord.editMirrorMessage.mock.calls).toEqual([
        [expect.objectContaining({ messageId: part0 }), { content: 'c'.repeat(1500), suppressEmbeds: false }],
        [expect.objectContaining({ messageId: part1 }), { content: 'd'.repeat(1500), suppressEmbeds: false }],
      ]);
      expect(sent(2)).toEqual(expect.objectContaining({ content: 'e'.repeat(1500), username: 'Bea (Zulip)' }));
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
        `Dev: could not update Discord message ${db.messages[0].discordMessageId} (the copy of Zulip message 1001): ${reason}`,
      );
    });

    it('should forget a copy a moderator deleted on Discord', async () => {
      await fromZulip(zulipMessage());
      discord.editMirrorMessage.mockRejectedValue(new DiscordMirrorError('unknown-message', 10_008));

      await updateFromZulip({ messageId: 1001, content: 'edited' });

      expect(db.messages).toEqual([]);
    });
  });

  describe('deletions', () => {
    beforeEach(start);

    it('should delete the Zulip copy of a deleted Discord message, removing the row first', async () => {
      await fromDiscord(discordMessage());

      sut.onDiscordMessagesDeleted(DEV_CHANNEL, ['300000000000000001']);
      await sut.whenIdle();

      expect(zulip.deleteMessage).toHaveBeenCalledExactlyOnceWith(5001);
      expect(db.repository.removeMirrorMessages.mock.invocationCallOrder[0]).toBeLessThan(
        zulip.deleteMessage.mock.invocationCallOrder[0],
      );
      expect(db.messages).toEqual([]);

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
        "Dev: Zulip refused to delete message 5001 (the copy of Discord message 300000000000000001); add the bot to the stream's can_delete_any_message_group",
      );
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

      expect(db.messages).toEqual([]);
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
      expect(db.messages).toEqual([]);
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
        `Dev: Zulip deleted 2 mirrored messages older than 7 days; not deleting their Discord copies (Discord messages ${ids.join(', ')}); delete them there by hand if this was intended`,
      );
    });

    it('should never delete a Discord message when Zulip deletes its copy', async () => {
      await fromDiscord(discordMessage());

      await deleteFromZulip({ messageIds: [5001] });

      expect(discord.deleteMirrorMessage).not.toHaveBeenCalled();
      expect(db.messages).toEqual([]);
    });

    it('should re-anchor a conversation whose anchor was deleted', async () => {
      await fromZulip(zulipMessage({ topic: 'Crash' }));
      await fromZulip(zulipMessage({ id: 1002, topic: 'Crash' }));

      await deleteFromZulip({ messageIds: [1001] });
      expect(db.conversations[0].zulipAnchorMessageId).toBe(1002);

      await deleteFromZulip({ messageIds: [1002] });
      expect(db.conversations[0].zulipAnchorMessageId).toBeNull();

      await fromZulip(zulipMessage({ id: 1003, topic: 'Crash' }));
      expect(db.conversations[0].zulipAnchorMessageId).toBe(1003);
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
        `Dev: could not rename Discord thread ${threadId} after its Zulip topic moved: forbidden (50013)`,
      );
    });

    it('should rename the Zulip topic to a unique name, keeping it resolved and without notifications', async () => {
      db.conversations[0].zulipTopic = '✔ Crash';
      db.conversations[0].zulipTopicKey = '✔ crash';
      await register();
      zulip.getMessage.mockResolvedValue({ id: 1001, topic: '✔ Crash' });
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

    it('should keep the stored topic when Zulip refuses the rename', async () => {
      zulip.updateMessage.mockRejectedValue(
        new ZulipApiError(400, 'BAD_REQUEST', "The time limit for editing this message's topic has passed.", 'PATCH'),
      );

      sut.onDiscordThreadRenamed({ channelId: DEV_CHANNEL, threadId, name: 'Crash on start' });
      await sut.whenIdle();

      expect(warn()).toHaveBeenCalledWith(
        expect.stringContaining(`Dev: Zulip refused to rename the topic of Discord thread ${threadId}`),
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

  describe('onModuleDestroy', () => {
    it('should stop taking new work', async () => {
      await start();
      await sut.onModuleDestroy();

      await fromZulip(zulipMessage());

      expect(discord.sendMirrorMessage).not.toHaveBeenCalled();
    });
  });
});
