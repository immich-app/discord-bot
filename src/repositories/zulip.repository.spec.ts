import { ZulipConfig } from 'src/interfaces/zulip.interface';
import { ZulipApiError } from 'src/repositories/zulip.client';
import { ZulipRepository } from 'src/repositories/zulip.repository';
import { Mock, afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

const config: ZulipConfig = {
  realm: 'https://zulip.example.com',
  bot: { username: 'bot@example.com', apiKey: 'bot-key' },
  user: { username: 'human@example.com', apiKey: 'user-key' },
};

const basic = ({ username, apiKey }: { username: string; apiKey: string }) =>
  `Basic ${Buffer.from(`${username}:${apiKey}`).toString('base64')}`;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const image = (type = 'image/png') => new Response(PNG, { status: 200, headers: { 'content-type': type } });

describe('ZulipRepository', () => {
  let sut: ZulipRepository;
  let fetchMock: Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;

  /** The i-th call, as a `Request` regardless of how it was made. */
  const request = (index: number) => {
    const [input, init] = fetchMock.mock.calls[index];
    return input instanceof Request ? input : new Request(input, init);
  };

  beforeEach(() => {
    fetchMock = vitest.fn();
    vitest.stubGlobal('fetch', fetchMock);
    sut = new ZulipRepository();
  });

  afterEach(() => {
    vitest.unstubAllGlobals();
  });

  describe('before init', () => {
    it('should report itself as not initialised', () => {
      expect(sut.isInitialised()).toBe(false);
    });

    it('should throw a clear error from sendMessage', async () => {
      await expect(sut.sendMessage({ stream: 54, topic: 'release', content: 'hi' })).rejects.toThrow(
        'Zulip client not initialised',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should throw a clear error from createEmote', async () => {
      await expect(sut.createEmote('catJAM', 'https://example.com/catJAM.png')).rejects.toThrow(
        'Zulip client not initialised',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    beforeEach(async () => {
      await sut.init(config);
    });

    it('should report itself as initialised', () => {
      expect(sut.isInitialised()).toBe(true);
    });

    it('should post a channel message as the bot and return the message ID', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '', id: 42 }));

      await expect(sut.sendMessage({ stream: 54, topic: 'release', content: 'v1.2.0 is out' })).resolves.toEqual({
        id: 42,
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(request(0).method).toBe('POST');
      expect(request(0).url).toBe('https://zulip.example.com/api/v1/messages');
      expect(request(0).headers.get('authorization')).toBe(basic(config.bot));
      expect(request(0).headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      expect(await request(0).text()).toBe('type=channel&to=54&topic=release&content=v1.2.0+is+out');
    });

    it('should omit the topic when there is none', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '', id: 1 }));

      await sut.sendMessage({ stream: 'general', content: 'hi' });

      expect(await request(0).text()).toBe('type=channel&to=general&content=hi');
    });

    it('should throw on a Zulip error instead of resolving', async () => {
      fetchMock.mockResolvedValue(
        json(
          { result: 'error', code: 'STREAM_DOES_NOT_EXIST', msg: "Channel with ID '54' does not exist" },
          { status: 400 },
        ),
      );

      const promise = sut.sendMessage({ stream: 54, topic: 'release', content: 'hi' });

      await expect(promise).rejects.toBeInstanceOf(ZulipApiError);
      await expect(promise).rejects.toMatchObject({ status: 400, code: 'STREAM_DOES_NOT_EXIST' });
    });
  });

  describe('createEmote', () => {
    beforeEach(async () => {
      await sut.init(config);
    });

    it('should fetch the image and upload it as the user, lowercased, with a filename and content type', async () => {
      fetchMock.mockResolvedValueOnce(image('image/png')).mockResolvedValueOnce(json({ result: 'success', msg: '' }));

      await sut.createEmote('catJAM', 'https://example.com/catJAM.png');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(request(0).url).toBe('https://example.com/catJAM.png');
      expect(request(0).headers.get('authorization')).toBeNull();

      const upload = request(1);
      expect(upload.method).toBe('POST');
      expect(upload.url).toBe('https://zulip.example.com/api/v1/realm/emoji/catjam');
      expect(upload.headers.get('authorization')).toBe(basic(config.user));
      expect(upload.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);

      const part = (await upload.formData()).get('filename') as File;
      expect(part).toBeInstanceOf(File);
      expect(part.name).toBe('catjam.png');
      expect(part.type).toBe('image/png');
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(PNG);
    });

    it('should name the file after the content type, ignoring the URL', async () => {
      fetchMock
        .mockResolvedValueOnce(image('image/gif; charset=binary'))
        .mockResolvedValueOnce(json({ result: 'success', msg: '' }));

      await sut.createEmote('pepeD', 'https://cdn.betterttv.net/emote/5f1b0186cf6d2144653d2970/3x');

      const part = (await request(1).formData()).get('filename') as File;
      expect(part.name).toBe('peped.gif');
      expect(part.type).toBe('image/gif');
    });

    it('should fall back to the URL extension for an unknown content type', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response(PNG, { status: 200 }))
        .mockResolvedValueOnce(json({ result: 'success', msg: '' }));

      await sut.createEmote('catJAM', 'https://example.com/catJAM.webp');

      const part = (await request(1).formData()).get('filename') as File;
      expect(part.name).toBe('catjam.webp');
    });

    it('should throw when the image cannot be fetched and not upload anything', async () => {
      fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));

      await expect(sut.createEmote('catJAM', 'https://example.com/catJAM.png')).rejects.toThrow(
        'Could not fetch emote image https://example.com/catJAM.png: 404',
      );

      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('should throw when the upload fails', async () => {
      fetchMock
        .mockResolvedValueOnce(image())
        .mockResolvedValueOnce(
          json(
            { result: 'error', code: 'BAD_REQUEST', msg: 'This endpoint does not accept bot requests' },
            { status: 400 },
          ),
        );

      const promise = sut.createEmote('catJAM', 'https://example.com/catJAM.png');

      await expect(promise).rejects.toBeInstanceOf(ZulipApiError);
      await expect(promise).rejects.toMatchObject({
        status: 400,
        code: 'BAD_REQUEST',
        msg: 'This endpoint does not accept bot requests',
      });
    });
  });
});
