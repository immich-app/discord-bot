import { Kysely, sql } from 'kysely';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { Database } from 'src/schema';
import { afterAll, beforeEach, describe, expect, it, vitest } from 'vitest';

const uri = process.env.TEST_DB_URL;

vitest.mock('src/config', () => ({ getConfig: () => ({ database: { uri: process.env.TEST_DB_URL } }) }));

const CHANNEL = '100000000000000001';
const OTHER_CHANNEL = '100000000000000002';

// Needs a database migrated to the latest schema; its mirror_link and mirror_identity rows are deleted.
describe.skipIf(!uri)(DatabaseRepository.name, () => {
  const sut = new DatabaseRepository();
  const db = (sut as unknown as { db: Kysely<Database> }).db;

  beforeEach(async () => {
    await db.deleteFrom('mirror_link').execute();
    await db.deleteFrom('mirror_identity').execute();
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
