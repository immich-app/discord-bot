import { Kysely, sql } from 'kysely';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { Database } from 'src/schema';
import { down, up } from 'src/schema/migrations/1790261314170-ZulipExpanders';
import { afterAll, beforeEach, describe, expect, it, vitest } from 'vitest';

const uri = process.env.TEST_DB_URL;

vitest.mock('src/config', () => ({ getConfig: () => ({ database: { uri: process.env.TEST_DB_URL } }) }));

const CHANNEL = '100000000000000001';
const OTHER_CHANNEL = '100000000000000002';

// Needs a database migrated to the latest schema; its mirror_link, mirror_identity and zulip_expander rows are deleted.
describe.skipIf(!uri)(DatabaseRepository.name, () => {
  const sut = new DatabaseRepository();
  const db = (sut as unknown as { db: Kysely<Database> }).db;

  beforeEach(async () => {
    await db.deleteFrom('mirror_link').execute();
    await db.deleteFrom('mirror_identity').execute();
    await db.deleteFrom('zulip_expander').execute();
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
    const pairs = (rows: { streamId: number; expander: string }[]) =>
      rows.map(({ streamId, expander }) => `${streamId}:${expander}`);

    it('should seed both expanders in the Immich stream and every immich team stream', async () => {
      await down(db);
      await up(db);

      const rows = await sut.getZulipExpanders();
      expect(pairs(rows)).toEqual(
        [54, 107, 108, 109, 110, 111, 112, 113].flatMap((streamId) => [`${streamId}:github`, `${streamId}:twitter`]),
      );
      expect(new Set(rows.map(({ createdBy }) => createdBy))).toEqual(new Set(['migration']));
    });

    it('should add only what a stream does not have, and list by stream and expander', async () => {
      expect(pairs(await sut.addZulipExpanders(120, ['twitter'], 'Alice on Zulip (user 12)'))).toEqual(['120:twitter']);

      const added = await sut.addZulipExpanders(120, ['github', 'twitter'], 'Bob on Zulip (user 13)');

      expect(added).toEqual([
        { streamId: 120, expander: 'github', createdBy: 'Bob on Zulip (user 13)', createdAt: expect.any(Date) },
      ]);
      await sut.addZulipExpanders(54, ['github'], 'Bob on Zulip (user 13)');
      const rows = await sut.getZulipExpanders();
      expect(pairs(rows)).toEqual(['54:github', '120:github', '120:twitter']);
      expect(rows.find(({ streamId, expander }) => streamId === 120 && expander === 'twitter')?.createdBy).toBe(
        'Alice on Zulip (user 12)',
      );
    });

    it('should remove only what it names in that stream, and resolve to what it removed', async () => {
      await sut.addZulipExpanders(120, ['github', 'twitter'], 'Alice');
      await sut.addZulipExpanders(121, ['github', 'twitter'], 'Alice');

      expect(pairs(await sut.removeZulipExpanders(120, ['twitter']))).toEqual(['120:twitter']);
      expect(await sut.removeZulipExpanders(120, ['twitter'])).toEqual([]);
      expect(pairs(await sut.removeZulipExpanders(121, ['github', 'twitter'])).sort()).toEqual([
        '121:github',
        '121:twitter',
      ]);
      expect(pairs(await sut.getZulipExpanders())).toEqual(['120:github']);
    });

    it('should refuse a second row of the same stream and expander', async () => {
      await db.insertInto('zulip_expander').values({ streamId: 120, expander: 'github', createdBy: 'Alice' }).execute();

      await expect(
        db.insertInto('zulip_expander').values({ streamId: 120, expander: 'github', createdBy: 'Bob' }).execute(),
      ).rejects.toThrow('zulip_expander_pkey');
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
});
