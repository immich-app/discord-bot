import { Logger } from '@nestjs/common';
import { RequestListener, Server, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  ZulipApiError,
  ZulipClientOptions,
  ZulipFetch,
  ZulipRateLimit,
  createZulipClient,
  encodeForm,
  multipart,
  toApiUrl,
} from 'src/repositories/zulip.client';
import { Mock, afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

const REALM = 'https://zulip.example.com';
const USERNAME = 'bot@example.com';
const API_KEY = 'super-secret-api-key';
const BASIC = `Basic ${Buffer.from(`${USERNAME}:${API_KEY}`).toString('base64')}`;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const success = (extra: Record<string, unknown> = {}) => json({ result: 'success', msg: '', ...extra });
const failure = (status: number, code: string, msg: string, extra: Record<string, unknown> = {}) =>
  json({ result: 'error', code, msg, ...extra }, { status });
const rateLimited = (retryAfter?: number, headers: Record<string, string> = {}) =>
  json(
    { result: 'error', code: 'RATE_LIMIT_HIT', msg: 'API usage exceeded rate limit', 'retry-after': retryAfter },
    { status: 429, headers: { 'content-type': 'application/json', ...headers } },
  );

const message = { type: 'channel' as const, to: 54, topic: 'release', content: 'hello world' };

describe('ZulipClient', () => {
  let fetchMock: Mock<ZulipFetch>;
  let sleep: Mock<(ms: number) => Promise<void>>;

  const newClient = (overrides: Partial<ZulipClientOptions> = {}) =>
    createZulipClient({ realm: REALM, username: USERNAME, apiKey: API_KEY, fetch: fetchMock, sleep, ...overrides });

  /** The request as it left the client on the given attempt. */
  const request = (attempt = 0) => fetchMock.mock.calls[attempt][0];
  /** The timeout signal the client handed to fetch, as `init`, on the given attempt. */
  const signal = (attempt = 0) => fetchMock.mock.calls[attempt][1].signal;

  beforeEach(() => {
    fetchMock = vitest.fn();
    sleep = vitest.fn().mockResolvedValue(undefined);
    vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vitest.restoreAllMocks();
  });

  describe('toApiUrl', () => {
    it.each([
      'https://zulip.example.com',
      'https://zulip.example.com/',
      'https://zulip.example.com/api',
      'https://zulip.example.com/api/',
    ])('should normalise %s', (realm) => {
      expect(toApiUrl(realm)).toBe('https://zulip.example.com/api/v1');
    });

    it('should send requests to the normalised base URL', async () => {
      fetchMock.mockResolvedValue(success({ id: 1 }));

      await newClient({ realm: 'https://zulip.example.com/api/' }).POST('/messages', { body: message });

      expect(request().url).toBe('https://zulip.example.com/api/v1/messages');
    });
  });

  describe('encodeForm', () => {
    it('should leave strings as they are', () => {
      expect(encodeForm({ content: 'hello world & more' })).toBe('content=hello+world+%26+more');
    });

    it('should JSON-encode numbers', () => {
      expect(encodeForm({ to: 54 })).toBe('to=54');
    });

    it('should JSON-encode booleans', () => {
      expect(encodeForm({ read_by_sender: true, apply_markdown: false })).toBe(
        'read_by_sender=true&apply_markdown=false',
      );
    });

    it('should JSON-encode arrays instead of exploding them', () => {
      expect(encodeForm({ to: [9, 10] })).toBe('to=%5B9%2C10%5D');
      expect(encodeForm({ event_types: ['message', 'reaction'] })).toBe(
        'event_types=%5B%22message%22%2C%22reaction%22%5D',
      );
    });

    it('should JSON-encode objects', () => {
      expect(encodeForm({ client_capabilities: { notification_settings_null: true } })).toBe(
        'client_capabilities=%7B%22notification_settings_null%22%3Atrue%7D',
      );
    });

    it('should omit undefined', () => {
      expect(encodeForm({ content: 'hi', topic: undefined })).toBe('content=hi');
    });
  });

  describe('request bodies', () => {
    it('should send a form-urlencoded body with the string, number, boolean, array and undefined rules', async () => {
      fetchMock.mockResolvedValue(success({ id: 1 }));

      await newClient().POST('/messages', {
        body: {
          type: 'channel',
          to: [9, 10],
          topic: 'a topic',
          content: 'hi there',
          read_by_sender: true,
          local_id: undefined,
        },
      });

      expect(request().method).toBe('POST');
      expect(request().headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      expect(await request().text()).toBe(
        'type=channel&to=%5B9%2C10%5D&topic=a+topic&content=hi+there&read_by_sender=true',
      );
    });

    it('should send no content type without a body', async () => {
      fetchMock.mockResolvedValue(
        success({ messages: [], found_anchor: true, found_newest: true, found_oldest: false, history_limited: false }),
      );

      await newClient().GET('/messages', { params: { query: { anchor: 'newest', num_before: 1, num_after: 0 } } });

      expect(request().method).toBe('GET');
      expect(request().headers.get('content-type')).toBeNull();
    });
  });

  describe('query strings', () => {
    it('should JSON-encode numbers, booleans and arrays instead of exploding them', async () => {
      fetchMock.mockResolvedValue(
        success({ messages: [], found_anchor: true, found_newest: true, found_oldest: false, history_limited: false }),
      );
      const narrow = [{ operator: 'channel', operand: 54 }];

      await newClient().GET('/messages', {
        params: {
          query: {
            anchor: 'newest',
            num_before: 10,
            num_after: 0,
            apply_markdown: false,
            // 12.3 declares `narrow` as a JSON string; the serializer must still encode a raw array as one value.
            narrow: narrow as unknown as string,
            message_ids: undefined,
          },
        },
      });

      const { pathname, searchParams } = new URL(request().url);
      expect(pathname).toBe('/api/v1/messages');
      expect([...searchParams.keys()]).toEqual(['anchor', 'num_before', 'num_after', 'apply_markdown', 'narrow']);
      expect(searchParams.get('anchor')).toBe('newest');
      expect(searchParams.get('num_before')).toBe('10');
      expect(searchParams.get('apply_markdown')).toBe('false');
      expect(searchParams.getAll('narrow')).toEqual([JSON.stringify(narrow)]);
    });
  });

  describe('multipart', () => {
    it('should send a part with a filename and an image content type, and let fetch set the boundary', async () => {
      fetchMock.mockResolvedValue(success());
      const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'catjam.png', { type: 'image/png' });

      await newClient().POST('/realm/emoji/{emoji_name}', {
        params: { path: { emoji_name: 'catjam' } },
        ...multipart({ filename: file }),
      });

      expect(request().url).toBe('https://zulip.example.com/api/v1/realm/emoji/catjam');
      expect(request().headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);

      const form = await request().formData();
      expect([...form.keys()]).toEqual(['filename']);
      const part = form.get('filename') as File;
      expect(part).toBeInstanceOf(File);
      expect(part.name).toBe('catjam.png');
      expect(part.type).toBe('image/png');
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    });
  });

  describe('authentication', () => {
    it('should send HTTP Basic credentials for each identity', async () => {
      fetchMock.mockImplementation(async () => success({ id: 1 }));
      const bot = newClient();
      const user = newClient({ username: 'human@example.com', apiKey: 'another-key' });

      await bot.POST('/messages', { body: message });
      await user.POST('/messages', { body: message });

      expect(request(0).headers.get('authorization')).toBe(BASIC);
      expect(request(1).headers.get('authorization')).toBe(
        `Basic ${Buffer.from('human@example.com:another-key').toString('base64')}`,
      );
    });
  });

  describe('errors', () => {
    it('should resolve with the data on success', async () => {
      fetchMock.mockResolvedValue(success({ id: 42 }));

      const { data, response } = await newClient().POST('/messages', { body: message });

      expect(data?.id).toBe(42);
      expect(response.status).toBe(200);
    });

    it('should throw a typed error with code, msg and status on a non-2xx response', async () => {
      fetchMock.mockResolvedValue(failure(400, 'BAD_REQUEST', 'Invalid channel ID'));

      const promise = newClient().POST('/messages', { body: message });

      await expect(promise).rejects.toBeInstanceOf(ZulipApiError);
      await expect(promise).rejects.toMatchObject({
        name: 'ZulipApiError',
        status: 400,
        code: 'BAD_REQUEST',
        msg: 'Invalid channel ID',
        message: 'Zulip POST /api/v1/messages failed with 400 BAD_REQUEST: Invalid channel ID',
      });
    });

    it('should throw when a 2xx response carries result: "error"', async () => {
      fetchMock.mockResolvedValue(json({ result: 'error', code: 'BAD_REQUEST', msg: 'Nope' }));

      await expect(newClient().POST('/messages', { body: message })).rejects.toMatchObject({
        status: 200,
        code: 'BAD_REQUEST',
        msg: 'Nope',
      });
    });

    it('should throw on a non-JSON failure, such as a proxy error page', async () => {
      fetchMock.mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }));

      await expect(newClient().POST('/messages', { body: message })).rejects.toMatchObject({
        status: 502,
        code: 'UNKNOWN_ERROR',
        msg: 'Bad Gateway',
      });
    });

    it('should not retry a 5xx', async () => {
      fetchMock.mockResolvedValue(failure(500, 'INTERNAL_ERROR', 'Internal server error'));

      await expect(newClient().POST('/messages', { body: message })).rejects.toMatchObject({ status: 500 });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    });

    it('should reject on a network error', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(newClient().POST('/messages', { body: message })).rejects.toThrow('fetch failed');
    });
  });

  describe('rate limits', () => {
    it('should wait retry-after seconds from the body and retry after a 429', async () => {
      fetchMock.mockResolvedValueOnce(rateLimited(1.5)).mockResolvedValueOnce(success({ id: 7 }));

      const { data } = await newClient().POST('/messages', { body: message });

      expect(data?.id).toBe(7);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledOnce();
      expect(sleep).toHaveBeenCalledWith(1500);
    });

    it('should fall back to the Retry-After header', async () => {
      fetchMock
        .mockResolvedValueOnce(rateLimited(undefined, { 'retry-after': '2' }))
        .mockResolvedValueOnce(success({ id: 7 }));

      await newClient().POST('/messages', { body: message });

      expect(sleep).toHaveBeenCalledWith(2000);
    });

    it('should re-send the body on every attempt', async () => {
      const bodies: string[] = [];
      fetchMock.mockImplementation(async (request) => {
        bodies.push(await request.text());
        return bodies.length < 3 ? rateLimited(1) : success({ id: 7 });
      });

      await newClient().POST('/messages', { body: message });

      expect(bodies).toEqual([
        'type=channel&to=54&topic=release&content=hello+world',
        'type=channel&to=54&topic=release&content=hello+world',
        'type=channel&to=54&topic=release&content=hello+world',
      ]);
    });

    it('should give up after the bounded number of attempts and throw the rate limit error', async () => {
      fetchMock.mockImplementation(async () => rateLimited(1));

      await expect(newClient({ maxAttempts: 3 }).POST('/messages', { body: message })).rejects.toMatchObject({
        status: 429,
        code: 'RATE_LIMIT_HIT',
        msg: 'API usage exceeded rate limit',
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('should not wait longer than the bounded maximum', async () => {
      fetchMock.mockImplementation(async () => rateLimited(120));

      await expect(newClient({ maxRetryAfterMs: 30_000 }).POST('/messages', { body: message })).rejects.toMatchObject({
        status: 429,
        code: 'RATE_LIMIT_HIT',
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  describe('rate-limit budget', () => {
    const NOW = new Date('2026-09-23T12:00:00Z');
    const budget = (remaining: number, resetInSeconds: number, serverNow = NOW) =>
      json(
        { result: 'success', msg: '', id: 7 },
        {
          headers: {
            'content-type': 'application/json',
            date: serverNow.toUTCString(),
            'x-ratelimit-limit': '200',
            'x-ratelimit-remaining': String(remaining),
            'x-ratelimit-reset': String(Math.floor(serverNow.getTime() / 1000) + resetInSeconds),
          },
        },
      );
    const post = (client: ReturnType<typeof newClient>, signal?: AbortSignal) =>
      client.POST('/messages', { body: message, signal });

    beforeEach(() => {
      vitest.useFakeTimers({ now: NOW });
    });

    afterEach(() => {
      vitest.useRealTimers();
    });

    it('should hold every request until the reset once a response says the budget is spent', async () => {
      fetchMock.mockResolvedValueOnce(budget(0, 60)).mockImplementation(async () => budget(199, 60));
      const client = newClient({ sleep: undefined });

      await post(client);
      const next = post(client);
      const after = post(client);
      await vitest.advanceTimersByTimeAsync(59_999);
      expect(fetchMock).toHaveBeenCalledOnce();

      await vitest.advanceTimersByTimeAsync(1);
      await expect(next).resolves.toMatchObject({ data: { id: 7 } });
      await after;
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(Logger.prototype.warn).toHaveBeenCalledExactlyOnceWith(
        'The Zulip rate limit is used up after POST /api/v1/messages; requests wait 60000ms for it to reset',
      );
    });

    it('should not wait while some budget remains, or without the headers', async () => {
      fetchMock.mockResolvedValueOnce(budget(1, 60)).mockImplementation(async () => success());
      const client = newClient({ sleep: undefined });

      await post(client);
      await post(client);
      await post(client);

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('should share the budget of one identity between its clients', async () => {
      const rateLimit = new ZulipRateLimit();
      fetchMock.mockResolvedValueOnce(budget(0, 30)).mockImplementation(async () => success());

      await post(newClient({ sleep: undefined, rateLimit }));
      const other = post(newClient({ sleep: undefined, rateLimit }));
      await vitest.advanceTimersByTimeAsync(29_000);
      expect(fetchMock).toHaveBeenCalledOnce();

      await vitest.advanceTimersByTimeAsync(1000);
      await other;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("should read the reset against the server's clock, and wait at most a minute", async () => {
      const rateLimit = new ZulipRateLimit();
      rateLimit.note(budget(0, 20, new Date(NOW.getTime() - 60 * 60 * 1000)));
      expect(rateLimit.wait()).toBe(20_000);

      rateLimit.note(budget(0, 3600));
      expect(rateLimit.wait()).toBe(60_000);
    });

    it('should stop waiting when the caller gives up on the request', async () => {
      fetchMock.mockImplementation(async () => budget(0, 60));
      const client = newClient({ sleep: undefined });
      await post(client);
      const controller = new AbortController();

      const waiting = post(client, controller.signal);
      const rejected = expect(waiting).rejects.toThrow('shutting down');
      await vitest.advanceTimersByTimeAsync(1000);
      controller.abort(new Error('shutting down'));

      await rejected;
      expect(fetchMock).toHaveBeenCalledOnce();
      await expect(post(client, controller.signal)).rejects.toThrow('shutting down');
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('should still retry a 429 after its retry-after', async () => {
      fetchMock
        .mockResolvedValueOnce(
          rateLimited(0.25, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW.getTime() / 1000) }),
        )
        .mockImplementation(async () => success({ id: 7 }));

      const request = post(newClient({ sleep: undefined }));
      await vitest.advanceTimersByTimeAsync(250);

      await expect(request).resolves.toMatchObject({ data: { id: 7 } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('timeout', () => {
    it('should abort a request that takes longer than the timeout', async () => {
      fetchMock.mockImplementation(
        (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
      );

      const promise = newClient({ timeoutMs: 20 }).POST('/messages', { body: message });

      await expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(signal().aborted).toBe(true);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('should hand fetch the signal as init rather than through the Request', async () => {
      fetchMock.mockImplementation(async () => success({ id: 1 }));

      await newClient().POST('/messages', { body: message });

      expect(signal()).toBeInstanceOf(AbortSignal);
      expect(request().signal).not.toBe(signal());
    });

    it('should give every attempt a fresh, unaborted signal', async () => {
      fetchMock.mockResolvedValueOnce(rateLimited(1)).mockResolvedValueOnce(success({ id: 1 }));

      await newClient().POST('/messages', { body: message });

      expect(signal(0).aborted).toBe(false);
      expect(signal(1).aborted).toBe(false);
      expect(signal(0)).not.toBe(signal(1));
    });

    it("should abort the attempt when the request's own signal aborts, with its reason", async () => {
      fetchMock.mockImplementation(
        (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
      );
      const controller = new AbortController();

      const promise = newClient().GET('/events', {
        params: { query: { queue_id: 'q1', last_event_id: -1 } },
        signal: controller.signal,
      });
      await vitest.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      controller.abort(new Error('shutting down'));

      await expect(promise).rejects.toThrow('shutting down');
      expect(signal().aborted).toBe(true);
      expect(signal().reason).toBeInstanceOf(Error);
    });

    it('should still time out a request whose own signal is live', async () => {
      fetchMock.mockImplementation(
        (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
      );
      const controller = new AbortController();

      const promise = newClient({ timeoutMs: 20 }).GET('/events', {
        params: { query: { queue_id: 'q1', last_event_id: -1 } },
        signal: controller.signal,
      });

      await expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(controller.signal.aborted).toBe(false);
    });
  });

  describe('timeout against a real server', () => {
    // A mocked fetch cannot catch this regression: undici holds a signal routed through the `Request` constructor only
    // weakly, so the abort is lost once the GC runs. Each test keeps the GC busy while the request is in flight.
    let server: Server;
    let realm: string;

    const listen = async (handler: RequestListener) => {
      server = createServer(handler);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      realm = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };

    const churnUntilSettled = async (promise: Promise<unknown>) => {
      let settled = false;
      promise.then(
        () => (settled = true),
        () => (settled = true),
      );
      const junk: number[][] = [];
      while (!settled) {
        junk.push(new Array<number>(50_000).fill(Math.random()));
        if (junk.length > 40) {
          junk.length = 0;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    };

    const post = () =>
      createZulipClient({ realm, username: USERNAME, apiKey: API_KEY, timeoutMs: 200, sleep }).POST('/messages', {
        body: message,
      });

    afterEach(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('should abort when the server accepts the request and never answers', { timeout: 10_000 }, async () => {
      await listen(() => {});

      const promise = post();
      await churnUntilSettled(promise);

      await expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });
    });

    it('should abort when the server trickles the body forever', { timeout: 10_000 }, async () => {
      await listen((_, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"result":"success","msg":"","id":1');
        const trickle = setInterval(() => response.write(' '), 20);
        response.on('close', () => clearInterval(trickle));
      });

      const promise = post();
      await churnUntilSettled(promise);

      await expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });
    });
  });

  describe('logging', () => {
    const logged = () =>
      [
        ...vitest.mocked(Logger.prototype.log).mock.calls,
        ...vitest.mocked(Logger.prototype.warn).mock.calls,
        ...vitest.mocked(Logger.prototype.error).mock.calls,
        ...vitest.mocked(Logger.prototype.debug).mock.calls,
        ...vitest.mocked(Logger.prototype.verbose).mock.calls,
      ].map((args) => args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));

    beforeEach(() => {
      for (const method of ['log', 'error', 'debug', 'verbose'] as const) {
        vitest.spyOn(Logger.prototype, method).mockImplementation(() => {});
      }
    });

    it('should log a retry without the Authorization header or the credentials', async () => {
      fetchMock.mockResolvedValueOnce(rateLimited(1)).mockResolvedValueOnce(success({ id: 7 }));

      await newClient().POST('/messages', { body: message });

      const lines = logged();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('POST /api/v1/messages');
      for (const line of lines) {
        expect(line).not.toContain('Authorization');
        expect(line).not.toContain('authorization');
        expect(line).not.toContain(BASIC);
        expect(line).not.toContain(API_KEY);
      }
    });

    it('should keep the credentials out of the thrown error', async () => {
      fetchMock.mockResolvedValue(failure(401, 'UNAUTHORIZED', 'Invalid API key'));

      const error = await newClient()
        .POST('/messages', { body: message })
        .then(() => undefined)
        .catch((error: unknown) => error as ZulipApiError);

      const serialised = `${String(error)} ${error?.stack} ${JSON.stringify(error)}`;
      expect(error?.msg).toBe('Invalid API key');
      expect(serialised).not.toContain(BASIC);
      expect(serialised).not.toContain(API_KEY);
      expect(serialised).not.toContain('Authorization');
      expect(logged()).toEqual([]);
    });
  });
});
