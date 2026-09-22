import { Logger } from '@nestjs/common';
import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type { paths } from 'src/generated/zulip';

/**
 * A typed `openapi-fetch` client for Zulip's REST API, built from the generated 12.3 types.
 *
 * Transport rules (see the Zulip section of `claude.md`):
 * - every request body is sent `application/x-www-form-urlencoded` unless it is multipart;
 * - non-string fields, in bodies and in query strings, are JSON-encoded, never exploded;
 * - any non-2xx response or `result: "error"` body rejects with a `ZulipApiError`;
 * - a 429 is retried after the server's `retry-after`, within bounds; nothing else is retried;
 * - every request times out.
 */
export type ZulipClient = Client<paths>;

export type ZulipIdentity = { username: string; apiKey: string };

/**
 * The subset of `fetch` the client uses: `openapi-fetch` always hands it a fully built `Request`, and the client adds
 * the attempt's timeout as `init`. The signal must travel in `init`, never through the `Request` constructor: undici
 * only holds a signal routed that way through a `WeakRef`, so once the GC runs the abort no longer propagates and a
 * hung server blocks the caller for undici's 300s fallback, or forever if it trickles a body.
 */
export type ZulipFetch = (request: Request, init: { signal: AbortSignal }) => Promise<Response>;

export type ZulipClientOptions = ZulipIdentity & {
  /** `ZULIP_DOMAIN`: scheme and host, optionally followed by `/` or `/api`. */
  realm: string;
  /** Milliseconds before an attempt is aborted. */
  timeoutMs?: number;
  /** Attempts for a rate-limited request, counting the first one. */
  maxAttempts?: number;
  /** Longest single `retry-after` the client honours; a longer one fails the request instead of waiting. */
  maxRetryAfterMs?: number;
  /** The underlying fetch; defaults to the global one and is injected by tests. */
  fetch?: ZulipFetch;
  /** Pause between attempts; defaults to a timer and is injected by tests. */
  sleep?: (ms: number) => Promise<void>;
};

type ZulipBody = { result?: string; msg?: string; code?: string; 'retry-after'?: number };

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;

export class ZulipApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly msg: string,
    endpoint: string,
  ) {
    super(`Zulip ${endpoint} failed with ${status} ${code}: ${msg}`);
    this.name = 'ZulipApiError';
  }
}

/** `${realm}/api/v1`, accepting a realm that ends in `/` or `/api` as the previous SDK did. */
export const toApiUrl = (realm: string) => `${realm.replace(/\/+$/, '').replace(/\/api$/, '')}/api/v1`;

/**
 * Encodes fields the way the 12.3 spec declares every parameter we send: strings as they are, everything else
 * (`number`, `boolean`, array, object) as JSON, `undefined` omitted. Used for form bodies and query strings alike.
 */
export const encodeForm = (fields: Record<string, unknown>) => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) {
      params.append(name, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
  return params.toString();
};

/**
 * The `body` and `bodySerializer` of a `multipart/form-data` request. Every part is a `File`, so it carries a filename
 * and a content type; `fetch` sets the `Content-Type` header with the boundary itself.
 */
export const multipart = <T extends Record<string, File>>(parts: T) => ({
  body: parts as unknown as { [K in keyof T]: string },
  bodySerializer: (body: unknown) => {
    const form = new FormData();
    for (const [name, file] of Object.entries(body as T)) {
      form.append(name, file);
    }
    return form;
  },
});

const describe = (request: Request) => `${request.method} ${new URL(request.url).pathname}`;

const parseBody = async (response: Response) => {
  try {
    return (await response.clone().json()) as ZulipBody;
  } catch {
    return undefined;
  }
};

/** Body field first, `Retry-After` header second, both in seconds. */
const readRetryAfterMs = async (response: Response) => {
  const body = await parseBody(response);
  const seconds =
    typeof body?.['retry-after'] === 'number' ? body['retry-after'] : Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS;
};

/** `openapi-fetch` sets `application/json` by default; every non-multipart body we send is form-urlencoded. */
const formEncoding: Middleware = {
  onRequest({ request }) {
    if (request.body && !request.headers.get('content-type')?.startsWith('multipart/form-data')) {
      request.headers.set('content-type', 'application/x-www-form-urlencoded');
    }
  },
};

/** Zulip reports failures with a non-2xx status and a `result: "error"` body; either one rejects the call. */
const errors: Middleware = {
  async onResponse({ request, response }) {
    const body = await parseBody(response);
    if (response.ok && body?.result !== 'error') {
      return;
    }
    throw new ZulipApiError(
      response.status,
      body?.code ?? 'UNKNOWN_ERROR',
      body?.msg ?? (response.statusText || `HTTP ${response.status}`),
      describe(request),
    );
  },
};

const defaultFetch: ZulipFetch = (request, init) => globalThis.fetch(request, init);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createZulipClient = ({
  realm,
  username,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
  fetch = defaultFetch,
  sleep = defaultSleep,
}: ZulipClientOptions): ZulipClient => {
  const logger = new Logger('ZulipClient');

  /**
   * Retries 429 only: a rate-limited request was not processed, whereas retrying a 5xx on `POST /messages` could
   * double-post. `Request` bodies are single-use streams, so each attempt sends a clone of the original.
   */
  const fetchWithRetry = async (request: Request) => {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(request.clone(), { signal: AbortSignal.timeout(timeoutMs) });
      if (response.status !== 429) {
        return response;
      }

      const retryAfterMs = await readRetryAfterMs(response);
      if (attempt >= maxAttempts || retryAfterMs > maxRetryAfterMs) {
        return response;
      }

      logger.warn(
        `Rate limited on ${describe(request)}, retrying in ${retryAfterMs}ms (attempt ${attempt}/${maxAttempts})`,
      );
      await sleep(retryAfterMs);
    }
  };

  const client = createClient<paths>({
    baseUrl: toApiUrl(realm),
    headers: { Authorization: `Basic ${Buffer.from(`${username}:${apiKey}`).toString('base64')}` },
    querySerializer: (query) => encodeForm(query),
    bodySerializer: (body: unknown) => encodeForm(body as Record<string, unknown>),
    fetch: fetchWithRetry,
  });
  client.use(formEncoding, errors);
  return client;
};
