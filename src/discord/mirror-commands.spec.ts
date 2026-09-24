import { Logger } from '@nestjs/common';
import { ChannelType, CommandInteraction, MessageFlags, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { MetadataStorage } from 'discordx';
import { DiscordMirrorCommands } from 'src/discord/mirror-commands';
import { MirrorLinkService } from 'src/services/mirror-link.service';
import { afterEach, beforeEach, describe, expect, it, Mocked, vitest } from 'vitest';

const CHANNEL = '100000000000000001';
const FORUM = '100000000000000002';
const USER = '400000000000000012';
const NOT_AN_ADMIN = 'Only members with the Administrator permission can change or list the Discord-Zulip mirror.';

const interaction = ({ admin = true, channel = {} as object | null } = {}) =>
  ({
    user: { id: USER, displayName: 'alex' },
    member: null,
    memberPermissions: new PermissionsBitField(admin ? [PermissionFlagsBits.Administrator] : []),
    channelId: CHANNEL,
    channel: channel && { isThread: () => false, ...channel },
    reply: vitest.fn(),
    deferReply: vitest.fn(),
    editReply: vitest.fn(),
  }) as unknown as Mocked<CommandInteraction>;

const thread = (parentType: ChannelType) => ({
  isThread: () => true,
  parent: { id: FORUM, type: parentType },
});

describe(DiscordMirrorCommands.name, () => {
  let sut: DiscordMirrorCommands;
  let mirrorLinks: Mocked<
    Pick<MirrorLinkService, 'completeLink' | 'unlink' | 'list' | 'requestIdentityCode' | 'unlinkIdentity' | 'backfill'>
  >;

  beforeEach(() => {
    mirrorLinks = {
      completeLink: vitest.fn().mockResolvedValue({ summary: 'Linked.', details: ['Who can read it: …'] }),
      unlink: vitest.fn().mockResolvedValue({ summary: 'Unlinked.', details: [] }),
      list: vitest.fn().mockResolvedValue('No channel is mirrored.'),
      requestIdentityCode: vitest.fn().mockResolvedValue('Your code is `ABCD2345`.'),
      unlinkIdentity: vitest.fn().mockResolvedValue('Unlinked your account.'),
      backfill: vitest.fn(),
    };
    sut = new DiscordMirrorCommands(mirrorLinks as unknown as MirrorLinkService);
  });

  afterEach(() => {
    vitest.restoreAllMocks();
  });

  it('should offer the mirror commands to administrators only, and the account commands to everyone', () => {
    const commands = MetadataStorage.instance.applicationCommands.filter(
      ({ classRef }) => classRef === DiscordMirrorCommands,
    );

    expect(
      Object.fromEntries(commands.map(({ name, defaultMemberPermissions }) => [name, defaultMemberPermissions])),
    ).toEqual({
      'mirror-link': PermissionFlagsBits.Administrator,
      'mirror-unlink': PermissionFlagsBits.Administrator,
      'mirror-backfill': PermissionFlagsBits.Administrator,
      'mirror-list': PermissionFlagsBits.Administrator,
      'zulip-link': null,
      'zulip-unlink': null,
    });
  });

  it.each([
    ['mirror-link', (command: CommandInteraction) => sut.mirrorLink('K7Q2XM', command)],
    ['mirror-unlink', (command: CommandInteraction) => sut.mirrorUnlink(command)],
    ['mirror-list', (command: CommandInteraction) => sut.mirrorList(command)],
    ['mirror-backfill', (command: CommandInteraction) => sut.mirrorBackfill(command)],
  ])('should refuse %s to a member without the Administrator permission', async (_, run) => {
    const command = interaction({ admin: false });

    await run(command);

    expect(command.reply).toHaveBeenCalledExactlyOnceWith({ content: NOT_AN_ADMIN, flags: [MessageFlags.Ephemeral] });
    expect(mirrorLinks.completeLink).not.toHaveBeenCalled();
    expect(mirrorLinks.unlink).not.toHaveBeenCalled();
    expect(mirrorLinks.list).not.toHaveBeenCalled();
    expect(mirrorLinks.backfill).not.toHaveBeenCalled();
  });

  it('should link the channel it is run in, answering privately without pinging anyone', async () => {
    const command = interaction();

    await sut.mirrorLink('K7Q2XM', command);

    expect(command.deferReply).toHaveBeenCalledWith({ flags: [MessageFlags.Ephemeral] });
    expect(mirrorLinks.completeLink).toHaveBeenCalledExactlyOnceWith({
      linkId: 'K7Q2XM',
      discordChannelId: CHANNEL,
      actor: { platform: 'discord', id: USER, name: 'alex' },
    });
    expect(command.editReply).toHaveBeenCalledExactlyOnceWith({
      content: 'Linked.\nWho can read it: …',
      allowedMentions: { parse: [] },
    });
  });

  it('should link and unlink the forum when run in one of its posts', async () => {
    await sut.mirrorLink('K7Q2XM', interaction({ channel: thread(ChannelType.GuildForum) }));
    await sut.mirrorUnlink(interaction({ channel: thread(ChannelType.GuildForum) }));

    expect(mirrorLinks.completeLink.mock.calls[0][0].discordChannelId).toBe(FORUM);
    expect(mirrorLinks.unlink).toHaveBeenCalledExactlyOnceWith({
      discordChannelId: FORUM,
      actor: { platform: 'discord', id: USER, name: 'alex' },
    });
  });

  it('should refuse a thread of a text channel', async () => {
    const command = interaction({ channel: thread(ChannelType.GuildText) });

    await sut.mirrorLink('K7Q2XM', command);

    expect(command.reply).toHaveBeenCalledExactlyOnceWith({
      content: 'Run this in the channel itself, not in a thread; for a forum, run it in any of its posts.',
      flags: [MessageFlags.Ephemeral],
    });
    expect(mirrorLinks.completeLink).not.toHaveBeenCalled();
  });

  it('should list the links, cut to what Discord takes', async () => {
    mirrorLinks.list.mockResolvedValue('x'.repeat(3000));
    const command = interaction();

    await sut.mirrorList(command);

    expect(mirrorLinks.list).toHaveBeenCalledWith('discord');
    expect(command.editReply.mock.calls[0][0]).toEqual({
      content: `${'x'.repeat(1997)}...`,
      allowedMentions: { parse: [] },
    });
  });

  it('should give anyone a code for their own account, and unlink their own account, privately', async () => {
    const command = interaction({ admin: false });

    await sut.zulipLink(command);
    await sut.zulipUnlink(command);

    expect(mirrorLinks.requestIdentityCode).toHaveBeenCalledWith({ id: USER, name: 'alex' });
    expect(mirrorLinks.unlinkIdentity).toHaveBeenCalledWith({ discordUserId: USER }, 'discord');
    expect(command.reply.mock.calls).toEqual([
      [{ content: 'Your code is `ABCD2345`.', flags: [MessageFlags.Ephemeral], allowedMentions: { parse: [] } }],
      [{ content: 'Unlinked your account.', flags: [MessageFlags.Ephemeral], allowedMentions: { parse: [] } }],
    ]);
  });

  describe('mirror-backfill', () => {
    const THREAD = '200000000000000001';
    const ACK = '📜 Copying the messages of this thread that are not on Zulip yet…';
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    const started = (report: Promise<string | undefined>) =>
      mirrorLinks.backfill.mockImplementation(async (_, acknowledge) => {
        await acknowledge(ACK);
        return { done: report };
      });

    it("should backfill a text channel's own messages, acknowledge privately and add the report", async () => {
      started(Promise.resolve('Done: copied 3 messages to Zulip.'));
      const command = interaction();

      await sut.mirrorBackfill(command);
      await settle();

      expect(command.deferReply).toHaveBeenCalledWith({ flags: [MessageFlags.Ephemeral] });
      expect(mirrorLinks.backfill).toHaveBeenCalledExactlyOnceWith(
        {
          target: { discordChannelId: CHANNEL, threadId: null },
          actor: { platform: 'discord', id: USER, name: 'alex' },
        },
        expect.any(Function),
      );
      expect(command.editReply.mock.calls).toEqual([
        [{ content: ACK, allowedMentions: { parse: [] } }],
        [{ content: `${ACK}\nDone: copied 3 messages to Zulip.`, allowedMentions: { parse: [] } }],
      ]);
    });

    it.each([
      ['a thread', ChannelType.PublicThread, CHANNEL],
      ['a forum post', ChannelType.PublicThread, FORUM],
    ])('should backfill %s on its own', async (_, type, parentId) => {
      started(Promise.resolve(undefined));

      await sut.mirrorBackfill(interaction({ channel: { isThread: () => true, id: THREAD, type, parentId } }));

      expect(mirrorLinks.backfill.mock.calls[0][0].target).toEqual({ discordChannelId: parentId, threadId: THREAD });
    });

    it('should refuse a private thread', async () => {
      const command = interaction({
        channel: { isThread: () => true, id: THREAD, type: ChannelType.PrivateThread, parentId: CHANNEL },
      });

      await sut.mirrorBackfill(command);

      expect(command.reply).toHaveBeenCalledExactlyOnceWith({
        content: 'Private threads are not mirrored, so there is nothing to backfill.',
        flags: [MessageFlags.Ephemeral],
      });
      expect(mirrorLinks.backfill).not.toHaveBeenCalled();
    });

    it('should answer a refusal', async () => {
      mirrorLinks.backfill.mockResolvedValue({
        reply: 'This channel is not mirrored with Zulip, so there is nothing to backfill.',
      });
      const command = interaction();

      await sut.mirrorBackfill(command);

      expect(command.editReply).toHaveBeenCalledExactlyOnceWith({
        content: 'This channel is not mirrored with Zulip, so there is nothing to backfill.',
        allowedMentions: { parse: [] },
      });
    });

    it('should only log a report it cannot add, once the interaction has expired', async () => {
      const log = vitest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      started(Promise.resolve('Done: copied 3 messages to Zulip.'));
      const command = interaction();
      command.editReply.mockResolvedValueOnce(undefined as never).mockRejectedValueOnce(new Error('Unknown Webhook'));

      await sut.mirrorBackfill(command);
      await settle();

      expect(log).toHaveBeenCalledWith(
        'Could not report the end of a backfill on Discord: the interaction has likely expired',
      );
    });
  });
});
