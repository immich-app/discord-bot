import { Kysely, sql } from 'kysely';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { Database } from 'src/schema';
import * as expanders from 'src/schema/migrations/1790263846796-ZulipExpanders';
import * as groups from 'src/schema/migrations/1790852102345-ZulipExpanderGroups';
import { afterAll, beforeEach, describe, expect, it, vitest } from 'vitest';

const uri = process.env.TEST_DB_URL;

vitest.mock('src/config', () => ({ getConfig: () => ({ database: { uri: process.env.TEST_DB_URL } }) }));

const CHANNEL = '100000000000000001';
const OTHER_CHANNEL = '100000000000000002';

// Needs a database migrated to the latest schema; its mirror_link, mirror_identity, zulip_expander* and zulip_emote rows are deleted.
describe.skipIf(!uri)(DatabaseRepository.name, () => {
  const sut = new DatabaseRepository();
  const db = (sut as unknown as { db: Kysely<Database> }).db;

  beforeEach(async () => {
    await db.deleteFrom('mirror_link').execute();
    await db.deleteFrom('mirror_identity').execute();
    await db.deleteFrom('zulip_emote').execute();
    await db.deleteFrom('zulip_expander_default').execute();
    await db.deleteFrom('zulip_expander').execute();
    await db.deleteFrom('zulip_expander_group').execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  describe('mirror links', () => {
    it('should create, list and remove a link', async () => {
      const created = await sut.createMirrorLink({
        discordChannelId: CHANNEL,
        zulipStreamId: 120,
        kind: 'text',
        mainTopic: '#dev',
        createdBy: 'Alex (Discord user 1)',
      });

      expect(created).toMatchObject({ discordChannelId: CHANNEL, discordAnnouncementId: null });
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(await sut.getMirrorLinks()).toEqual([created]);

      await sut.setMirrorLinkAnnouncement(CHANNEL, '900000000000000001');
      const removed = await sut.removeMirrorLink(CHANNEL);
      expect(removed).toEqual({ ...created, discordAnnouncementId: '900000000000000001' });
      expect(await sut.removeMirrorLink(CHANNEL)).toBeUndefined();
      expect(await sut.getMirrorLinks()).toEqual([]);
    });

    it('should refuse a second link of the same channel or stream', async () => {
      const link = { zulipStreamId: 120, kind: 'forum' as const, mainTopic: null, createdBy: 'Alex' };
      await sut.createMirrorLink({ ...link, discordChannelId: CHANNEL });

      await expect(sut.createMirrorLink({ ...link, discordChannelId: OTHER_CHANNEL })).rejects.toThrow(
        'mirror_link_zulipStreamId_uq',
      );
      await expect(sut.createMirrorLink({ ...link, discordChannelId: CHANNEL, zulipStreamId: 121 })).rejects.toThrow(
        'mirror_link_pkey',
      );
    });
  });

  describe('mirror identities', () => {
    it('should replace what either user had linked before', async () => {
      expect(await sut.setMirrorIdentity(12, '400000000000000012')).toEqual([]);
      await sut.setMirrorIdentity(13, '400000000000000013');

      const replaced = await sut.setMirrorIdentity(12, '400000000000000013');

      expect(replaced.map(({ zulipUserId }) => zulipUserId).sort()).toEqual([12, 13]);
      expect(await sut.getMirrorIdentities()).toEqual([
        expect.objectContaining({ zulipUserId: 12, discordUserId: '400000000000000013' }),
      ]);
    });

    it('should remove an identity by either side', async () => {
      await sut.setMirrorIdentity(12, '400000000000000012');
      await sut.setMirrorIdentity(13, '400000000000000013');

      expect(await sut.removeMirrorIdentity({ zulipUserId: 12 })).toMatchObject({
        discordUserId: '400000000000000012',
      });
      expect(await sut.removeMirrorIdentity({ discordUserId: '400000000000000013' })).toMatchObject({
        zulipUserId: 13,
      });
      expect(await sut.removeMirrorIdentity({ zulipUserId: 12 })).toBeUndefined();
      expect(await sut.getMirrorIdentities()).toEqual([]);
    });
  });

  describe('zulip expanders', () => {
    const streams = (rows: { streamId: number }[]) => rows.map(({ streamId }) => streamId);
    const group = (name: string, repositories = ['immich-app/immich']) =>
      sut.createZulipExpanderGroup({ name, repositories, createdBy: 'Alice' });

    it('should seed GitHub expansion of immich-app/immich in the Immich stream and every immich team stream', async () => {
      const rolledBack = new Error('rolled back');
      await expect(
        db.transaction().execute(async (trx) => {
          await groups.down(trx);
          await expanders.down(trx);
          await expanders.up(trx);
          await groups.up(trx);
          const rows = await trx.selectFrom('zulip_expander').selectAll().orderBy('streamId').execute();
          expect(streams(rows)).toEqual([54, 107, 108, 109, 110, 111, 112, 113]);
          expect(new Set(rows.map(({ groupName }) => groupName))).toEqual(new Set(['immich']));
          expect(
            await trx.selectFrom('zulip_expander_group').select(['name', 'repositories', 'threshold']).execute(),
          ).toEqual([{ name: 'immich', repositories: ['immich-app/immich'], threshold: 1000 }]);
          throw rolledBack;
        }),
      ).rejects.toBe(rolledBack);
    });

    it('should keep one group per stream when the group migration is reverted', async () => {
      const rolledBack = new Error('rolled back');
      await expect(
        db.transaction().execute(async (trx) => {
          await group('immich');
          await group('fhs', ['futo-org/fhs-core']);
          await trx
            .insertInto('zulip_expander')
            .values([
              { streamId: 54, groupName: 'immich', createdBy: 'Alice', createdAt: new Date(1000) },
              { streamId: 54, groupName: 'fhs', createdBy: 'Alice', createdAt: new Date(2000) },
            ])
            .execute();
          await groups.down(trx);
          expect(await sql`SELECT "streamId" FROM "zulip_expander"`.execute(trx)).toMatchObject({
            rows: [{ streamId: 54 }],
          });
          throw rolledBack;
        }),
      ).rejects.toBe(rolledBack);
    });

    it('should create a group once and list the groups by name', async () => {
      expect(await group('immich')).toBe(true);
      expect(await group('immich', ['futo-org/fhs-core'])).toBe(false);
      expect(await group('fhs', ['futo-org/fhs-core', 'futo-org/grayjay'])).toBe(true);

      expect(await sut.getZulipExpanderGroups()).toEqual([
        {
          name: 'fhs',
          repositories: ['futo-org/fhs-core', 'futo-org/grayjay'],
          threshold: 0,
          createdBy: 'Alice',
          createdAt: expect.any(Date),
        },
        {
          name: 'immich',
          repositories: ['immich-app/immich'],
          threshold: 0,
          createdBy: 'Alice',
          createdAt: expect.any(Date),
        },
      ]);
    });

    it('should update a group, and resolve to whether there was one', async () => {
      await group('fhs', ['futo-org/fhs-core']);

      expect(await sut.updateZulipExpanderGroup('fhs', { repositories: ['futo-org/grayjay'], threshold: 10 })).toBe(
        true,
      );
      expect(await sut.updateZulipExpanderGroup('nope', { threshold: 10 })).toBe(false);
      expect(await sut.getZulipExpanderGroups()).toMatchObject([
        { name: 'fhs', repositories: ['futo-org/grayjay'], threshold: 10 },
      ]);
    });

    it('should turn a group on in a stream once, and list by stream then by when it was turned on', async () => {
      await group('immich');
      await group('fhs', ['futo-org/fhs-core']);

      expect(await sut.addZulipExpander(120, 'immich', 'Alice on Zulip (user 12)')).toBe(true);
      expect(await sut.addZulipExpander(120, 'immich', 'Bob on Zulip (user 13)')).toBe(false);
      expect(await sut.addZulipExpander(120, 'fhs', 'Bob on Zulip (user 13)')).toBe(true);
      expect(await sut.addZulipExpander(54, 'fhs', 'Bob on Zulip (user 13)')).toBe(true);

      expect(await sut.getZulipExpanders()).toEqual([
        { streamId: 54, groupName: 'fhs', createdBy: 'Bob on Zulip (user 13)', createdAt: expect.any(Date) },
        { streamId: 120, groupName: 'immich', createdBy: 'Alice on Zulip (user 12)', createdAt: expect.any(Date) },
        { streamId: 120, groupName: 'fhs', createdBy: 'Bob on Zulip (user 13)', createdAt: expect.any(Date) },
      ]);
    });

    it('should refuse turning on a group that does not exist', async () => {
      await expect(sut.addZulipExpander(120, 'nope', 'Alice')).rejects.toThrow('zulip_expander_groupName_fkey');
    });

    it('should turn off one group or every group of a stream, and drop its default with its last group', async () => {
      await group('immich');
      await group('fhs', ['futo-org/fhs-core']);
      await sut.addZulipExpander(120, 'immich', 'Alice');
      await sut.addZulipExpander(120, 'fhs', 'Alice');
      await sut.addZulipExpander(121, 'immich', 'Alice');
      await sut.setZulipExpanderDefault(120, 'futo-org/fhs-core', 'Alice');
      await sut.setZulipExpanderDefault(121, 'immich-app/immich', 'Alice');

      expect(await sut.removeZulipExpander(120, 'fhs')).toEqual(['fhs']);
      expect(await sut.removeZulipExpander(120, 'fhs')).toEqual([]);
      expect(streams(await sut.getZulipExpanderDefaults())).toEqual([120, 121]);

      expect(await sut.removeZulipExpander(121)).toEqual(['immich']);
      expect(streams(await sut.getZulipExpanders())).toEqual([120]);
      expect(streams(await sut.getZulipExpanderDefaults())).toEqual([120]);
    });

    it('should set a default once per stream, replacing the one before', async () => {
      await sut.setZulipExpanderDefault(120, 'immich-app/immich', 'Alice');
      await sut.setZulipExpanderDefault(120, 'futo-org/fhs-core', 'Bob');

      expect(await sut.getZulipExpanderDefaults()).toEqual([
        { streamId: 120, repository: 'futo-org/fhs-core', createdBy: 'Bob', createdAt: expect.any(Date) },
      ]);
    });

    it('should delete a group, turn it off everywhere and drop the defaults of streams left with none', async () => {
      await group('immich');
      await group('fhs', ['futo-org/fhs-core']);
      await sut.addZulipExpander(120, 'fhs', 'Alice');
      await sut.addZulipExpander(121, 'fhs', 'Alice');
      await sut.addZulipExpander(121, 'immich', 'Alice');
      await sut.setZulipExpanderDefault(120, 'futo-org/fhs-core', 'Alice');
      await sut.setZulipExpanderDefault(121, 'immich-app/immich', 'Alice');

      expect(await sut.removeZulipExpanderGroup('fhs')).toBe(true);
      expect(await sut.removeZulipExpanderGroup('fhs')).toBe(false);

      expect(await sut.getZulipExpanders()).toMatchObject([{ streamId: 121, groupName: 'immich' }]);
      expect(streams(await sut.getZulipExpanderDefaults())).toEqual([121]);
    });
  });

  it('should list the recent rows of a channel and its threads, newest first, without deleted ones', async () => {
    const row = (discordMessageId: string, overrides: Record<string, unknown> = {}) => ({
      discordMessageId,
      conversationId: null,
      origin: 'discord' as const,
      discordChannelId: CHANNEL,
      discordThreadId: null,
      discordWebhookId: null,
      discordAuthorId: null,
      zulipMessageId: Number(discordMessageId.slice(-4)),
      zulipStreamId: 120,
      zulipSenderId: null,
      sourceHash: 'hash',
      zulipHeader: null,
      zulipAttachments: null,
      ...overrides,
    });
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);
    await sut.createMirrorMessages([
      row('900000000000000001', { createdAt: hoursAgo(30) }),
      row('900000000000000002', { createdAt: hoursAgo(3) }),
      row('900000000000000003', { createdAt: hoursAgo(2), discordThreadId: '200000000000000001' }),
      row('900000000000000004', { createdAt: hoursAgo(1) }),
      row('900000000000000005', { createdAt: hoursAgo(1), discordChannelId: OTHER_CHANNEL }),
    ]);
    await sut.markMirrorMessagesDeleted(['900000000000000004']);

    try {
      const recent = await sut.getRecentMirrorMessages(CHANNEL, hoursAgo(24), 10);
      expect(recent.map(({ discordMessageId }) => discordMessageId)).toEqual([
        '900000000000000003',
        '900000000000000002',
      ]);
      expect(await sut.getRecentMirrorMessages(CHANNEL, hoursAgo(24), 1)).toHaveLength(1);
    } finally {
      await sql`DELETE FROM "mirror_message" WHERE "discordMessageId" LIKE '9000000000000000%'`.execute(db);
    }
  });

  it('should keep the conversations of a channel when its link is removed', async () => {
    await sut.createMirrorLink({
      discordChannelId: CHANNEL,
      zulipStreamId: 120,
      kind: 'text',
      mainTopic: '#dev',
      createdBy: 'Alex',
    });
    const conversation = await sut.createMirrorConversation({
      discordChannelId: CHANNEL,
      discordThreadId: null,
      zulipStreamId: 120,
      zulipTopic: '#dev',
      zulipTopicKey: '#dev',
      zulipAnchorMessageId: null,
    });

    await sut.removeMirrorLink(CHANNEL);

    expect(await sut.getMirrorConversationByDiscord(CHANNEL, null)).toEqual(conversation);
    await sql`DELETE FROM "mirror_conversation" WHERE "id" = ${conversation.id}`.execute(db);
  });

  describe('zulip emotes', () => {
    it('should record an emote once, keeping the first row, and list the IDs', async () => {
      await sut.addZulipEmote('1', 'peepowidehappy');
      await sut.addZulipEmote('1', 'renamed');
      await sut.addZulipEmote('2', 'catjam');

      expect((await sut.getZulipEmoteIds()).sort()).toEqual(['1', '2']);
      expect(
        await db.selectFrom('zulip_emote').select(['discordEmoteId', 'zulipName']).orderBy('discordEmoteId').execute(),
      ).toEqual([
        { discordEmoteId: '1', zulipName: 'peepowidehappy' },
        { discordEmoteId: '2', zulipName: 'catjam' },
      ]);
    });
  });
});
