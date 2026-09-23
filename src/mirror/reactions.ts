import { DiscordReactionEmoji } from 'src/interfaces/discord-mirror.interface';
import { ZulipEmoji, ZulipReactionEmoji } from 'src/interfaces/zulip.interface';
import { zulipEmojiNames } from 'src/services/chat.service';

type DiscordEmote = { id: string; identifier: string; name: string | null; animated: boolean };

/** Only the emotes whose realm emoji exists: an emote the sync never uploaded has no Zulip counterpart. */
export type EmoteMaps = {
  zulipByEmoteId: Map<string, { name: string; realmId: string }>;
  discordByZulipName: Map<string, DiscordEmote>;
};

const VARIATION_SELECTOR = 0xfe_0f;
const ZERO_WIDTH_JOINER = 0x20_0d;
const KEYCAP = 0x20_e3;

const isSkinTone = (point: number) => point >= 0x1_f3_fb && point <= 0x1_f3_ff;

const codePoints = (text: string) => [...text].map((char) => char.codePointAt(0)!);

/** Zulip's table spells a code point as at least four lowercase hex digits. */
const toZulipCode = (points: number[]) => points.map((point) => point.toString(16).padStart(4, '0')).join('-');

export const toEmoteMaps = (emotes: DiscordEmote[], builtIn: string[], realm: ZulipEmoji[]): EmoteMaps => {
  const active = new Map(realm.filter(({ deactivated }) => !deactivated).map(({ id, name }) => [name, id]));
  const names = zulipEmojiNames(
    emotes.map((emote) => emote.name ?? emote.identifier),
    builtIn,
    new Set(active.keys()),
  );
  const maps: EmoteMaps = { zulipByEmoteId: new Map(), discordByZulipName: new Map() };
  for (const [index, emote] of emotes.entries()) {
    const realmId = active.get(names[index]);
    if (realmId !== undefined) {
      maps.zulipByEmoteId.set(emote.id, { name: names[index], realmId });
      maps.discordByZulipName.set(names[index], emote);
    }
  }
  return maps;
};

/** Zulip's table has no variation selectors and no skin tones, so a Discord emoji is looked up without them too. */
export const toZulipReactionEmoji = (
  emoji: DiscordReactionEmoji,
  names: Record<string, string>,
  emotes: EmoteMaps,
): ZulipReactionEmoji | undefined => {
  if (emoji.id !== null) {
    const realm = emotes.zulipByEmoteId.get(emoji.id);
    return realm && { name: realm.name, code: realm.realmId, type: 'realm_emoji' };
  }
  const points = codePoints(emoji.name ?? '');
  const plain = points.filter((point) => point !== VARIATION_SELECTOR);
  for (const candidate of [points, plain, plain.filter((point) => !isSkinTone(point))]) {
    const code = toZulipCode(candidate);
    const name = candidate.length > 0 ? names[code] : undefined;
    if (name !== undefined) {
      return { name, code, type: 'unicode_emoji' };
    }
  }
  return undefined;
};

export const toDiscordReactionEmoji = (
  emoji: ZulipReactionEmoji,
  emotes: EmoteMaps,
): DiscordReactionEmoji | undefined => {
  if (emoji.type === 'realm_emoji') {
    const emote = emotes.discordByZulipName.get(emoji.name);
    return emote && { id: emote.id, name: emote.name, animated: emote.animated };
  }
  if (emoji.type !== 'unicode_emoji' || !/^[\da-f]{1,6}(?:-[\da-f]{1,6})*$/i.test(emoji.code)) {
    return undefined;
  }
  const points = emoji.code.split('-').map((hex) => Number.parseInt(hex, 16));
  return points.every((point) => point <= 0x10_ff_ff)
    ? { id: null, name: String.fromCodePoint(...points), animated: false }
    : undefined;
};

/**
 * Zulip leaves out the variation selector that makes a character such as ❤ or a keycap an emoji, which Discord may
 * want, so a Unicode emoji Discord does not know is tried once more with it after every such character.
 */
export const withVariationSelectors = ({ id, name }: DiscordReactionEmoji): DiscordReactionEmoji | undefined => {
  if (id !== null || name === null) {
    return undefined;
  }
  const points = codePoints(name);
  const qualified = points.flatMap((point, index) => {
    const next = points[index + 1];
    const needs =
      point < 0x1_f3_00 &&
      ![VARIATION_SELECTOR, ZERO_WIDTH_JOINER, KEYCAP].includes(point) &&
      !(point >= 0x1_f1_e6 && point <= 0x1_f1_ff) &&
      next !== VARIATION_SELECTOR &&
      !(next !== undefined && isSkinTone(next));
    return needs ? [point, VARIATION_SELECTOR] : [point];
  });
  return qualified.length === points.length
    ? undefined
    : { id, name: String.fromCodePoint(...qualified), animated: false };
};

/** Discord reports a Unicode reaction with or without the variation selector it was given with. */
export const discordReactionKey = ({ id, name }: DiscordReactionEmoji) =>
  id ?? String.fromCodePoint(...codePoints(name ?? '').filter((point) => point !== VARIATION_SELECTOR));

export const zulipReactionKey = ({ type, code }: ZulipReactionEmoji) => `${type}:${code}`;
