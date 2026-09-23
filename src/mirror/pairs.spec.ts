import { Constants } from 'src/constants';
import { holdsIdentityRole, mainTopicProblem, toEnabledPair } from 'src/mirror/pairs';
import { MirrorLink } from 'src/schema';
import { describe, expect, it } from 'vitest';

const link = (overrides: Partial<MirrorLink> = {}): MirrorLink => ({
  discordChannelId: '100000000000000001',
  zulipStreamId: 120,
  kind: 'text',
  mainTopic: '#dev',
  createdBy: 'Alex',
  discordAnnouncementId: null,
  createdAt: new Date(1_700_000_000_000),
  ...overrides,
});

describe('toEnabledPair', () => {
  it('should key the pair by its Discord channel and start catch-up at the link', () => {
    expect(toEnabledPair(link())).toEqual({
      key: '100000000000000001',
      kind: 'text',
      discordChannelId: '100000000000000001',
      zulipStreamId: 120,
      mainTopic: '#dev',
      linkedAt: 1_700_000_000_000,
    });
  });

  it('should keep the empty main topic of a text channel', () => {
    expect(toEnabledPair(link({ mainTopic: '' })).mainTopic).toBe('');
  });

  it('should give a forum no main topic', () => {
    expect(toEnabledPair(link({ kind: 'forum', mainTopic: 'stray' })).mainTopic).toBeNull();
  });
});

describe('mainTopicProblem', () => {
  it.each(['', ' ', ' #dev', '#dev ', 'x'.repeat(59)])('should refuse %j', (topic) => {
    expect(mainTopicProblem(topic)).toBe('the main topic must be 1 to 58 characters with no surrounding whitespace');
  });

  it.each(['#dev', 'general chat', 'x'.repeat(58)])('should accept %j', (topic) => {
    expect(mainTopicProblem(topic)).toBeUndefined();
  });
});

describe('holdsIdentityRole', () => {
  it.each([
    { server: 'production', guildId: '979116623879368755', roleIds: [Constants.Discord.Roles.Immich], expected: true },
    { server: 'dev', guildId: '1369624002863173762', roleIds: ['1369628185616187414'], expected: true },
    { server: 'dev', guildId: '1369624002863173762', roleIds: [Constants.Discord.Roles.Team], expected: false },
    { server: 'unknown', guildId: '1', roleIds: [Constants.Discord.Roles.Team], expected: false },
  ])('should be $expected for those roles on the $server server', ({ guildId, roleIds, expected }) => {
    expect(holdsIdentityRole(guildId, roleIds)).toBe(expected);
  });
});
