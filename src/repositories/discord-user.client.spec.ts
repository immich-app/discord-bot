import { DiscordAPIError, HTTPError } from 'discord.js';
import { DiscordUserClient } from 'src/repositories/discord-user.client';
import { afterEach, beforeEach, describe, expect, it, Mock, vitest } from 'vitest';

const CHANNEL = '100000000000000001';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe(DiscordUserClient.name, () => {
  let fetchImpl: Mock<typeof fetch>;
  let sut: DiscordUserClient;

  beforeEach(() => {
    fetchImpl = vitest.fn();
    sut = new DiscordUserClient('user-token', fetchImpl);
  });

  afterEach(() => {
    vitest.useRealTimers();
  });

  it('should wait out a 429 for as long as Discord says, then ask again', async () => {
    vitest.useFakeTimers();
    fetchImpl
      .mockResolvedValueOnce(json({ message: 'You are being rate limited.', retry_after: 1.5, global: false }, 429))
      .mockResolvedValueOnce(json([{ id: '1' }]));

    const page = sut.getMessages(CHANNEL, { limit: 1 });
    await vitest.advanceTimersByTimeAsync(1499);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await vitest.advanceTimersByTimeAsync(1);

    await expect(page).resolves.toEqual([{ id: '1' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('should give up on a 429 after three attempts, or at once when the wait is over a minute', async () => {
    vitest.useFakeTimers();
    const limited = (seconds: number) => json({ message: 'You are being rate limited.', retry_after: seconds }, 429);
    fetchImpl.mockImplementation(async () => limited(0.01));

    const page = sut.getMessages(CHANNEL, { limit: 1 });
    const failed = expect(page).rejects.toBeInstanceOf(HTTPError);
    await vitest.runAllTimersAsync();
    await failed;
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    fetchImpl.mockReset().mockImplementation(async () => limited(120));
    await expect(sut.getMessages(CHANNEL, { limit: 1 })).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('should hold the next request of a channel whose budget is spent until it is back', async () => {
    vitest.useFakeTimers();
    fetchImpl.mockImplementation(async () =>
      json([], 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2' }),
    );

    await sut.getMessages(CHANNEL, { limit: 1 });
    const next = sut.getMessages(CHANNEL, { limit: 1 });
    await vitest.advanceTimersByTimeAsync(1999);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await vitest.advanceTimersByTimeAsync(1);
    await next;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("should reject with Discord's error, or the status when the answer is not Discord's", async () => {
    fetchImpl.mockResolvedValueOnce(json({ code: 10_003, message: 'Unknown Channel' }, 404));
    await expect(sut.getMessages(CHANNEL, { limit: 1 })).rejects.toSatisfy(
      (error) => error instanceof DiscordAPIError && error.code === 10_003 && error.status === 404,
    );

    fetchImpl.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(sut.getMessages(CHANNEL, { limit: 1 })).rejects.toSatisfy(
      (error) => error instanceof HTTPError && error.status === 502,
    );
  });

  it('should hand on the reason a request never got an answer, where the outage checks look for it', async () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    fetchImpl.mockRejectedValueOnce(new TypeError('fetch failed', { cause: reset }));

    await expect(sut.getMessages(CHANNEL, { limit: 1 })).rejects.toBe(reset);
  });
});
