import { Constants, MirrorPairConfig, MirrorPairKey } from 'src/constants';
import { DiscordChannel } from 'src/interfaces/discord.interface';
import { validateMirrorConfig } from 'src/mirror/pairs';
import { describe, expect, it } from 'vitest';

const DEV_CHANNEL = '1000000000000000001';
const OFF_TOPIC_CHANNEL = '1000000000000000002';

const pairs = (overrides: Partial<Record<MirrorPairKey, Partial<MirrorPairConfig>>> = {}) => {
  const base: Record<MirrorPairKey, MirrorPairConfig> = {
    Dev: { kind: 'text', discordChannelId: DEV_CHANNEL, zulipStreamId: 200, mainTopic: '#dev' },
    DevOffTopic: { kind: 'text', discordChannelId: OFF_TOPIC_CHANNEL, zulipStreamId: 201, mainTopic: '#dev-off-topic' },
    DevFocusTopic: { kind: 'forum', discordChannelId: Constants.Discord.Channels.DevFocusTopic, zulipStreamId: 202 },
  };
  for (const [key, override] of Object.entries(overrides) as [MirrorPairKey, Partial<MirrorPairConfig>][]) {
    base[key] = { ...base[key], ...override };
  }
  return base;
};

const enabledKeys = (config: Record<MirrorPairKey, MirrorPairConfig>) =>
  validateMirrorConfig(config, {}).enabled.map(({ key }) => key);

describe('validateMirrorConfig', () => {
  it('should enable nothing and name all three pairs while the IDs are placeholders', () => {
    expect(validateMirrorConfig(Constants.Mirror.Pairs, Constants.Mirror.TeamMembers)).toEqual({
      enabled: [],
      placeholders: ['Dev', 'DevOffTopic', 'DevFocusTopic'],
      problems: [],
      teamMembers: new Map(),
    });
  });

  it('should enable complete pairs', () => {
    const report = validateMirrorConfig(pairs(), {});
    expect(report.problems).toEqual([]);
    expect(report.placeholders).toEqual([]);
    expect(report.enabled).toEqual([
      { key: 'Dev', kind: 'text', discordChannelId: DEV_CHANNEL, zulipStreamId: 200, mainTopic: '#dev', public: false },
      {
        key: 'DevOffTopic',
        kind: 'text',
        discordChannelId: OFF_TOPIC_CHANNEL,
        zulipStreamId: 201,
        mainTopic: '#dev-off-topic',
        public: false,
      },
      {
        key: 'DevFocusTopic',
        kind: 'forum',
        discordChannelId: Constants.Discord.Channels.DevFocusTopic,
        zulipStreamId: 202,
        mainTopic: null,
        public: false,
      },
    ]);
  });

  it('should treat a pair with only one ID filled in as a placeholder', () => {
    const report = validateMirrorConfig(pairs({ Dev: { zulipStreamId: null } }), {});
    expect(report.placeholders).toEqual(['Dev']);
    expect(report.enabled.map(({ key }) => key)).toEqual(['DevOffTopic', 'DevFocusTopic']);
  });

  it('should carry the public flag', () => {
    expect(validateMirrorConfig(pairs({ Dev: { public: true } }), {}).enabled[0].public).toBe(true);
  });

  it('should drop a forum pair main topic, which is never used', () => {
    const report = validateMirrorConfig(pairs({ DevFocusTopic: { mainTopic: 'x' } }), {});
    expect(report.enabled[2].mainTopic).toBeNull();
    expect(report.problems).toEqual([]);
  });

  it.each([...Object.values(Constants.Zulip.TeamStreams), ...Object.values(Constants.Zulip.Streams)])(
    'should refuse internal stream %s',
    (stream) => {
      const report = validateMirrorConfig(pairs({ Dev: { zulipStreamId: stream } }), {});
      expect(report.enabled.map(({ key }) => key)).not.toContain('Dev');
      expect(report.problems).toContain(
        `Dev: Zulip stream ${stream} is an internal stream in Constants.Zulip, so the pair is off`,
      );
    },
  );

  it('should refuse the internal stream 107', () => {
    expect(enabledKeys(pairs({ Dev: { zulipStreamId: 107 } }))).toEqual(['DevOffTopic', 'DevFocusTopic']);
  });

  it.each([Constants.Discord.Channels.TeamAlerts, Constants.Discord.Channels.TeamFocusTopic, DiscordChannel.General])(
    'should refuse internal Discord channel %s',
    (channel) => {
      const report = validateMirrorConfig(pairs({ Dev: { discordChannelId: channel } }), {});
      expect(report.enabled.map(({ key }) => key)).toEqual(['DevOffTopic', 'DevFocusTopic']);
      expect(report.problems).toEqual([`Dev: Discord channel ${channel} is an internal channel, so the pair is off`]);
    },
  );

  it('should disable every pair that shares a Discord channel', () => {
    const report = validateMirrorConfig(pairs({ DevOffTopic: { discordChannelId: DEV_CHANNEL } }), {});
    expect(report.enabled.map(({ key }) => key)).toEqual(['DevFocusTopic']);
    expect(report.problems).toEqual([
      `Dev, DevOffTopic: Discord channel ${DEV_CHANNEL} is in more than one pair, so none of them is mirrored`,
    ]);
  });

  it('should disable every pair that shares a Zulip stream', () => {
    const report = validateMirrorConfig(pairs({ DevOffTopic: { zulipStreamId: 200 } }), {});
    expect(report.enabled.map(({ key }) => key)).toEqual(['DevFocusTopic']);
    expect(report.problems).toEqual([
      'Dev, DevOffTopic: Zulip stream 200 is in more than one pair, so none of them is mirrored',
    ]);
  });

  it('should count a duplicate against a pair that is still a placeholder', () => {
    const report = validateMirrorConfig(
      pairs({ DevOffTopic: { discordChannelId: DEV_CHANNEL, zulipStreamId: null } }),
      {},
    );
    expect(report.enabled.map(({ key }) => key)).toEqual(['DevFocusTopic']);
    expect(report.placeholders).toEqual(['DevOffTopic']);
  });

  it.each(['abc', '123', '1'.repeat(21), ` ${DEV_CHANNEL}`])('should refuse the malformed snowflake %j', (id) => {
    const report = validateMirrorConfig(pairs({ Dev: { discordChannelId: id } }), {});
    expect(report.enabled.map(({ key }) => key)).toEqual(['DevOffTopic', 'DevFocusTopic']);
    expect(report.problems).toEqual([`Dev: the Discord channel ID "${id}" is not a snowflake, so the pair is off`]);
  });

  it.each([0, -1, 1.5, Number.NaN])('should refuse the stream ID %s', (stream) => {
    const report = validateMirrorConfig(pairs({ Dev: { zulipStreamId: stream } }), {});
    expect(report.enabled.map(({ key }) => key)).toEqual(['DevOffTopic', 'DevFocusTopic']);
    expect(report.problems).toEqual([
      `Dev: the Zulip stream ID ${stream} is not a positive integer, so the pair is off`,
    ]);
  });

  it('should refuse a text pair without a main topic', () => {
    const report = validateMirrorConfig(pairs({ Dev: { mainTopic: undefined } }), {});
    expect(report.enabled.map(({ key }) => key)).toEqual(['DevOffTopic', 'DevFocusTopic']);
    expect(report.problems).toEqual(['Dev: a text pair needs a main topic, so the pair is off']);
  });

  it.each(['', '   ', ' #dev', '#dev ', 'x'.repeat(59), '😀'.repeat(59)])(
    'should refuse the main topic %j',
    (mainTopic) => {
      const report = validateMirrorConfig(pairs({ Dev: { mainTopic } }), {});
      expect(report.enabled.map(({ key }) => key)).toEqual(['DevOffTopic', 'DevFocusTopic']);
      expect(report.problems).toEqual([
        'Dev: the main topic must be 1 to 58 characters with no surrounding whitespace, so the pair is off',
      ]);
    },
  );

  it('should accept a main topic of exactly 58 code points', () => {
    expect(enabledKeys(pairs({ Dev: { mainTopic: '😀'.repeat(58) } }))).toContain('Dev');
  });

  it('should keep valid team members', () => {
    const report = validateMirrorConfig(pairs(), { 8: '222222222222222222', 12: '333333333333333333' });
    expect(report.teamMembers).toEqual(
      new Map([
        [8, '222222222222222222'],
        [12, '333333333333333333'],
      ]),
    );
    expect(report.problems).toEqual([]);
  });

  it('should drop team member entries that are not a Zulip user ID and a Discord user ID', () => {
    const teamMembers = { 8: '222222222222222222', 0: '333333333333333333', 9: '123', 10: 456 } as unknown as Record<
      number,
      string
    >;
    const report = validateMirrorConfig(pairs(), {
      ...teamMembers,
      ['abc' as unknown as number]: '444444444444444444',
    });
    expect(report.teamMembers).toEqual(new Map([[8, '222222222222222222']]));
    expect(report.problems).toEqual([
      'Constants.Mirror.TeamMembers: "0" is not a Zulip user ID, so the entry is ignored',
      'Constants.Mirror.TeamMembers: Zulip user 9 maps to "123", which is not a Discord user ID, so the entry is ignored',
      'Constants.Mirror.TeamMembers: Zulip user 10 maps to "456", which is not a Discord user ID, so the entry is ignored',
      'Constants.Mirror.TeamMembers: "abc" is not a Zulip user ID, so the entry is ignored',
    ]);
    expect(report.enabled).toHaveLength(3);
  });

  it('should drop every team member entry that shares a Discord user', () => {
    const report = validateMirrorConfig(pairs(), {
      8: '222222222222222222',
      9: '222222222222222222',
      10: '333333333333333333',
    });
    expect(report.teamMembers).toEqual(new Map([[10, '333333333333333333']]));
    expect(report.problems).toEqual([
      'Constants.Mirror.TeamMembers: Zulip users 8, 9 all map to Discord user 222222222222222222, so all of them are ignored',
    ]);
  });
});
