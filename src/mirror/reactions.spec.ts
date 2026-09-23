import {
  discordReactionKey,
  toDiscordReactionEmoji,
  toEmoteMaps,
  toZulipReactionEmoji,
  withVariationSelectors,
  zulipReactionKey,
} from 'src/mirror/reactions';
import { describe, expect, it } from 'vitest';

const emote = (id: string, name: string, animated = false) => ({
  id,
  identifier: `${animated ? 'a:' : ''}${name}:${id}`,
  name,
  animated,
});

const NAMES = {
  '1f44d': '+1',
  '2764': 'heart',
  '0023-20e3': 'hash',
  '1f1e9-1f1ea': 'flag_germany',
  '1f3c3-200d-2640-200d-27a1': 'woman_running_facing_right',
};

describe('toEmoteMaps', () => {
  it('should name each emote as the emote sync does and keep only those the realm has', () => {
    const maps = toEmoteMaps(
      [emote('1', 'catJAM'), emote('2', 'CatJam'), emote('3', 'fire'), emote('4', 'wave'), emote('5', 'party', true)],
      ['fire', 'wave'],
      [
        { id: '10', name: 'catjam', deactivated: false },
        { id: '11', name: 'catjam2', deactivated: false },
        { id: '12', name: 'fire2', deactivated: false },
        { id: '13', name: 'wave2', deactivated: true },
        { id: '14', name: 'party', deactivated: false },
      ],
    );

    expect(Object.fromEntries(maps.zulipByEmoteId)).toEqual({
      '1': { name: 'catjam', realmId: '10' },
      '2': { name: 'catjam2', realmId: '11' },
      '3': { name: 'fire2', realmId: '12' },
      '5': { name: 'party', realmId: '14' },
    });
    expect([...maps.discordByZulipName.entries()].map(([name, { id }]) => [name, id])).toEqual([
      ['catjam', '1'],
      ['catjam2', '2'],
      ['fire2', '3'],
      ['party', '5'],
    ]);
  });

  it('should give an emote the built-in name an administrator overrode', () => {
    const maps = toEmoteMaps([emote('3', 'fire')], ['fire'], [{ id: '12', name: 'fire', deactivated: false }]);

    expect(maps.zulipByEmoteId.get('3')).toEqual({ name: 'fire', realmId: '12' });
  });
});

describe('toZulipReactionEmoji', () => {
  const emotes = toEmoteMaps([emote('3', 'fire')], ['fire'], [{ id: '12', name: 'fire2', deactivated: false }]);
  const unicode = (name: string) => toZulipReactionEmoji({ id: null, name, animated: false }, NAMES, emotes);

  it.each([
    ['👍', '+1', '1f44d'],
    ['❤️', 'heart', '2764'],
    ['❤', 'heart', '2764'],
    ['#️⃣', 'hash', '0023-20e3'],
    ['🇩🇪', 'flag_germany', '1f1e9-1f1ea'],
    ['👍🏽', '+1', '1f44d'],
    ['🏃‍♀️‍➡️', 'woman_running_facing_right', '1f3c3-200d-2640-200d-27a1'],
  ])('should name %s as Zulip does', (emoji, name, code) => {
    expect(unicode(emoji)).toEqual({ name, code, type: 'unicode_emoji' });
  });

  it('should find nothing for an emoji Zulip does not have, or none at all', () => {
    expect(unicode('🫨')).toBeUndefined();
    expect(unicode('')).toBeUndefined();
  });

  it('should name a synced emote by its realm emoji, and nothing for another', () => {
    expect(toZulipReactionEmoji({ id: '3', name: 'fire', animated: false }, NAMES, emotes)).toEqual({
      name: 'fire2',
      code: '12',
      type: 'realm_emoji',
    });
    expect(toZulipReactionEmoji({ id: '4', name: 'other', animated: false }, NAMES, emotes)).toBeUndefined();
  });
});

describe('toDiscordReactionEmoji', () => {
  const emotes = toEmoteMaps([emote('3', 'fire', true)], ['fire'], [{ id: '12', name: 'fire2', deactivated: false }]);

  it('should spell a Unicode emoji from its code points', () => {
    expect(
      toDiscordReactionEmoji({ name: 'flag_germany', code: '1f1e9-1f1ea', type: 'unicode_emoji' }, emotes),
    ).toEqual({ id: null, name: '🇩🇪', animated: false });
  });

  it('should find the emote of a realm emoji only when the guild has it', () => {
    expect(toDiscordReactionEmoji({ name: 'fire2', code: '12', type: 'realm_emoji' }, emotes)).toEqual({
      id: '3',
      name: 'fire',
      animated: true,
    });
    expect(toDiscordReactionEmoji({ name: 'catjam', code: '1', type: 'realm_emoji' }, emotes)).toBeUndefined();
  });

  it.each([
    { name: 'zulip', code: 'zulip', type: 'zulip_extra_emoji' as const },
    { name: 'odd', code: 'not-hex', type: 'unicode_emoji' as const },
    { name: 'huge', code: '110000', type: 'unicode_emoji' as const },
  ])('should skip $name', (emoji) => {
    expect(toDiscordReactionEmoji(emoji, emotes)).toBeUndefined();
  });
});

describe('withVariationSelectors', () => {
  it.each([
    ['❤', '❤️'],
    ['#⃣', '#️⃣'],
    ['🏃‍♀‍➡', '🏃‍♀️‍➡️'],
  ])('should qualify %s as %s', (name, qualified) => {
    expect(withVariationSelectors({ id: null, name, animated: false })).toEqual({
      id: null,
      name: qualified,
      animated: false,
    });
  });

  it.each(['👍', '❤️', '🇩🇪', '👍🏽'])('should have nothing to add to %s', (name) => {
    expect(withVariationSelectors({ id: null, name, animated: false })).toBeUndefined();
  });

  it('should leave an emote alone', () => {
    expect(withVariationSelectors({ id: '3', name: 'fire', animated: false })).toBeUndefined();
  });
});

describe('keys', () => {
  it('should key a Unicode reaction with or without its variation selector alike, and an emote by ID', () => {
    expect(discordReactionKey({ id: null, name: '❤️', animated: false })).toBe(
      discordReactionKey({ id: null, name: '❤', animated: false }),
    );
    expect(discordReactionKey({ id: '3', name: 'fire', animated: false })).toBe('3');
  });

  it('should key a Zulip reaction by its type and code, whatever name it was given by', () => {
    expect(zulipReactionKey({ name: 'thumbs_up', code: '1f44d', type: 'unicode_emoji' })).toBe(
      zulipReactionKey({ name: '+1', code: '1f44d', type: 'unicode_emoji' }),
    );
  });
});
