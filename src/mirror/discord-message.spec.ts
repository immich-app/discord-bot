import {
  ChannelType,
  Collection,
  EmbedType,
  Message,
  MessageFlags,
  MessageFlagsBitField,
  MessageReferenceType,
  MessageType,
} from 'discord.js';
import { Constants } from 'src/constants';
import { forumTagNames, isMirrorCandidate, mirrorLocation, toDiscordSourceMessage } from 'src/mirror/discord-message';
import { describe, expect, it } from 'vitest';

const guildId = Constants.Discord.Servers[0];
const channelId = '100000000000000001';
const threadId = '200000000000000001';

const textChannel = (cached: Message[] = []) => ({
  id: channelId,
  type: ChannelType.GuildText,
  isThread: () => false,
  messages: { cache: new Collection(cached.map((message) => [message.id, message])) },
});

const threadChannel = (type = ChannelType.PublicThread, cached: Message[] = []) => ({
  id: threadId,
  type,
  parentId: channelId,
  name: 'Crash on upload',
  isThread: () => true,
  messages: { cache: new Collection(cached.map((message) => [message.id, message])) },
});

const BOT_USER = '600000000000000001';
const OWN_WEBHOOK = '700000000000000001';
const isOwnWebhook = (id: string) => id === OWN_WEBHOOK;

const makeMessage = (overrides: Record<string, unknown> = {}) => {
  const message: Record<string, unknown> = {
    id: '300000000000000001',
    guildId,
    client: { user: { id: BOT_USER } },
    embeds: [],
    channel: textChannel(),
    author: { id: '400000000000000001', username: 'contrib123', displayName: 'Contrib', bot: false },
    member: { displayName: 'Alex (Immich)' },
    webhookId: null,
    system: false,
    type: MessageType.Default,
    createdTimestamp: 1_790_000_000_000,
    url: `https://discord.com/channels/${guildId}/${channelId}/300000000000000001`,
    flags: new MessageFlagsBitField(),
    content: 'hello',
    mentions: {
      users: new Collection(),
      members: new Collection(),
      roles: new Collection(),
      channels: new Collection(),
    },
    attachments: new Collection(),
    stickers: new Collection(),
    poll: null,
    messageSnapshots: new Collection(),
    reference: null,
    ...overrides,
  };
  message.inGuild = () => message.guildId !== null;
  return message as unknown as Message<true>;
};

describe('isMirrorCandidate', () => {
  const otherBot = { id: '1', username: 'bot', displayName: 'bot', bot: true };
  const self = { id: BOT_USER, username: 'Immich', displayName: 'Immich', bot: true };

  it.each([
    ['a message in a channel', {}],
    ['a reply', { type: MessageType.Reply }],
    ['a message in a public thread', { channel: threadChannel() }],
    ['a message in the second server', { guildId: Constants.Discord.Servers[1] }],
    ['another bot', { author: otherBot }],
    ['a webhook that is not the mirror', { webhookId: '500000000000000001', author: otherBot }],
    ['a reply of the bot itself, such as a GitHub expansion', { author: self, type: MessageType.Reply }],
  ])('should accept %s', (_, overrides) => {
    expect(isMirrorCandidate(makeMessage(overrides), isOwnWebhook)).toBe(true);
  });

  it.each([
    ['another guild', { guildId: '999999999999999999' }],
    ['a direct message', { guildId: null }],
    ['a copy the mirror posted', { webhookId: OWN_WEBHOOK, author: { ...otherBot, id: OWN_WEBHOOK } }],
    ['an announcement of the bot itself', { author: self }],
    ['a webhook whose ID is unknown', { webhookId: undefined }],
    ['a system message', { system: true }],
    ['a thread-created notice', { type: MessageType.ThreadCreated }],
    ['a pin notice', { type: MessageType.ChannelPinnedMessage }],
    ['a slash command response', { type: MessageType.ChatInputCommand }],
    ['a private thread', { channel: threadChannel(ChannelType.PrivateThread) }],
  ])('should reject %s', (_, overrides) => {
    expect(isMirrorCandidate(makeMessage(overrides), isOwnWebhook)).toBe(false);
  });
});

describe('mirrorLocation', () => {
  it('should use the channel itself outside threads', () => {
    expect(mirrorLocation(textChannel() as never)).toEqual({ channelId, threadId: null, threadName: null });
  });

  it('should use the parent channel for a thread', () => {
    expect(mirrorLocation(threadChannel() as never)).toEqual({ channelId, threadId, threadName: 'Crash on upload' });
  });
});

describe('toDiscordSourceMessage', () => {
  it('should map a channel message', () => {
    expect(toDiscordSourceMessage(makeMessage())).toEqual({
      id: '300000000000000001',
      guildId,
      channelId,
      threadId: null,
      threadName: null,
      createdTimestamp: 1_790_000_000_000,
      jumpUrl: `https://discord.com/channels/${guildId}/${channelId}/300000000000000001`,
      author: { id: '400000000000000001', username: 'contrib123', displayName: 'Alex (Immich)' },
      silent: false,
      content: 'hello',
      mentions: { users: {}, roles: {}, channels: {} },
      attachments: [],
      stickers: [],
      poll: null,
      forwarded: [],
      replyTo: null,
    });
  });

  it('should map a message in a thread to the parent channel', () => {
    expect(toDiscordSourceMessage(makeMessage({ channel: threadChannel() }))).toMatchObject({
      channelId,
      threadId,
      threadName: 'Crash on upload',
    });
  });

  it('should name the tags of the forum post a message is in', () => {
    const forum = {
      type: ChannelType.GuildForum,
      availableTags: [
        { id: '1', name: 'bug' },
        { id: '2', name: 'mobile' },
        { id: '3', name: 'server' },
      ],
    };
    const post = { ...threadChannel(), parent: forum, appliedTags: ['2', '1', '9'] };

    expect(toDiscordSourceMessage(makeMessage({ channel: post })).threadTags).toEqual(['mobile', 'bug']);
    expect(forumTagNames(post as never)).toEqual(['mobile', 'bug']);
    expect(forumTagNames({ ...post, parent: { type: ChannelType.GuildText } } as never)).toBeUndefined();
    expect(toDiscordSourceMessage(makeMessage({ channel: threadChannel() }))).not.toHaveProperty('threadTags');
  });

  it('should mark a bot or webhook and keep the embeds it wrote, leaving out link previews', () => {
    const rich = {
      data: { type: EmbedType.Rich },
      title: 'Backup done',
      url: 'https://example.com/run/1',
      description: 'All **good**',
      fields: [{ name: 'Size', value: '12 GB', inline: true }],
    };
    const preview = { data: { type: EmbedType.Link }, title: 'x', url: null, description: null, fields: [] };
    const message = makeMessage({
      author: { id: '1', username: 'backups', displayName: 'FutoBackupsBot', bot: true },
      embeds: [rich, preview],
    });

    expect(toDiscordSourceMessage(message)).toMatchObject({
      author: { id: '1', username: 'backups', displayName: 'Alex (Immich)', bot: true },
      embeds: [
        {
          title: 'Backup done',
          url: 'https://example.com/run/1',
          description: 'All **good**',
          fields: [{ name: 'Size', value: '12 GB' }],
        },
      ],
    });
    expect(toDiscordSourceMessage(makeMessage({ embeds: [rich] }))).not.toHaveProperty('embeds');
    expect(toDiscordSourceMessage(makeMessage()).author).not.toHaveProperty('bot');
    expect(toDiscordSourceMessage(makeMessage({ webhookId: '500000000000000001' })).author.bot).toBe(true);
  });

  it('should fall back to the user display name without a member', () => {
    expect(toDiscordSourceMessage(makeMessage({ member: null })).author.displayName).toBe('Contrib');
  });

  it('should mark @silent messages', () => {
    const flags = new MessageFlagsBitField(MessageFlags.SuppressNotifications);
    expect(toDiscordSourceMessage(makeMessage({ flags })).silent).toBe(true);
  });

  it('should map mentions to display names', () => {
    const mentions = {
      users: new Collection([
        ['1', { displayName: 'Global One' }],
        ['2', { displayName: 'Global Two' }],
      ]),
      members: new Collection([['1', { displayName: 'Nick One' }]]),
      roles: new Collection([['3', { name: 'Contributor' }]]),
      channels: new Collection<string, unknown>([
        ['4', { name: 'dev-off-topic' }],
        ['5', { recipientId: '1' }],
      ]),
    };

    expect(toDiscordSourceMessage(makeMessage({ mentions })).mentions).toEqual({
      users: { '1': 'Nick One', '2': 'Global Two' },
      roles: { '3': 'Contributor' },
      channels: { '4': 'dev-off-topic' },
    });
  });

  it('should map attachments, stickers, polls and forwards', () => {
    const message = makeMessage({
      attachments: new Collection([
        [
          '6',
          {
            id: '6',
            name: 'SPOILER_log.txt',
            url: 'https://cdn.discordapp.com/attachments/1/6/SPOILER_log.txt?ex=1',
            size: 12,
            contentType: 'text/plain; charset=utf-8',
            spoiler: true,
            proxyURL: 'https://media.discordapp.net/x',
          },
        ],
      ]),
      stickers: new Collection([['7', { name: 'wave' }]]),
      poll: { question: { text: 'Ship it?' } },
      messageSnapshots: new Collection([['8', { content: 'forwarded text' }]]),
    });

    const dto = toDiscordSourceMessage(message);
    expect(dto.attachments).toEqual([
      {
        id: '6',
        name: 'SPOILER_log.txt',
        url: 'https://cdn.discordapp.com/attachments/1/6/SPOILER_log.txt?ex=1',
        size: 12,
        contentType: 'text/plain; charset=utf-8',
        spoiler: true,
      },
    ]);
    expect(dto).toMatchObject({ stickers: ['wave'], poll: 'Ship it?', forwarded: ['forwarded text'] });
  });

  it('should map a poll without question text to null', () => {
    expect(toDiscordSourceMessage(makeMessage({ poll: { question: { text: null } } })).poll).toBeNull();
  });

  it('should carry the cached replied-to message', () => {
    const referenced = makeMessage({ id: '300000000000000000', content: 'original', member: null });
    const message = makeMessage({
      type: MessageType.Reply,
      reference: { channelId, guildId, messageId: '300000000000000000', type: MessageReferenceType.Default },
      channel: textChannel([referenced]),
    });

    expect(toDiscordSourceMessage(message).replyTo).toEqual({
      messageId: '300000000000000000',
      authorDisplayName: 'Contrib',
      content: 'original',
    });
  });

  it('should leave the name and content of an uncached replied-to message null', () => {
    const message = makeMessage({
      type: MessageType.Reply,
      reference: { channelId, guildId, messageId: '300000000000000000', type: MessageReferenceType.Default },
    });

    expect(toDiscordSourceMessage(message).replyTo).toEqual({
      messageId: '300000000000000000',
      authorDisplayName: null,
      content: null,
    });
  });

  it('should not treat a forward as a reply', () => {
    const message = makeMessage({
      reference: { channelId, guildId, messageId: '300000000000000000', type: MessageReferenceType.Forward },
    });
    expect(toDiscordSourceMessage(message).replyTo).toBeNull();
  });
});
