import { Kysely, sql } from 'kysely';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { Database } from 'src/schema';
import * as expanders from 'src/schema/migrations/1790263846796-ZulipExpanders';
import * as groups from 'src/schema/migrations/1790852102345-ZulipExpanderGroups';
import * as emotePadded from 'src/schema/migrations/1791227811814-ZulipEmotePadded';
import * as recheckEmotes from 'src/schema/migrations/1791240072190-RecheckZulipEmotes';
import * as dmExpanders from 'src/schema/migrations/1791302531964-ZulipDmExpanders';
import { afterAll, beforeEach, describe, expect, it, vitest } from 'vitest';

const uri = process.env.TEST_DB_URL;

vitest.mock('src/config', () => ({ getConfig: () => ({ database: { uri: process.env.TEST_DB_URL } }) }));

const CHANNEL = '100000000000000001';
const OTHER_CHANNEL = '100000000000000002';

// Needs a database migrated to the latest schema; its mirror_link, mirror_identity, pull_request, pull_request_expansion, zulip_expander*, zulip_dm_expander* and zulip_emote rows are deleted.
describe.skipIf(!uri)(DatabaseRepository.name, () => {
  const sut = new DatabaseRepository();
  const db = (sut as unknown as { db: Kysely<Database> }).db;

  beforeEach(async () => {
    await db.deleteFrom('mirror_link').execute();
    await db.deleteFrom('mirror_identity').execute();
    await db.deleteFrom('pull_request').execute();
    await db.deleteFrom('pull_request_expansion').execute();
    await db.deleteFrom('zulip_emote').execute();
    await db.deleteFrom('zulip_expander_default').execute();
    await db.deleteFrom('zulip_expander').execute();
    await db.deleteFrom('zulip_dm_expander_default').execute();
    await db.deleteFrom('zulip_dm_expander').execute();
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
          await dmExpanders.down(trx);
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
          await dmExpanders.down(trx);
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

    describe('in direct message conversations', () => {
      const DM = '7,12';
      const OTHER_DM = '7,12,13';
      const conversations = (rows: { conversation: string }[]) => rows.map(({ conversation }) => conversation);

      it('should turn a group on in a conversation once, and list by conversation then by when it was turned on', async () => {
        await group('immich');
        await group('fhs', ['futo-org/fhs-core']);

        expect(await sut.addZulipDmExpander(OTHER_DM, 'fhs', 'Alice')).toBe(true);
        expect(await sut.addZulipDmExpander(DM, 'immich', 'Alice')).toBe(true);
        expect(await sut.addZulipDmExpander(DM, 'immich', 'Bob')).toBe(false);
        expect(await sut.addZulipDmExpander(DM, 'fhs', 'Alice')).toBe(true);

        expect(
          (await sut.getZulipDmExpanders()).map(({ conversation, groupName }) => `${conversation}:${groupName}`),
        ).toEqual([`${DM}:immich`, `${DM}:fhs`, `${OTHER_DM}:fhs`]);
        expect(await sut.getZulipExpanders()).toEqual([]);
      });

      it('should turn off one group or every group of a conversation, and drop its default with its last group', async () => {
        await group('immich');
        await group('fhs', ['futo-org/fhs-core']);
        await sut.addZulipDmExpander(DM, 'immich', 'Alice');
        await sut.addZulipDmExpander(DM, 'fhs', 'Alice');
        await sut.setZulipDmExpanderDefault(DM, 'futo-org/fhs-core', 'Alice');
        await sut.setZulipDmExpanderDefault(DM, 'immich-app/immich', 'Bob');

        expect(await sut.getZulipDmExpanderDefaults()).toEqual([
          { conversation: DM, repository: 'immich-app/immich', createdBy: 'Bob', createdAt: expect.any(Date) },
        ]);
        expect(await sut.removeZulipDmExpander(DM, 'fhs')).toEqual(['fhs']);
        expect(conversations(await sut.getZulipDmExpanderDefaults())).toEqual([DM]);

        expect(await sut.removeZulipDmExpander(DM)).toEqual(['immich']);
        expect(await sut.getZulipDmExpanders()).toEqual([]);
        expect(await sut.getZulipDmExpanderDefaults()).toEqual([]);
      });

      it('should turn a deleted group off in conversations and drop the defaults of those left with none', async () => {
        await group('immich');
        await group('fhs', ['futo-org/fhs-core']);
        await sut.addZulipDmExpander(DM, 'fhs', 'Alice');
        await sut.addZulipDmExpander(OTHER_DM, 'fhs', 'Alice');
        await sut.addZulipDmExpander(OTHER_DM, 'immich', 'Alice');
        await sut.setZulipDmExpanderDefault(DM, 'futo-org/fhs-core', 'Alice');
        await sut.setZulipDmExpanderDefault(OTHER_DM, 'immich-app/immich', 'Alice');

        expect(await sut.removeZulipExpanderGroup('fhs')).toBe(true);

        expect(await sut.getZulipDmExpanders()).toMatchObject([{ conversation: OTHER_DM, groupName: 'immich' }]);
        expect(conversations(await sut.getZulipDmExpanderDefaults())).toEqual([OTHER_DM]);
      });

      it('should refuse turning on a group that does not exist', async () => {
        await expect(sut.addZulipDmExpander(DM, 'nope', 'Alice')).rejects.toThrow('zulip_dm_expander_groupName_fkey');
      });
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

  describe('pull requests', () => {
    it('should find the pull request of a number updated last in the organization alone', async () => {
      const pullRequest = (nodeId: string, organization: string, repository: string, updatedAt: string) =>
        sut.upsertPullRequest({ nodeId, organization, repository, number: 4242, updatedAt: new Date(updatedAt) });
      await pullRequest('PR_immich_older', 'immich-app', 'immich', '2026-10-01');
      await pullRequest('PR_immich_newer', 'immich-app', 'static-pages', '2026-10-03');
      await pullRequest('PR_futo', 'futo-org', 'grayjay', '2026-10-05');

      expect(await sut.getLatestPullRequestByNumber(4242, 'immich-app')).toMatchObject({ nodeId: 'PR_immich_newer' });
      expect(await sut.getLatestPullRequestByNumber(4242, 'futo-org')).toMatchObject({ nodeId: 'PR_futo' });
      expect(await sut.getLatestPullRequestByNumber(4242, 'someone-else')).toBeUndefined();
    });
  });

  describe('pull request expansions', () => {
    const PULL_REQUEST = { organization: 'immich-app', repository: 'immich', number: 4242 };
    const expansion = (service: 'discord' | 'zulip', messageId: string, pullRequest = PULL_REQUEST) => ({
      service,
      messageId,
      channelId: service === 'discord' ? CHANNEL : null,
      ...pullRequest,
    });
    const setCreatedAt = (messageId: string, createdAt: string) =>
      db
        .updateTable('pull_request_expansion')
        .set({ createdAt: new Date(createdAt) })
        .where('messageId', '=', messageId)
        .execute();

    it('should list the expansions of the pull request created before the moment, oldest first, with how many pull requests each reply names', async () => {
      await sut.createPullRequestExpansions([
        expansion('zulip', '901'),
        expansion('zulip', '901', { ...PULL_REQUEST, number: 4243 }),
        expansion('zulip', '901', { ...PULL_REQUEST, repository: 'static-pages' }),
      ]);
      await sut.createPullRequestExpansions([expansion('discord', '300000000000000001')]);
      await sut.createPullRequestExpansions([expansion('zulip', '902', { ...PULL_REQUEST, organization: 'futo-org' })]);
      await sut.createPullRequestExpansions([expansion('zulip', '903')]);
      await setCreatedAt('901', '2026-10-02T00:00:00Z');
      await setCreatedAt('300000000000000001', '2026-10-01T00:00:00Z');
      await setCreatedAt('902', '2026-10-01T00:00:00Z');
      await setCreatedAt('903', '2026-10-04T00:00:00Z');

      expect(await sut.getPullRequestExpansions(PULL_REQUEST, new Date('2026-10-03T00:00:00Z'))).toEqual([
        {
          ...expansion('discord', '300000000000000001'),
          createdAt: new Date('2026-10-01T00:00:00Z'),
          pullRequestCount: 1,
        },
        { ...expansion('zulip', '901'), createdAt: new Date('2026-10-02T00:00:00Z'), pullRequestCount: 3 },
      ]);
    });

    it('should count the pull requests of a reply on its own service alone', async () => {
      await sut.createPullRequestExpansions([expansion('zulip', '901')]);
      await sut.createPullRequestExpansions([expansion('discord', '901', { ...PULL_REQUEST, number: 4243 })]);

      expect(await sut.getPullRequestExpansions(PULL_REQUEST, new Date(Date.now() + 60_000))).toEqual([
        expect.objectContaining({ service: 'zulip', messageId: '901', pullRequestCount: 1 }),
      ]);
    });

    it('should remove only the expansions created before the cutoff', async () => {
      await sut.createPullRequestExpansions([expansion('zulip', '901'), expansion('zulip', '902')]);
      await setCreatedAt('901', '2026-09-01T00:00:00Z');
      await setCreatedAt('902', '2026-10-01T00:00:00Z');

      await sut.removePullRequestExpansions(new Date('2026-09-15T00:00:00Z'));

      expect(await sut.getPullRequestExpansions(PULL_REQUEST, new Date('2026-10-02T00:00:00Z'))).toEqual([
        expect.objectContaining({ messageId: '902' }),
      ]);
    });
  });

  describe('zulip emotes', () => {
    it('should mark the emotes recorded before emotes were padded, so the next sync pads them', async () => {
      await sut.addZulipEmote('1', 'peepowidehappy');
      const rolledBack = new Error('rolled back');

      await expect(
        db.transaction().execute(async (trx) => {
          await emotePadded.down(trx);
          await emotePadded.up(trx);
          await trx.insertInto('zulip_emote').values({ discordEmoteId: '2', zulipName: 'catjam' }).execute();
          expect(
            await trx
              .selectFrom('zulip_emote')
              .select(['discordEmoteId', 'padded'])
              .orderBy('discordEmoteId')
              .execute(),
          ).toEqual([
            { discordEmoteId: '1', padded: false },
            { discordEmoteId: '2', padded: true },
          ]);
          throw rolledBack;
        }),
      ).rejects.toBe(rolledBack);
    });

    it('should mark every recorded emote unpadded, and keep it so on rollback, so the next sync looks at each again', async () => {
      await sut.addZulipEmote('1', 'widepeepohappy');
      await sut.addZulipEmote('2', 'catjam');
      const rolledBack = new Error('rolled back');

      await expect(
        db.transaction().execute(async (trx) => {
          await recheckEmotes.up(trx);
          expect(await trx.selectFrom('zulip_emote').select('padded').execute()).toEqual([
            { padded: false },
            { padded: false },
          ]);
          await recheckEmotes.down(trx);
          expect(await trx.selectFrom('zulip_emote').select('padded').execute()).toEqual([
            { padded: false },
            { padded: false },
          ]);
          throw rolledBack;
        }),
      ).rejects.toBe(rolledBack);
    });

    it('should record an emote once, under the name it was last recorded with, and list the records', async () => {
      await sut.addZulipEmote('1', 'peepowidehappy');
      await sut.addZulipEmote('1', 'renamed');
      await sut.addZulipEmote('2', 'catjam');

      const records = await sut.getZulipEmotes();
      expect(records.toSorted((a, b) => a.discordEmoteId.localeCompare(b.discordEmoteId))).toEqual([
        { discordEmoteId: '1', zulipName: 'renamed', padded: true, createdAt: expect.any(Date) },
        { discordEmoteId: '2', zulipName: 'catjam', padded: true, createdAt: expect.any(Date) },
      ]);
    });

    it('should mark an emote recorded before emotes were padded as padded when it is recorded again', async () => {
      await sut.addZulipEmote('1', 'peepowidehappy');
      await db.updateTable('zulip_emote').set({ padded: false }).execute();

      await sut.addZulipEmote('1', 'peepowidehappy');

      expect(await sut.getZulipEmotes()).toEqual([
        { discordEmoteId: '1', zulipName: 'peepowidehappy', padded: true, createdAt: expect.any(Date) },
      ]);
    });
  });
});
