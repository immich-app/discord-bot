import { Logger } from '@nestjs/common';
import { Constants } from 'src/constants';
import { IDatabaseRepository, MirrorIdentityOwner } from 'src/interfaces/database.interface';
import {
  DiscordMirrorChannel,
  DiscordMirrorError,
  IDiscordMirrorInterface,
} from 'src/interfaces/discord-mirror.interface';
import { IZulipInterface, ZulipStream } from 'src/interfaces/zulip.interface';
import { MirrorIdentity, MirrorLink, NewMirrorLink } from 'src/schema';
import { MirrorActor, MirrorLinkService } from 'src/services/mirror-link.service';
import { MirrorService } from 'src/services/mirror.service';
import { ZulipService } from 'src/services/zulip.service';
import { afterEach, beforeEach, describe, expect, it, Mocked, vitest } from 'vitest';

const CHANNEL = '100000000000000001';
const FORUM = '100000000000000002';
const STREAM = 120;
const FORUM_STREAM = 122;
const ALEX: MirrorActor = { platform: 'discord', id: '400000000000000012', name: 'Alex' };
const BEA: MirrorActor = { platform: 'zulip', id: '20', name: 'Bea' };

const newDatabase = () => {
  const links: MirrorLink[] = [];
  const identities: MirrorIdentity[] = [];
  const repository: Mocked<
    Pick<
      IDatabaseRepository,
      | 'getMirrorLinks'
      | 'createMirrorLink'
      | 'setMirrorLinkAnnouncement'
      | 'removeMirrorLink'
      | 'getMirrorIdentities'
      | 'setMirrorIdentity'
      | 'removeMirrorIdentity'
    >
  > = {
    getMirrorLinks: vitest.fn(async () => links.map((link) => ({ ...link }))),
    createMirrorLink: vitest.fn(async (entity: NewMirrorLink) => {
      const created = { discordAnnouncementId: null, createdAt: new Date(), ...entity } as MirrorLink;
      links.push(created);
      return { ...created };
    }),
    setMirrorLinkAnnouncement: vitest.fn(async (channelId: string, announcementId: string | null) => {
      const link = links.find(({ discordChannelId }) => discordChannelId === channelId);
      if (link) {
        link.discordAnnouncementId = announcementId;
      }
    }),
    removeMirrorLink: vitest.fn(async (channelId: string) => {
      const index = links.findIndex(({ discordChannelId }) => discordChannelId === channelId);
      return index === -1 ? undefined : links.splice(index, 1)[0];
    }),
    getMirrorIdentities: vitest.fn(async () => identities.map((identity) => ({ ...identity }))),
    setMirrorIdentity: vitest.fn(async (zulipUserId: number, discordUserId: string) => {
      const replaced = identities.filter(
        (identity) => identity.zulipUserId === zulipUserId || identity.discordUserId === discordUserId,
      );
      identities.splice(0, identities.length, ...identities.filter((identity) => !replaced.includes(identity)));
      identities.push({ zulipUserId, discordUserId, createdAt: new Date() });
      return replaced;
    }),
    removeMirrorIdentity: vitest.fn(async (owner: MirrorIdentityOwner) => {
      const index = identities.findIndex((identity) =>
        'zulipUserId' in owner
          ? identity.zulipUserId === owner.zulipUserId
          : identity.discordUserId === owner.discordUserId,
      );
      return index === -1 ? undefined : identities.splice(index, 1)[0];
    }),
  };
  return { links, identities, repository };
};

const channel = (overrides: Partial<DiscordMirrorChannel> = {}): DiscordMirrorChannel => ({
  id: CHANNEL,
  guildId: Constants.Discord.Servers[0],
  name: 'dev',
  kind: 'text',
  everyoneCanView: true,
  missingPermissions: [],
  ...overrides,
});

const streams: Record<number, ZulipStream> = {
  [STREAM]: { streamId: STREAM, name: 'immich-dev', inviteOnly: true },
  [FORUM_STREAM]: { streamId: FORUM_STREAM, name: 'immich-dev-focus-topic', inviteOnly: false },
};

describe(MirrorLinkService.name, () => {
  let sut: MirrorLinkService;
  let db: ReturnType<typeof newDatabase>;
  let discord: Mocked<
    Pick<
      IDiscordMirrorInterface,
      'isReady' | 'getMirrorChannel' | 'sendMirrorNotice' | 'unpinMirrorNotice' | 'getTeamMember'
    >
  >;
  let zulip: Mocked<Pick<IZulipInterface, 'getStream' | 'getSubscriptions' | 'sendMessage' | 'getUser'>>;
  let mirror: Mocked<Pick<MirrorService, 'isActive' | 'enable' | 'disable' | 'refreshIdentities' | 'handlesChannel'>>;

  const zulipPosts = () => zulip.sendMessage.mock.calls.map(([payload]) => payload);
  const discordPosts = () => discord.sendMirrorNotice.mock.calls;

  beforeEach(() => {
    vitest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    db = newDatabase();
    discord = {
      isReady: vitest.fn().mockReturnValue(true),
      getMirrorChannel: vitest.fn(async (id: string) =>
        id === FORUM
          ? channel({ id, name: 'dev-focus-topic', kind: 'forum', everyoneCanView: false })
          : channel({ id }),
      ),
      sendMirrorNotice: vitest.fn().mockResolvedValue({ messageId: '300000000000000001', pinned: true }),
      unpinMirrorNotice: vitest.fn().mockResolvedValue(undefined),
      getTeamMember: vitest.fn().mockResolvedValue({
        displayName: 'Alex',
        avatarUrl: 'https://cdn.discordapp.com/a.png',
        roleIds: [Constants.Discord.Roles.Team],
      }),
    };
    zulip = {
      getStream: vitest.fn(async (id: number) => {
        if (!streams[id]) {
          throw new Error('Invalid channel ID');
        }
        return streams[id];
      }),
      getSubscriptions: vitest.fn().mockResolvedValue([{ streamId: STREAM }, { streamId: FORUM_STREAM }]),
      sendMessage: vitest.fn().mockResolvedValue({ id: 1 }),
      getUser: vitest.fn().mockResolvedValue({ userId: 12, fullName: 'Alex Tran', role: 400 }),
    };
    mirror = {
      isActive: vitest.fn().mockReturnValue(true),
      enable: vitest.fn().mockResolvedValue(true),
      disable: vitest.fn(),
      refreshIdentities: vitest.fn().mockResolvedValue(undefined),
      handlesChannel: vitest.fn().mockReturnValue(true),
    };
    sut = new MirrorLinkService(
      db.repository as unknown as IDatabaseRepository,
      discord as unknown as IDiscordMirrorInterface,
      zulip as unknown as IZulipInterface,
      mirror as unknown as MirrorService,
      { ownUser: { userId: 7, fullName: 'Immich Bot' }, emptyTopicName: 'general chat' } as unknown as ZulipService,
    );
  });

  afterEach(() => {
    vitest.restoreAllMocks();
    vitest.useRealTimers();
  });

  const idOf = (reply: string) => /`\/mirror-link id:([A-Z2-9]{6})`/.exec(reply)![1];

  const request = (zulipStreamId = STREAM, mainTopic?: string, actor = BEA) =>
    sut.requestLink({ zulipStreamId, mainTopic, actor });

  const linkVia = async (discordChannelId: string, zulipStreamId: number, mainTopic?: string) =>
    sut.completeLink({ linkId: idOf(await request(zulipStreamId, mainTopic)), discordChannelId, actor: ALEX });

  describe('requestLink', () => {
    it('should answer with the Discord command to run and change nothing yet', async () => {
      const reply = await request();
      const id = idOf(reply);

      expect(reply).toBe(
        [
          `To mirror this stream with a Discord channel, run \`/mirror-link id:${id}\` in that channel on the Immich Discord server (for a forum, in any of its posts); it takes a member with the Administrator permission there. The ID expires in 1 hour and works once. Nothing is mirrored until then.`,
          "A text channel's own messages will go to the general chat topic (`mirror-link topic=<name>` names another); a forum has no main topic, each post gets a topic of its own.",
        ].join('\n'),
      );
      expect(db.repository.createMirrorLink).not.toHaveBeenCalled();
      expect(mirror.enable).not.toHaveBeenCalled();
      expect(zulip.sendMessage).not.toHaveBeenCalled();
      expect(discord.sendMirrorNotice).not.toHaveBeenCalled();
    });

    it('should name the main topic given', async () => {
      expect(await request(STREAM, 'dev chat')).toContain(
        "A text channel's own messages will go to the topic `dev chat`;",
      );
    });

    it('should take the empty topic by its display name', async () => {
      expect(await request(STREAM, 'general chat')).toContain(
        "A text channel's own messages will go to the general chat topic;",
      );
      await linkVia(CHANNEL, STREAM, 'general chat');

      expect(db.links.at(-1)!.mainTopic).toBe('');
    });

    it.each([
      [
        'the mirror is off',
        () => mirror.isActive.mockReturnValue(false),
        undefined,
        'The mirror is off in this deployment: Discord or Zulip is not configured.',
      ],
      [
        'the main topic is too long',
        () => {},
        'x'.repeat(59),
        `Could not use \`${'x'.repeat(59)}\`: the main topic must be 1 to 58 characters with no surrounding whitespace.`,
      ],
    ])('should refuse when %s', async (_, arrange, mainTopic, reply) => {
      arrange();

      expect(await request(STREAM, mainTopic)).toBe(reply);
    });

    it('should refuse a stream that is linked already, naming its channel', async () => {
      await linkVia(CHANNEL, STREAM);

      expect(await request()).toBe(
        `This stream is already mirrored with the Discord channel **#dev** (${CHANNEL}): a stream can be in one link only, so unlink it first with \`mirror-unlink\`.`,
      );
    });

    it('should keep one request per stream, the newest', async () => {
      const first = idOf(await request());
      const second = await request();

      expect(second).toContain('This replaces the earlier request for this stream, whose ID no longer works.');
      expect((await sut.completeLink({ linkId: first, discordChannelId: CHANNEL, actor: ALEX })).summary).toMatch(
        /is not a link ID, or it has expired or been used/,
      );
      expect(
        (await sut.completeLink({ linkId: idOf(second), discordChannelId: CHANNEL, actor: ALEX })).summary,
      ).toMatch(/^Linked/);
    });
  });

  describe('completeLink', () => {
    it('should link the text channel, turn it on and announce it on both sides with both admins', async () => {
      const reply = await linkVia(CHANNEL, STREAM);

      expect(db.links).toEqual([
        expect.objectContaining({
          discordChannelId: CHANNEL,
          zulipStreamId: STREAM,
          kind: 'text',
          mainTopic: '',
          createdBy: 'Bea on Zulip (user 20) and Alex on Discord (user 400000000000000012)',
          discordAnnouncementId: '300000000000000001',
        }),
      ]);
      expect(mirror.enable).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ discordChannelId: CHANNEL }));
      expect(zulipPosts()).toEqual([
        {
          stream: STREAM,
          topic: '',
          content: `🔗 This stream is now mirrored with the Discord channel **#dev** (${CHANNEL}), requested by Bea on Zulip and completed by Alex on Discord. Everything posted here is copied to Discord, and everything posted there is copied here. Messages in the general chat topic go to the Discord channel itself; every other topic becomes a thread there, and every thread there a topic here.`,
        },
      ]);
      expect(discordPosts()).toEqual([
        [
          CHANNEL,
          {
            title: 'Mirrored with Zulip #immich-dev',
            content: `🔗 This channel is now mirrored with the Zulip stream **#immich-dev** (${STREAM}), requested by Bea on Zulip and completed by Alex on Discord. Everything posted here is copied to Zulip, and everything posted there is copied here. Messages in this channel go to the Zulip general chat topic; each thread gets a topic of its own.`,
          },
          true,
        ],
      ]);
      expect(reply).toEqual({
        summary: `Linked Discord channel **#dev** (${CHANNEL}) with Zulip stream **#immich-dev** (${STREAM}): everything posted on either side is now copied to the other. The channel's own messages go to the general chat topic, and each thread gets a topic of its own.`,
        details: ['Who can read it: the Discord channel is visible to @​everyone; the Zulip stream is private.'],
      });
    });

    it('should link a forum without a main topic, announcing it in the mirror topic and a forum post', async () => {
      const reply = await linkVia(FORUM, FORUM_STREAM, 'ideas');

      expect(db.links[0]).toEqual(expect.objectContaining({ kind: 'forum', mainTopic: null }));
      expect(zulipPosts()).toEqual([
        {
          stream: FORUM_STREAM,
          topic: 'mirror',
          content: `🔗 This stream is now mirrored with the Discord channel **#dev-focus-topic** (${FORUM}), requested by Bea on Zulip and completed by Alex on Discord. Everything posted here is copied to Discord, and everything posted there is copied here. Each topic here is a post in the Discord forum, and each post there is a topic here.`,
        },
      ]);
      expect(discordPosts()[0][1]).toEqual({
        title: 'Mirrored with Zulip #immich-dev-focus-topic',
        content: `🔗 This channel is now mirrored with the Zulip stream **#immich-dev-focus-topic** (${FORUM_STREAM}), requested by Bea on Zulip and completed by Alex on Discord. Everything posted here is copied to Zulip, and everything posted there is copied here. Each post here is a topic in the Zulip stream, and each topic there is a post here.`,
      });
      expect(reply).toEqual({
        summary: `Linked Discord channel **#dev-focus-topic** (${FORUM}) with Zulip stream **#immich-dev-focus-topic** (${FORUM_STREAM}): everything posted on either side is now copied to the other. Each forum post is a topic of its own.`,
        details: [
          'Who can read it: the Discord channel is not visible to @​everyone; the Zulip stream is public to the organization.',
          'The main topic `ideas` is not used: a forum has none.',
        ],
      });
    });

    it('should take the main topic the request gave', async () => {
      await linkVia(CHANNEL, STREAM, 'dev chat');

      expect(db.links[0].mainTopic).toBe('dev chat');
      expect(zulipPosts()[0]).toEqual(
        expect.objectContaining({
          topic: 'dev chat',
          content: expect.stringContaining('Messages in the topic `dev chat` go to the Discord channel itself;'),
        }),
      );
      expect(discordPosts()[0][1].content).toContain('Messages in this channel go to the Zulip topic `dev chat`;');
    });

    it('should take the ID in any case and with separators', async () => {
      const id = idOf(await request());

      const reply = await sut.completeLink({
        linkId: ` ${id.slice(0, 3).toLowerCase()}-${id.slice(3)} `,
        discordChannelId: CHANNEL,
        actor: ALEX,
      });

      expect(reply.summary).toMatch(/^Linked/);
    });

    it('should take an ID once, and not after an hour', async () => {
      vitest.useFakeTimers();
      const used = idOf(await request());
      await sut.completeLink({ linkId: used, discordChannelId: CHANNEL, actor: ALEX });
      await sut.unlink({ discordChannelId: CHANNEL, actor: ALEX });
      const late = idOf(await request());
      vitest.advanceTimersByTime(60 * 60 * 1000);

      for (const linkId of [used, late, 'ZZZZZZ']) {
        expect(await sut.completeLink({ linkId, discordChannelId: CHANNEL, actor: ALEX })).toEqual({
          summary: `\`${linkId}\` is not a link ID, or it has expired or been used. Start again in the Zulip stream to link, with \`@Immich Bot mirror-link\`.`,
          details: [],
        });
      }
      expect(db.links).toEqual([]);
    });

    it('should keep the ID when the channel is refused, so that it can be run in the right one', async () => {
      const id = idOf(await request());
      discord.getMirrorChannel.mockResolvedValueOnce(channel({ kind: 'other' }));

      expect((await sut.completeLink({ linkId: id, discordChannelId: CHANNEL, actor: ALEX })).summary).toBe(
        `Discord channel **#dev** (${CHANNEL}) is neither a text channel nor a forum.`,
      );
      expect((await sut.completeLink({ linkId: id, discordChannelId: CHANNEL, actor: ALEX })).summary).toMatch(
        /^Linked/,
      );
    });

    it('should neutralise names on each side, so an announcement can ping nobody', async () => {
      zulip.getStream.mockResolvedValue({ streamId: STREAM, name: '@**all**', inviteOnly: true });

      const reply = await sut.completeLink({
        linkId: idOf(await request(STREAM, undefined, { platform: 'zulip', id: '20', name: '@**all** @everyone' })),
        discordChannelId: CHANNEL,
        actor: { platform: 'discord', id: '1', name: '@everyone' },
      });

      expect(zulipPosts()[0].content).toContain(
        'requested by @​**all** @everyone on Zulip and completed by @everyone on Discord',
      );
      expect(discordPosts()[0][1].content).toContain(
        'the Zulip stream **#@​\\*\\*all\\*\\*** (120), requested by @​\\*\\*all\\*\\* @​everyone on Zulip and completed by @​everyone on Discord',
      );
      expect(reply.summary).toContain('Zulip stream **#@​\\*\\*all\\*\\*** (120)');
    });

    it.each([
      [
        'the mirror is off',
        () => mirror.isActive.mockReturnValue(false),
        'The mirror is off in this deployment: Discord or Zulip is not configured.',
      ],
      [
        'the channel does not exist',
        () => discord.getMirrorChannel.mockResolvedValue(undefined),
        `Discord channel ${CHANNEL} does not exist, or the bot cannot see it.`,
      ],
      [
        'the channel cannot be read',
        () => discord.getMirrorChannel.mockRejectedValue(new DiscordMirrorError('forbidden', 50_001)),
        `Could not read Discord channel ${CHANNEL}: forbidden (50001).`,
      ],
      [
        'the bot cannot manage webhooks there',
        () =>
          discord.getMirrorChannel.mockResolvedValue(channel({ missingPermissions: ['ManageWebhooks', 'EmbedLinks'] })),
        `The bot needs ViewChannel and ManageWebhooks in Discord channel **#dev** (${CHANNEL}) to mirror it, and is missing ManageWebhooks.`,
      ],
      [
        'the stream is gone',
        () => zulip.getStream.mockRejectedValue(new Error('Invalid channel ID')),
        `Zulip stream ${STREAM} does not exist, or the bot cannot see it: Invalid channel ID.`,
      ],
      [
        'the bot is not subscribed',
        () => zulip.getSubscriptions.mockResolvedValue([]),
        `The bot is not subscribed to Zulip stream **#immich-dev** (${STREAM}), so it could neither read nor post there: subscribe it first.`,
      ],
    ])('should refuse when %s, and change nothing', async (_, arrange, summary) => {
      const id = idOf(await request());
      arrange();

      const reply = await sut.completeLink({ linkId: id, discordChannelId: CHANNEL, actor: ALEX });

      expect(reply).toEqual({ summary, details: [] });
      expect(db.repository.createMirrorLink).not.toHaveBeenCalled();
      expect(mirror.enable).not.toHaveBeenCalled();
      expect(zulip.sendMessage).not.toHaveBeenCalled();
      expect(discord.sendMirrorNotice).not.toHaveBeenCalled();
    });

    it('should refuse a channel that is linked already, naming that link', async () => {
      const first = idOf(await request(STREAM));
      const second = idOf(await request(FORUM_STREAM));
      await sut.completeLink({ linkId: first, discordChannelId: CHANNEL, actor: ALEX });

      const reply = await sut.completeLink({ linkId: second, discordChannelId: CHANNEL, actor: ALEX });

      expect(reply.summary).toBe(
        `Discord channel **#dev** (${CHANNEL}) is already mirrored with Zulip stream **#immich-dev** (${STREAM}): a channel and a stream can each be in one link only, so unlink that one first.`,
      );
      expect(db.links).toHaveLength(1);
    });

    it('should link team streams and public channels alike', async () => {
      zulip.getSubscriptions.mockResolvedValue([{ streamId: Constants.Zulip.TeamStreams.ImmichGeneral }]);
      zulip.getStream.mockResolvedValue({ streamId: 107, name: 'immich-general', inviteOnly: true });

      await linkVia(Constants.Discord.Channels.DevFocusTopic, Constants.Zulip.TeamStreams.ImmichGeneral);

      expect(db.links).toHaveLength(1);
    });

    it('should report what did not work in the reply, keeping the link', async () => {
      discord.getMirrorChannel.mockResolvedValue(channel({ missingPermissions: ['EmbedLinks', 'AttachFiles'] }));
      mirror.enable.mockResolvedValue(false);
      zulip.sendMessage.mockRejectedValue(new Error('Zulip is down'));
      discord.sendMirrorNotice.mockResolvedValue({ messageId: '300000000000000001', pinned: false });

      const reply = await linkVia(CHANNEL, STREAM);

      expect(reply.details).toEqual([
        'Who can read it: the Discord channel is visible to @​everyone; the Zulip stream is private.',
        '⚠ The bot is missing EmbedLinks, AttachFiles in the Discord channel; some messages, files or threads are not mirrored until it has them.',
        '⚠ The link is saved, but the mirror has not started it yet; it tries again at its next check of the channel, within ten minutes, and the log says why.',
        '⚠ Could not post the announcement in the Zulip stream: Zulip is down.',
        '⚠ Could not pin the announcement on Discord: the bot may not pin messages there.',
      ]);
      expect(db.links[0].discordAnnouncementId).toBeNull();
    });

    it('should report an announcement Discord refused', async () => {
      discord.sendMirrorNotice.mockRejectedValue(new DiscordMirrorError('forbidden', 50_013));

      const reply = await linkVia(CHANNEL, STREAM);

      expect(reply.details.at(-1)).toBe('⚠ Could not post the announcement in the Discord channel: forbidden (50013).');
    });
  });

  describe('unlink', () => {
    beforeEach(async () => {
      await linkVia(CHANNEL, STREAM);
      zulip.sendMessage.mockClear();
      discord.sendMirrorNotice.mockClear();
    });

    it('should unlink by channel, turn the pair off at once, announce it on both sides and unpin the link notice', async () => {
      const reply = await sut.unlink({ discordChannelId: CHANNEL, actor: BEA });

      expect(db.links).toEqual([]);
      expect(mirror.disable).toHaveBeenCalledExactlyOnceWith(CHANNEL);
      expect(zulipPosts()).toEqual([
        {
          stream: STREAM,
          topic: '',
          content: `✂️ This stream is no longer mirrored with the Discord channel **#dev** (${CHANNEL}), unlinked by Bea on Zulip. Nothing posted here is copied to Discord any more, and nothing posted there is copied here.`,
        },
      ]);
      expect(discordPosts()).toEqual([
        [
          CHANNEL,
          {
            title: 'No longer mirrored with Zulip',
            content: `✂️ This channel is no longer mirrored with the Zulip stream **#immich-dev** (${STREAM}), unlinked by Bea on Zulip. Nothing posted here is copied to Zulip any more, and nothing posted there is copied here.`,
          },
          false,
        ],
      ]);
      expect(discord.unpinMirrorNotice).toHaveBeenCalledExactlyOnceWith(CHANNEL, '300000000000000001');
      expect(reply).toEqual({
        summary: `Unlinked Discord channel **#dev** (${CHANNEL}) from Zulip stream **#immich-dev** (${STREAM}): nothing is copied between them any more. What was mirrored stays on both sides, and linking the two again carries on the same conversations.`,
        details: [],
        zulipAnnouncement: { streamId: STREAM, topic: '' },
      });
    });

    it('should unlink by stream', async () => {
      await sut.unlink({ zulipStreamId: STREAM, actor: BEA });

      expect(mirror.disable).toHaveBeenCalledExactlyOnceWith(CHANNEL);
    });

    it('should say when there is nothing to unlink', async () => {
      await expect(sut.unlink({ discordChannelId: FORUM, actor: ALEX })).resolves.toEqual({
        summary: `Discord channel ${FORUM} is not mirrored with any Zulip stream.`,
        details: [],
      });
      await expect(sut.unlink({ zulipStreamId: FORUM_STREAM, actor: BEA })).resolves.toEqual({
        summary: `Zulip stream ${FORUM_STREAM} is not mirrored with any Discord channel.`,
        details: [],
      });
      expect(mirror.disable).not.toHaveBeenCalled();
    });

    it('should unlink a deleted channel by its ID, and report what could not be done there', async () => {
      discord.getMirrorChannel.mockResolvedValue(undefined);
      discord.sendMirrorNotice.mockRejectedValue(new DiscordMirrorError('unknown-channel', 10_003));
      discord.unpinMirrorNotice.mockRejectedValue(new DiscordMirrorError('unknown-channel', 10_003));

      const reply = await sut.unlink({ zulipStreamId: STREAM, actor: BEA });

      expect(reply.summary).toMatch(new RegExp(`^Unlinked Discord channel ${CHANNEL} from Zulip`));
      expect(zulipPosts()[0].content).toContain(`with the Discord channel ${CHANNEL}, unlinked by Bea on Zulip`);
      expect(reply.details).toEqual([
        '⚠ Could not post the announcement in the Discord channel: unknown-channel (10003).',
        '⚠ Could not unpin the link announcement on Discord: unknown-channel (10003).',
      ]);
    });
  });

  describe('list', () => {
    it('should list every link with both names, IDs, kind, main topic and state, and every linked account', async () => {
      await linkVia(CHANNEL, STREAM);
      await linkVia(FORUM, FORUM_STREAM);
      db.identities.push(
        { zulipUserId: 12, discordUserId: '400000000000000012', createdAt: new Date() },
        { zulipUserId: 13, discordUserId: '400000000000000013', createdAt: new Date() },
      );
      mirror.handlesChannel.mockImplementation((id) => id === CHANNEL);
      discord.getTeamMember.mockImplementation(async (_, userId) =>
        userId === '400000000000000012'
          ? { displayName: 'Alex', avatarUrl: '', roleIds: [Constants.Discord.Roles.Immich] }
          : undefined,
      );
      zulip.getUser.mockImplementation(async (userId) => {
        if (userId === 13) {
          throw new Error('no such user');
        }
        return { userId, fullName: 'Alex Tran', role: 400 };
      });
      const today = new Date().toISOString().slice(0, 10);

      expect(await sut.list('zulip')).toBe(
        [
          'Mirrored channels:',
          `- Discord channel **#dev** (${CHANNEL}) ↔ Zulip stream **#immich-dev** (${STREAM}): text channel, main topic general chat; linked by Bea on Zulip (user 20) and Alex on Discord (user 400000000000000012) on ${today}`,
          `- Discord channel **#dev-focus-topic** (${FORUM}) ↔ Zulip stream **#immich-dev-focus-topic** (${FORUM_STREAM}) (off: see the log): forum, one topic per post; linked by Bea on Zulip (user 20) and Alex on Discord (user 400000000000000012) on ${today}`,
          'Linked accounts, whose Zulip messages appear on Discord under their Discord name:',
          '- Alex Tran (Zulip user 12) ↔ Alex (Discord user 400000000000000012)',
          '- (Zulip user 13) ↔ (Discord user 400000000000000013) (not used: not a member with the Team or Immich role)',
        ].join('\n'),
      );
    });

    it('should say when nothing is mirrored or linked', async () => {
      expect(await sut.list('discord')).toBe('No channel is mirrored.\nNo accounts are linked.');
    });
  });

  describe('identities', () => {
    const DISCORD_USER = { id: '400000000000000012', name: 'Alex' };
    const ZULIP_USER = { id: 12, fullName: 'Alex Tran' };
    const codeOf = (reply: string) => /`([A-Z2-9]{8})`/.exec(reply)![1];

    it('should link the Zulip account that presents the code with the Discord account that asked for it', async () => {
      const request = await sut.requestIdentityCode(DISCORD_USER);
      const code = codeOf(request);

      expect(request).toBe(
        [
          `Your code is \`${code}\`. Within 10 minutes, send it to Immich Bot in a direct message on Zulip, as \`link ${code}\`: the Zulip account that sends it is linked with your Discord account. The code works once.`,
          'Your Zulip messages then appear on Discord under your Discord name and avatar, as long as you hold the Team or Immich role.',
        ].join('\n'),
      );
      expect(await sut.redeemIdentityCode(ZULIP_USER, ` ${code.toLowerCase().slice(0, 4)}-${code.slice(4)} `)).toBe(
        'Linked your Zulip account with the Discord account Alex (user 400000000000000012). Your Zulip messages now appear on Discord under that name and avatar, as long as it holds the Team or Immich role.',
      );
      expect(db.identities).toEqual([expect.objectContaining({ zulipUserId: 12, discordUserId: DISCORD_USER.id })]);
      expect(mirror.refreshIdentities).toHaveBeenCalledOnce();
    });

    it('should take a code once only', async () => {
      const code = codeOf(await sut.requestIdentityCode(DISCORD_USER));
      await sut.redeemIdentityCode(ZULIP_USER, code);

      expect(await sut.redeemIdentityCode({ id: 13, fullName: 'Mallory' }, code)).toBe(
        'That code is not valid, or it has expired. Run `/zulip-link` on Discord for a new one.',
      );
      expect(db.identities).toHaveLength(1);
    });

    it('should refuse a wrong code', async () => {
      await sut.requestIdentityCode(DISCORD_USER);

      expect(await sut.redeemIdentityCode(ZULIP_USER, 'AAAAAAAA')).toMatch(/^That code is not valid/);
      expect(db.repository.setMirrorIdentity).not.toHaveBeenCalled();
      expect(mirror.refreshIdentities).not.toHaveBeenCalled();
    });

    it('should refuse a code after ten minutes', async () => {
      vitest.useFakeTimers();
      const code = codeOf(await sut.requestIdentityCode(DISCORD_USER));

      vitest.advanceTimersByTime(10 * 60 * 1000);

      expect(await sut.redeemIdentityCode(ZULIP_USER, code)).toMatch(/^That code is not valid, or it has expired/);
      expect(db.identities).toEqual([]);
    });

    it("should void a user's older code when they ask for a new one", async () => {
      const first = codeOf(await sut.requestIdentityCode(DISCORD_USER));
      const second = codeOf(await sut.requestIdentityCode(DISCORD_USER));

      expect(await sut.redeemIdentityCode(ZULIP_USER, first)).toMatch(/^That code is not valid/);
      expect(await sut.redeemIdentityCode(ZULIP_USER, second)).toMatch(/^Linked your Zulip account/);
    });

    it('should say what a new link replaces', async () => {
      db.identities.push({ zulipUserId: 99, discordUserId: DISCORD_USER.id, createdAt: new Date() });
      const request = await sut.requestIdentityCode(DISCORD_USER);

      expect(request).toContain('You are linked with Zulip user 99 now; the new link replaces that one.');
      expect(await sut.redeemIdentityCode(ZULIP_USER, codeOf(request))).toContain(
        'It replaces the link of Zulip user 99 with Discord user 400000000000000012.',
      );
    });

    it("should unlink the caller's own account from either side", async () => {
      db.identities.push(
        { zulipUserId: 12, discordUserId: '400000000000000012', createdAt: new Date() },
        { zulipUserId: 13, discordUserId: '400000000000000013', createdAt: new Date() },
      );

      expect(await sut.unlinkIdentity({ zulipUserId: 12 }, 'zulip')).toBe(
        'Unlinked Zulip user 12 from Discord user 400000000000000012: those Zulip messages appear on Discord as "Name (Zulip)" again.',
      );
      expect(await sut.unlinkIdentity({ discordUserId: '400000000000000013' }, 'discord')).toMatch(
        /^Unlinked Zulip user 13 from Discord user 400000000000000013/,
      );
      expect(await sut.unlinkIdentity({ discordUserId: '400000000000000013' }, 'discord')).toBe(
        'Your Discord account is not linked.',
      );
      expect(db.identities).toEqual([]);
      expect(mirror.refreshIdentities).toHaveBeenCalledTimes(2);
    });
  });
});
