import { shortenCodePoints, ZULIP_MAX_UNRESOLVED_TOPIC_LENGTH } from 'src/format';

const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export const stripBidiControls = (text: string) => text.replaceAll(BIDI_CONTROLS, '');

const WEBHOOK_USERNAME_LENGTH = 80;
const DISCORD_THREAD_NAME_LENGTH = 100;
const MAX_TOPIC_SUFFIX = 10;

/** Discord refuses a webhook name that contains `clyde` or `discord`, so a hair space breaks both up. */
export const sanitiseWebhookUsername = (name: string, suffix = '') => {
  const cleaned = stripBidiControls(name)
    .replaceAll(/\s+/g, ' ')
    .trim()
    .replaceAll(/(c)(lyde)/gi, '$1\u200A$2')
    .replaceAll(/(d)(iscord)/gi, '$1\u200A$2');
  const cut = [...cleaned]
    .slice(0, WEBHOOK_USERNAME_LENGTH - [...suffix].length)
    .join('')
    .trim();
  return `${cut || 'Immich team'}${suffix}`;
};

/** How events and `GET /messages` name the empty topic; Zulip reads only this exact spelling back as the empty topic. */
export const EMPTY_TOPIC_NAME = 'general chat';

/** Zulip compares topics case-insensitively, yet a topic really named `General Chat` is not the empty one. */
export const topicKey = (topic: string) => (topic === EMPTY_TOPIC_NAME ? '' : topic.toLowerCase());

/** Leaves room for the resolve prefix, so the topic can still be resolved. */
export const toZulipTopicName = (name: string, threadId: string) =>
  shortenCodePoints(name.trim(), ZULIP_MAX_UNRESOLVED_TOPIC_LENGTH).trim() || `thread ${threadId}`;

export const topicCandidates = (base: string, threadId: string) => {
  const candidates = [base];
  for (let number = 2; number <= MAX_TOPIC_SUFFIX; number++) {
    const suffix = ` (${number})`;
    candidates.push(`${shortenCodePoints(base, ZULIP_MAX_UNRESOLVED_TOPIC_LENGTH - suffix.length)}${suffix}`);
  }
  candidates.push(`thread ${threadId}`);
  return candidates;
};

/** Discord counts a thread name in UTF-16 units. */
export const toDiscordThreadName = (topic: string) => {
  let name = '';
  for (const char of topic.trim()) {
    if (name.length + char.length > DISCORD_THREAD_NAME_LENGTH) {
      break;
    }
    name += char;
  }
  return name.trimEnd() || EMPTY_TOPIC_NAME;
};
