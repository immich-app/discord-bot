import { defaultMainTopic, mainTopicProblem, toEnabledPair } from 'src/mirror/pairs';
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

  it('should give a forum no main topic', () => {
    expect(toEnabledPair(link({ kind: 'forum', mainTopic: 'stray' })).mainTopic).toBeNull();
  });
});

describe('defaultMainTopic', () => {
  it('should name the topic after the channel, within the topic length', () => {
    expect(defaultMainTopic('dev')).toBe('#dev');
    expect([...defaultMainTopic('x'.repeat(100))]).toHaveLength(58);
    expect(mainTopicProblem(defaultMainTopic('x'.repeat(100)))).toBeUndefined();
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
