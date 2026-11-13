import { APIMessage, APIUser, DiscordAPIError, HTTPError } from 'discord.js';

const API = 'https://discord.com/api/v10';
const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 60_000;
/** A page this wide around a message holds it whenever it exists. */
const AROUND_LIMIT = 3;

export type DiscordUserMessageQuery = { limit: number; before?: string; after?: string; around?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `fetch` hides the reason in `cause`, where the mirror's outage checks do not look. */
const unwrapFetchFailure = (error: unknown) => {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error && typeof (cause as { code?: unknown }).code === 'string' ? cause : error;
};

const secondsToMs = (value: unknown) => {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
};

/**
 * Discord's REST API as a user account, read-only, for the message content Discord withholds from a bot without the
 * MessageContent intent. The token is sent without the `Bot` prefix and never logged.
 */
export class DiscordUserClient {
  private blockedUntil = new Map<string, number>();

  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  getCurrentUser() {
    return this.get<APIUser>('/users/@me', 'users/@me');
  }

  getMessages(channelId: string, { limit, before, after, around }: DiscordUserMessageQuery) {
    const query = new URLSearchParams({ limit: String(limit) });
    for (const [key, value] of Object.entries({ before, after, around })) {
      if (value !== undefined) {
        query.set(key, value);
      }
    }
    return this.get<APIMessage[]>(`/channels/${channelId}/messages?${query}`, `channels/${channelId}/messages`);
  }

  /** A user may not read one message by its ID (`Only bots can use this endpoint`), so it is found in its page. */
  async getMessage(channelId: string, messageId: string) {
    const page = await this.getMessages(channelId, { around: messageId, limit: AROUND_LIMIT });
    return page.find(({ id }) => id === messageId);
  }

  private async get<T>(path: string, route: string, attempt = 1): Promise<T> {
    const blocked = (this.blockedUntil.get(route) ?? 0) - Date.now();
    if (blocked > 0) {
      await sleep(Math.min(blocked, MAX_WAIT_MS));
    }

    const url = `${API}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Authorization: this.token },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw unwrapFetchFailure(error);
    }

    if (response.headers.get('x-ratelimit-remaining') === '0') {
      const resetMs = secondsToMs(response.headers.get('x-ratelimit-reset-after'));
      if (resetMs !== undefined) {
        this.blockedUntil.set(route, Date.now() + resetMs);
      }
    }

    if (response.ok) {
      return (await response.json()) as T;
    }

    const body = (await response.json().catch(() => undefined)) as
      { code?: unknown; message?: unknown; retry_after?: unknown } | undefined;

    if (response.status === 429) {
      const waitMs = secondsToMs(body?.retry_after) ?? secondsToMs(response.headers.get('retry-after')) ?? 1000;
      if (attempt < MAX_ATTEMPTS && waitMs <= MAX_WAIT_MS) {
        await sleep(waitMs);
        return this.get<T>(path, route, attempt + 1);
      }
    }

    if (body && typeof body.code === 'number' && typeof body.message === 'string') {
      throw new DiscordAPIError({ code: body.code, message: body.message }, body.code, response.status, 'GET', url, {});
    }
    throw new HTTPError(response.status, response.statusText, 'GET', url, {});
  }
}
