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

    it.each([
      { method: 'getMessage', call: () => sut.getMessage(1) },
      { method: 'updateMessage', call: () => sut.updateMessage(1, { content: 'x' }) },
      { method: 'listEmoji', call: () => sut.listEmoji() },
      { method: 'getSubscriptions', call: () => sut.getSubscriptions() },
    ])('should throw a clear error from $method', async ({ call }) => {
      await expect(call()).rejects.toThrow('Zulip client not initialised');
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

  describe('getMessage', () => {
    beforeEach(async () => {
      await sut.init(config);
    });

    it('should fetch the message as the bot and return its ID and current topic', async () => {
      fetchMock.mockResolvedValue(
        json({
          result: 'success',
          msg: '',
          raw_content: 'hello',
          message: { id: 42, subject: '#1234: feat: add thing', content: '<p>hello</p>', type: 'stream' },
        }),
      );

      await expect(sut.getMessage(42)).resolves.toEqual({ id: 42, topic: '#1234: feat: add thing' });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(request(0).method).toBe('GET');
      expect(request(0).url).toBe('https://zulip.example.com/api/v1/messages/42?allow_empty_topic_name=true');
      expect(request(0).headers.get('authorization')).toBe(basic(config.bot));
    });

    it('should return the empty topic as an empty string, not the realm\'s "general chat" display name', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '', message: { id: 42, subject: '' } }));

      await expect(sut.getMessage(42)).resolves.toEqual({ id: 42, topic: '' });
    });

    it('should return the topic a human gave the message since, resolved prefix included', async () => {
      fetchMock.mockResolvedValue(
        json({ result: 'success', msg: '', message: { id: 42, subject: '✔ #1234: something else' } }),
      );

      await expect(sut.getMessage(42)).resolves.toEqual({ id: 42, topic: '✔ #1234: something else' });
    });

    it('should throw on a Zulip error instead of resolving', async () => {
      fetchMock.mockResolvedValue(
        json({ result: 'error', code: 'BAD_REQUEST', msg: 'Invalid message(s)' }, { status: 400 }),
      );

      const promise = sut.getMessage(42);

      await expect(promise).rejects.toBeInstanceOf(ZulipApiError);
      await expect(promise).rejects.toMatchObject({ status: 400, code: 'BAD_REQUEST', msg: 'Invalid message(s)' });
    });
  });

  describe('updateMessage', () => {
    beforeEach(async () => {
      await sut.init(config);
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '' }));
    });

    it('should PATCH the message as the bot, form-encoded', async () => {
      await sut.updateMessage(42, { content: 'edited' });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(request(0).method).toBe('PATCH');
      expect(request(0).url).toBe('https://zulip.example.com/api/v1/messages/42');
      expect(request(0).headers.get('authorization')).toBe(basic(config.bot));
      expect(request(0).headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      expect(await request(0).text()).toBe('content=edited');
    });

    it('should move a whole topic with propagate_mode=change_all and send nothing else', async () => {
      await sut.updateMessage(42, { topic: '✔ #1234: feat: add thing', propagateMode: 'change_all' });

      expect(await request(0).text()).toBe('topic=%E2%9C%94+%231234%3A+feat%3A+add+thing&propagate_mode=change_all');
    });

    it('should throw with the code Zulip answers when a move exceeds the time limit', async () => {
      fetchMock.mockResolvedValue(
        json(
          {
            result: 'error',
            code: 'MOVE_MESSAGES_TIME_LIMIT_EXCEEDED',
            msg: 'You only have permission to move the 2/5 most recent messages in this topic.',
            first_message_id_allowed_to_move: 123,
            total_messages_allowed_to_move: 2,
            total_messages_in_topic: 5,
          },
          { status: 400 },
        ),
      );

      const promise = sut.updateMessage(42, { topic: 'renamed', propagateMode: 'change_all' });

      await expect(promise).rejects.toBeInstanceOf(ZulipApiError);
      await expect(promise).rejects.toMatchObject({ status: 400, code: 'MOVE_MESSAGES_TIME_LIMIT_EXCEEDED' });
    });

    it('should throw with BAD_REQUEST when an edit is refused', async () => {
      fetchMock.mockResolvedValue(
        json(
          { result: 'error', code: 'BAD_REQUEST', msg: 'The time limit for editing this message has past' },
          { status: 400 },
        ),
      );

      await expect(sut.updateMessage(42, { content: 'edited' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        msg: 'The time limit for editing this message has past',
      });
    });
  });

  describe('listEmoji', () => {
    beforeEach(async () => {
      await sut.init(config);
    });

    it('should list every realm emoji as the bot, deactivated ones included', async () => {
      fetchMock.mockResolvedValue(
        json({
          result: 'success',
          msg: '',
          emoji: {
            '1': { id: '1', name: 'green_tick', source_url: '/x/1.png', deactivated: false, author_id: 5 },
            '2': { id: '2', name: 'old', source_url: '/x/2.png', deactivated: true, author_id: 5 },
          },
        }),
      );

      await expect(sut.listEmoji()).resolves.toEqual([
        { name: 'green_tick', deactivated: false },
        { name: 'old', deactivated: true },
      ]);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(request(0).method).toBe('GET');
      expect(request(0).url).toBe('https://zulip.example.com/api/v1/realm/emoji');
      expect(request(0).headers.get('authorization')).toBe(basic(config.bot));
    });

    it('should return an empty list for a realm without custom emoji', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '', emoji: {} }));

      await expect(sut.listEmoji()).resolves.toEqual([]);
    });
  });

  describe('getSubscriptions', () => {
    beforeEach(async () => {
      await sut.init(config);
    });

    it("should list the bot's subscriptions by stream ID", async () => {
      fetchMock.mockResolvedValue(
        json({
          result: 'success',
          msg: '',
          subscriptions: [
            { stream_id: 111, name: 'ImmichThirdParties', color: '#e79ab5' },
            { stream_id: 113, name: 'ImmichAlerts', color: '#bfd56f' },
          ],
        }),
      );

      await expect(sut.getSubscriptions()).resolves.toEqual([{ streamId: 111 }, { streamId: 113 }]);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(request(0).method).toBe('GET');
      expect(request(0).url).toBe('https://zulip.example.com/api/v1/users/me/subscriptions');
      expect(request(0).headers.get('authorization')).toBe(basic(config.bot));
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
