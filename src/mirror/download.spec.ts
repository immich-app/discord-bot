import { DISCORD_ATTACHMENT_ORIGINS, downloadDiscordAttachment, readAtMost } from 'src/mirror/download';
import { afterEach, beforeEach, describe, expect, it, Mock, vitest } from 'vitest';

const attachment = {
  url: 'https://cdn.discordapp.com/attachments/1/2/log.txt?ex=1&is=2&hm=3',
  name: 'log.txt',
  contentType: 'text/plain',
};

const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });

describe('readAtMost', () => {
  it('should read the whole body', async () => {
    const bytes = await readAtMost(stream('ab', 'cd'), 4);
    expect(new TextDecoder().decode(bytes)).toBe('abcd');
  });

  it('should give up once the body runs past the limit', async () => {
    await expect(readAtMost(stream('ab', 'cde'), 4)).resolves.toBeUndefined();
  });

  it('should read a missing body as empty', async () => {
    await expect(readAtMost(null, 4)).resolves.toEqual(new Uint8Array());
  });
});

describe('downloadDiscordAttachment', () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vitest.fn();
    vitest.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vitest.unstubAllGlobals();
  });

  it('should download an attachment from the Discord CDN, following redirects, with a timeout', async () => {
    fetchMock.mockResolvedValue(new Response('hello', { headers: { 'content-type': 'application/octet-stream' } }));

    const file = await downloadDiscordAttachment(attachment, 100);

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(new URL(attachment.url), {
      redirect: 'follow',
      signal: expect.any(AbortSignal),
    });
    expect(file?.name).toBe('log.txt');
    expect(file?.type).toBe('text/plain');
    expect(await file?.text()).toBe('hello');
  });

  it("should give up when the caller's deadline passes", async () => {
    fetchMock.mockResolvedValue(new Response('hello'));
    const deadline = new AbortController();

    await downloadDiscordAttachment(attachment, 100, deadline.signal);
    deadline.abort();

    expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });

  it('should take the type from the answer when Discord gave none', async () => {
    fetchMock.mockResolvedValue(new Response('hello', { headers: { 'content-type': 'image/png' } }));

    const file = await downloadDiscordAttachment({ ...attachment, contentType: null }, 100);

    expect(file?.type).toBe('image/png');
  });

  it.each([
    'https://evil.example/attachments/1/2/log.txt',
    'http://cdn.discordapp.com/attachments/1/2/log.txt',
    'https://cdn.discordapp.com.evil.example/log.txt',
  ])('should refuse %s without fetching it', async (url) => {
    await expect(downloadDiscordAttachment({ ...attachment, url }, 100)).rejects.toThrow(
      'Not a Discord attachment URL',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should accept the media proxy', async () => {
    fetchMock.mockResolvedValue(new Response('hello'));

    await downloadDiscordAttachment({ ...attachment, url: 'https://media.discordapp.net/attachments/1/2/a.png' }, 100);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(DISCORD_ATTACHMENT_ORIGINS.has('https://media.discordapp.net')).toBe(true);
  });

  it('should reject an answer that is not the file', async () => {
    fetchMock.mockResolvedValue(new Response('gone', { status: 404 }));

    await expect(downloadDiscordAttachment(attachment, 100)).rejects.toThrow(
      'Discord answered the attachment download with status 404',
    );
  });

  it('should not read a body announced as too large', async () => {
    fetchMock.mockResolvedValue(new Response('hello', { headers: { 'content-length': '101' } }));

    await expect(downloadDiscordAttachment(attachment, 100)).resolves.toBeUndefined();
  });

  it('should stop reading a body that runs past the limit', async () => {
    fetchMock.mockResolvedValue(new Response(stream('hello', 'world')));

    await expect(downloadDiscordAttachment(attachment, 7)).resolves.toBeUndefined();
  });
});
