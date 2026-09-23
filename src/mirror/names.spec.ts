import {
  sanitiseWebhookUsername,
  stripBidiControls,
  toDiscordThreadName,
  topicCandidates,
  topicKey,
  toZulipTopicName,
} from 'src/mirror/names';
import { describe, expect, it } from 'vitest';

const codePoints = (text: string) => [...text].length;

describe('sanitiseWebhookUsername', () => {
  it.each([
    { name: 'Discord Mod', expected: 'D\u200Aiscord Mod' },
    { name: 'CLYDE', expected: 'C\u200ALYDE' },
    { name: 'my discord and clyde', expected: 'my d\u200Aiscord and c\u200Alyde' },
    { name: 'Zack Pollard', expected: 'Zack Pollard' },
  ])('should break up the names Discord refuses in $name', ({ name, expected }) => {
    expect(sanitiseWebhookUsername(name)).toBe(expected);
  });

  it('should cut an 81 code point name to 80', () => {
    expect(sanitiseWebhookUsername('x'.repeat(81))).toBe('x'.repeat(80));
  });

  it('should keep the suffix whole and cut the name to make room for it', () => {
    const name = sanitiseWebhookUsername('x'.repeat(100), ' (Zulip)');
    expect(name).toBe(`${'x'.repeat(72)} (Zulip)`);
    expect(codePoints(name)).toBe(80);
    expect(sanitiseWebhookUsername('Alex', ' (Zulip)')).toBe('Alex (Zulip)');
  });

  it('should never split a surrogate pair at the cut', () => {
    const name = sanitiseWebhookUsername('😀'.repeat(81));
    expect(name).toBe('😀'.repeat(80));
    expect(name).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('should strip bidi controls, so an RTL override cannot reorder the suffix', () => {
    expect(sanitiseWebhookUsername('evil\u202Egnp.exe', ' (Zulip)')).toBe('evilgnp.exe (Zulip)');
    expect(stripBidiControls('\u200E\u200Fa\u202A\u202B\u202C\u202D\u202Eb\u2066\u2067\u2068\u2069')).toBe('ab');
  });

  it('should collapse whitespace and trim', () => {
    expect(sanitiseWebhookUsername('  Alex \n\t Smith  ')).toBe('Alex Smith');
  });

  it('should fall back to Immich team when nothing is left of the name', () => {
    expect(sanitiseWebhookUsername('   ')).toBe('Immich team');
    expect(sanitiseWebhookUsername('\u202E', ' (Zulip)')).toBe('Immich team (Zulip)');
  });

  it('should not leave a trailing space where the cut falls after a space', () => {
    expect(sanitiseWebhookUsername(`${'x'.repeat(71)} yyyy`, ' (Zulip)')).toBe(`${'x'.repeat(71)} (Zulip)`);
  });
});

describe('topicKey', () => {
  it('should lower-case, as Zulip compares topics case-insensitively', () => {
    expect(topicKey('Bug In #Dev')).toBe('bug in #dev');
  });

  it('should keep the empty topic apart from a topic named like it', () => {
    expect(topicKey('general chat')).toBe('');
    expect(topicKey('')).toBe('');
    expect(topicKey('General Chat')).toBe('general chat');
  });
});

describe('toZulipTopicName', () => {
  it('should keep a short name as it is, trimmed', () => {
    expect(toZulipTopicName('  Thumbnail bug  ', '123')).toBe('Thumbnail bug');
  });

  it('should cut to 58 code points, leaving room for the resolve prefix', () => {
    const topic = toZulipTopicName('x'.repeat(70), '123');
    expect(topic).toBe(`${'x'.repeat(55)}...`);
    expect(codePoints(topic)).toBe(58);
    expect(codePoints(toZulipTopicName('😀'.repeat(70), '123'))).toBe(58);
  });

  it('should trim what the cut leaves', () => {
    expect(toZulipTopicName(`${'x'.repeat(54)}${' '.repeat(10)}y`, '1')).toBe(`${'x'.repeat(54)} ...`);
    expect(toZulipTopicName(`   ${'x'.repeat(58)}`, '1')).toBe('x'.repeat(58));
  });

  it('should name an empty thread after its ID', () => {
    expect(toZulipTopicName('', '123')).toBe('thread 123');
    expect(toZulipTopicName(' \n ', '123')).toBe('thread 123');
  });
});

describe('topicCandidates', () => {
  it('should try the name, then (2) to (10), then the thread ID', () => {
    expect(topicCandidates('Bug', '123')).toEqual([
      'Bug',
      'Bug (2)',
      'Bug (3)',
      'Bug (4)',
      'Bug (5)',
      'Bug (6)',
      'Bug (7)',
      'Bug (8)',
      'Bug (9)',
      'Bug (10)',
      'thread 123',
    ]);
  });

  it('should keep every candidate within 58 code points', () => {
    for (const base of ['x'.repeat(58), '😀'.repeat(58), `${'x'.repeat(53)}`]) {
      for (const candidate of topicCandidates(base, '1')) {
        expect(codePoints(candidate), candidate).toBeLessThanOrEqual(58);
      }
    }
    expect(topicCandidates('x'.repeat(58), '1')[1]).toBe(`${'x'.repeat(51)}... (2)`);
    expect(topicCandidates('x'.repeat(58), '1')[9]).toBe(`${'x'.repeat(50)}... (10)`);
  });
});

describe('toDiscordThreadName', () => {
  it('should keep a topic as it is', () => {
    expect(toDiscordThreadName('✔ Thumbnail bug')).toBe('✔ Thumbnail bug');
  });

  it('should cut to 100 UTF-16 units', () => {
    expect(toDiscordThreadName('x'.repeat(101))).toBe('x'.repeat(100));
  });

  it('should never split a code point at the cut', () => {
    expect(toDiscordThreadName('😀'.repeat(60))).toBe('😀'.repeat(50));
    expect(toDiscordThreadName(`x${'😀'.repeat(60)}`)).toBe(`x${'😀'.repeat(49)}`);
  });

  it('should trim, and not end on whitespace after a cut', () => {
    expect(toDiscordThreadName('  topic  ')).toBe('topic');
    expect(toDiscordThreadName(`${'x'.repeat(99)} y`)).toBe('x'.repeat(99));
  });

  it('should name the empty topic general chat', () => {
    expect(toDiscordThreadName('')).toBe('general chat');
    expect(toDiscordThreadName('   ')).toBe('general chat');
  });
});
