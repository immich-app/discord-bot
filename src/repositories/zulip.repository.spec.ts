import { ZulipConfig, ZulipUploadRefused } from 'src/interfaces/zulip.interface';
import { ZulipApiError, createZulipClient } from 'src/repositories/zulip.client';
import { ZulipRepository, longpollTimeoutMs } from 'src/repositories/zulip.repository';
import { Mock, afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

vitest.mock('src/repositories/zulip.client', async (importActual) => {
  const actual = await importActual<typeof import('src/repositories/zulip.client')>();
  return { ...actual, createZulipClient: vitest.fn(actual.createZulipClient) };
});

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

const live = () => new AbortController().signal;

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
    vitest.mocked(createZulipClient).mockClear();
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
      { method: 'getOwnUser', call: () => sut.getOwnUser() },
      { method: 'getMessages', call: () => sut.getMessages({ stream: 107, topic: 'deploy', numBefore: 10 }) },
      { method: 'registerQueue', call: () => sut.registerQueue() },
      { method: 'getEvents', call: () => sut.getEvents({ queueId: 'q1', lastEventId: -1 }, live()) },
      { method: 'deleteQueue', call: () => sut.deleteQueue('q1') },
      { method: 'deleteMessage', call: () => sut.deleteMessage(1) },
      { method: 'uploadFile', call: () => sut.uploadFile(new File(['x'], 'x.txt')) },
      { method: 'downloadUpload', call: () => sut.downloadUpload('/user_uploads/2/ab/cd/x.txt', 10) },
      { method: 'getStreamMessagesBefore', call: () => sut.getStreamMessagesBefore({ stream: 107, count: 10 }) },
      { method: 'getEmojiCodes', call: () => sut.getEmojiCodes() },
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

    it('should send the notification flags only when they are given', async () => {
      fetchMock.mockImplementation(async () => json({ result: 'success', msg: '' }));

      await sut.updateMessage(42, {
        topic: 'renamed',
        propagateMode: 'change_all',
        sendNotificationToOldThread: false,
        sendNotificationToNewThread: true,
      });
      await sut.updateMessage(42, {
        topic: 'renamed',
        propagateMode: 'change_all',
        sendNotificationToOldThread: false,
      });

      expect(await request(0).text()).toBe(
        'topic=renamed&propagate_mode=change_all&send_notification_to_old_thread=false&send_notification_to_new_thread=true',
      );
      expect(await request(1).text()).toBe(
        'topic=renamed&propagate_mode=change_all&send_notification_to_old_thread=false',
      );
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

  describe('getOwnUser', () => {
    beforeEach(async () => {
      await sut.init(config);
    });

    it("should return the bot's own user ID", async () => {
      fetchMock.mockResolvedValue(
        json({ result: 'success', msg: '', user_id: 7, email: 'bot@example.com', full_name: 'Immich', is_bot: true }),
      );

      await expect(sut.getOwnUser()).resolves.toEqual({ userId: 7, fullName: 'Immich' });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(request(0).method).toBe('GET');
      expect(request(0).url).toBe('https://zulip.example.com/api/v1/users/me');
      expect(request(0).headers.get('authorization')).toBe(basic(config.bot));
    });

    it('should throw when the answer has no user ID, rather than resolve with none', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '', email: 'bot@example.com', is_bot: true }));

      await expect(sut.getOwnUser()).rejects.toThrow('Zulip returned no user ID for the bot');
    });

    it('should return an empty name when the answer has none: the loop needs the ID, only the commands need the name', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '', user_id: 7, email: 'bot@example.com' }));

      await expect(sut.getOwnUser()).resolves.toEqual({ userId: 7, fullName: '' });
    });
  });

  describe('getMessages', () => {
    beforeEach(async () => {
      await sut.init(config);
    });

    it('should ask for the newest messages of the topic as raw markdown, with the narrow as one JSON string', async () => {
      fetchMock.mockResolvedValue(
        json({
          result: 'success',
          msg: '',
          anchor: 10000000000000000,
          found_newest: true,
          messages: [
            {
              id: 490,
              sender_id: 12,
              sender_email: 'alice@example.com',
              sender_full_name: 'Alice',
              type: 'stream',
              stream_id: 107,
              subject: 'deploy',
              content: 'the thumbnails crash',
              timestamp: 1_700_000_000,
              last_moved_timestamp: 1_700_000_500,
              flags: ['read'],
            },
            {
              id: 500,
              sender_id: 12,
              sender_email: 'alice@example.com',
              sender_full_name: 'Alice',
              type: 'stream',
              stream_id: 107,
              subject: 'deploy',
              content: '@**Immich** similar',
              timestamp: 1_700_000_100,
              flags: ['mentioned'],
            },
          ],
        }),
      );

      await expect(sut.getMessages({ stream: 107, topic: 'deploy', numBefore: 10 })).resolves.toEqual([
        {
          id: 490,
          senderId: 12,
          senderEmail: 'alice@example.com',
          senderFullName: 'Alice',
          type: 'stream',
          streamId: 107,
          topic: 'deploy',
          content: 'the thumbnails crash',
          timestamp: 1_700_000_000,
          movedAt: 1_700_000_500,
        },
        {
          id: 500,
          senderId: 12,
          senderEmail: 'alice@example.com',
          senderFullName: 'Alice',
          type: 'stream',
          streamId: 107,
          topic: 'deploy',
          content: '@**Immich** similar',
          timestamp: 1_700_000_100,
          movedAt: undefined,
        },
      ]);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(request(0).method).toBe('GET');
      expect(request(0).headers.get('authorization')).toBe(basic(config.bot));
      const url = new URL(request(0).url);
      expect(url.pathname).toBe('/api/v1/messages');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        anchor: 'newest',
        num_before: '10',
        num_after: '0',
        narrow: JSON.stringify([
          { operator: 'channel', operand: 107 },
          { operator: 'topic', operand: 'deploy' },
        ]),
        apply_markdown: 'false',
      });
    });

    it('should return an empty list for an empty topic', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '', messages: [] }));

      await expect(sut.getMessages({ stream: 107, topic: 'nothing here', numBefore: 10 })).resolves.toEqual([]);
    });

    it('should throw on a Zulip error instead of resolving', async () => {
      fetchMock.mockResolvedValue(
        json(
          { result: 'error', code: 'BAD_REQUEST', msg: 'Invalid narrow operator: unknown operator' },
          { status: 400 },
        ),
      );

      await expect(sut.getMessages({ stream: 107, topic: 'deploy', numBefore: 10 })).rejects.toMatchObject({
        status: 400,
        code: 'BAD_REQUEST',
      });
    });
  });

  describe('registerQueue', () => {
    beforeEach(async () => {
      await sut.init(config);
    });

    it('should register a queue for messages, their edits and bulk deletions, as raw markdown, and return its ID, cursor and subscribed streams', async () => {
      fetchMock.mockResolvedValue(
        json({
          result: 'success',
          msg: '',
          queue_id: 'q1',
          last_event_id: -1,
          event_queue_longpoll_timeout_seconds: 90,
          subscriptions: [
            { stream_id: 107, name: 'immich-general', invite_only: true },
            { stream_id: 54, name: 'immich', invite_only: false },
          ],
        }),
      );

      await expect(sut.registerQueue()).resolves.toEqual({
        queue: { queueId: 'q1', lastEventId: -1 },
        subscribedStreamIds: [107, 54],
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(request(0).method).toBe('POST');
      expect(request(0).url).toBe('https://zulip.example.com/api/v1/register');
      expect(request(0).headers.get('authorization')).toBe(basic(config.bot));
      expect(request(0).headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      expect(await request(0).text()).toBe(
        'event_types=%5B%22message%22%2C%22update_message%22%2C%22delete_message%22%5D&apply_markdown=false&client_capabilities=%7B%22notification_settings_null%22%3Afalse%2C%22bulk_message_deletion%22%3Atrue%7D&fetch_event_types=%5B%22subscription%22%5D',
      );
    });

    it('should carry no streams when the answer lists no subscriptions', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '', queue_id: 'q1', last_event_id: 3 }));

      await expect(sut.registerQueue()).resolves.toEqual({
        queue: { queueId: 'q1', lastEventId: 3 },
        subscribedStreamIds: [],
      });
    });

    it('should not ask for every public stream of the realm', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '', queue_id: 'q1', last_event_id: -1 }));

      await sut.registerQueue();

      expect(await request(0).text()).not.toContain('all_public_streams');
    });

    it('should keep the empty topic and avatars in the form every handler has always seen', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '', queue_id: 'q1', last_event_id: -1 }));

      await sut.registerQueue();

      const body = await request(0).text();
      expect(body).not.toContain('empty_topic_name');
      expect(body).not.toContain('client_gravatar');
    });

    it('should throw when the server registers no queue', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '', queue_id: null, last_event_id: -1 }));

      await expect(sut.registerQueue()).rejects.toThrow('Zulip registered no event queue');
    });

    it('should throw on a Zulip error instead of resolving', async () => {
      fetchMock.mockResolvedValue(
        json({ result: 'error', code: 'BAD_REQUEST', msg: 'Invalid event_types' }, { status: 400 }),
      );

      await expect(sut.registerQueue()).rejects.toMatchObject({ status: 400, code: 'BAD_REQUEST' });
    });
  });

  describe('getEvents', () => {
    beforeEach(async () => {
      await sut.init(config);
    });

    it('should long-poll the queue from the cursor as the bot', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '', events: [] }));

      await expect(sut.getEvents({ queueId: 'q1', lastEventId: 41 }, live())).resolves.toEqual([]);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(request(0).method).toBe('GET');
      expect(request(0).url).toBe('https://zulip.example.com/api/v1/events?queue_id=q1&last_event_id=41');
      expect(request(0).headers.get('authorization')).toBe(basic(config.bot));
    });

    it('should return a message event with the fields a handler needs and any other event by ID and type', async () => {
      fetchMock.mockResolvedValue(
        json({
          result: 'success',
          msg: '',
          events: [
            { id: 3, type: 'heartbeat' },
            {
              id: 4,
              type: 'message',
              flags: [],
              message: {
                id: 500,
                sender_id: 12,
                sender_email: 'alice@example.com',
                sender_full_name: 'Alice',
                type: 'stream',
                stream_id: 107,
                display_recipient: 'immich-general',
                subject: 'thumbnails',
                content: 'see #4242',
                timestamp: 1_700_000_000,
                client: 'website',
              },
            },
            {
              id: 5,
              type: 'message',
              flags: [],
              message: { id: 501, sender_id: 12, type: 'private', display_recipient: [], subject: '', content: 'hi' },
            },
          ],
        }),
      );

      await expect(sut.getEvents({ queueId: 'q1', lastEventId: -1 }, live())).resolves.toEqual([
        { id: 3, type: 'heartbeat' },
        {
          id: 4,
          type: 'message',
          message: {
            id: 500,
            senderId: 12,
            senderEmail: 'alice@example.com',
            senderFullName: 'Alice',
            type: 'stream',
            streamId: 107,
            topic: 'thumbnails',
            content: 'see #4242',
            timestamp: 1_700_000_000,
            movedAt: undefined,
          },
        },
        {
          id: 5,
          type: 'message',
          message: {
            id: 501,
            senderId: 12,
            senderEmail: '',
            senderFullName: '',
            type: 'private',
            streamId: undefined,
            topic: '',
            content: 'hi',
            timestamp: 0,
            movedAt: undefined,
          },
        },
      ]);
    });

    it('should return an edit, a move and a preview with the fields a handler needs', async () => {
      fetchMock.mockResolvedValue(
        json({
          result: 'success',
          msg: '',
          events: [
            {
              id: 6,
              type: 'update_message',
              user_id: 12,
              rendering_only: false,
              message_id: 500,
              message_ids: [500],
              flags: [],
              edit_timestamp: 1_700_000_100,
              stream_id: 107,
              orig_content: 'see #4242',
              content: 'see #4243',
              rendered_content: '<p>see #4243</p>',
              is_me_message: false,
            },
            {
              id: 7,
              type: 'update_message',
              user_id: 13,
              rendering_only: false,
              message_id: 500,
              message_ids: [498, 500, 502],
              flags: [],
              edit_timestamp: 1_700_000_200,
              stream_id: 107,
              new_stream_id: 108,
              propagate_mode: 'change_all',
              orig_subject: 'thumbnails',
              subject: '✔ thumbnails',
              topic_links: [],
            },
            {
              id: 8,
              type: 'update_message',
              user_id: null,
              rendering_only: true,
              message_id: 500,
              message_ids: [500],
              flags: [],
              edit_timestamp: 1_700_000_300,
              content: 'see https://example.com',
              rendered_content: '<p>preview</p>',
            },
          ],
        }),
      );

      await expect(sut.getEvents({ queueId: 'q1', lastEventId: -1 }, live())).resolves.toEqual([
        {
          id: 6,
          type: 'update_message',
          update: {
            userId: 12,
            renderingOnly: false,
            messageId: 500,
            messageIds: [500],
            streamId: 107,
            newStreamId: undefined,
            origTopic: undefined,
            topic: undefined,
            propagateMode: undefined,
            content: 'see #4243',
          },
        },
        {
          id: 7,
          type: 'update_message',
          update: {
            userId: 13,
            renderingOnly: false,
            messageId: 500,
            messageIds: [498, 500, 502],
            streamId: 107,
            newStreamId: 108,
            origTopic: 'thumbnails',
            topic: '✔ thumbnails',
            propagateMode: 'change_all',
            content: undefined,
          },
        },
        {
          id: 8,
          type: 'update_message',
          update: {
            userId: null,
            renderingOnly: true,
            messageId: 500,
            messageIds: [500],
            streamId: undefined,
            newStreamId: undefined,
            origTopic: undefined,
            topic: undefined,
            propagateMode: undefined,
            content: 'see https://example.com',
          },
        },
      ]);
    });

    it('should return a deletion as a list of IDs, whether it came in bulk or for one message', async () => {
      fetchMock.mockResolvedValue(
        json({
          result: 'success',
          msg: '',
          events: [
            {
              id: 9,
              type: 'delete_message',
              message_type: 'stream',
              message_ids: [500, 501],
              stream_id: 107,
              topic: 'x',
            },
            { id: 10, type: 'delete_message', message_type: 'stream', message_id: 502, stream_id: 107, topic: 'y' },
            { id: 11, type: 'delete_message', message_type: 'private', message_ids: [503] },
            { id: 12, type: 'delete_message', message_type: 'private' },
          ],
        }),
      );

      await expect(sut.getEvents({ queueId: 'q1', lastEventId: -1 }, live())).resolves.toEqual([
        { id: 9, type: 'delete_message', deletion: { messageIds: [500, 501], streamId: 107, topic: 'x' } },
        { id: 10, type: 'delete_message', deletion: { messageIds: [502], streamId: 107, topic: 'y' } },
        { id: 11, type: 'delete_message', deletion: { messageIds: [503], streamId: undefined, topic: undefined } },
        { id: 12, type: 'delete_message', deletion: { messageIds: [], streamId: undefined, topic: undefined } },
      ]);
    });

    it('should reject with the BAD_EVENT_QUEUE_ID code when the queue is gone', async () => {
      fetchMock.mockResolvedValue(
        json(
          { result: 'error', code: 'BAD_EVENT_QUEUE_ID', msg: 'Bad event queue ID: q1', queue_id: 'q1' },
          { status: 400 },
        ),
      );

      const promise = sut.getEvents({ queueId: 'q1', lastEventId: -1 }, live());

      await expect(promise).rejects.toBeInstanceOf(ZulipApiError);
      await expect(promise).rejects.toMatchObject({ status: 400, code: 'BAD_EVENT_QUEUE_ID' });
    });

    it('should cancel the poll in flight when its signal aborts, rejecting with the reason', async () => {
      fetchMock.mockImplementation(
        (_, init) =>
          new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))),
      );
      const controller = new AbortController();

      const promise = sut.getEvents({ queueId: 'q1', lastEventId: -1 }, controller.signal);
      await vitest.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      controller.abort(new Error('shutting down'));

      await expect(promise).rejects.toThrow('shutting down');
      expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true);
    });

    describe('long-poll timeout', () => {
      const timeouts = () => vitest.mocked(createZulipClient).mock.calls.map(([{ timeoutMs }]) => timeoutMs);
      const eventsClient = () => vitest.mocked(createZulipClient).mock.calls.at(-1)![0];

      it('should build a client for uploads as the bot, with two minutes for the file to go up', () => {
        expect(vitest.mocked(createZulipClient).mock.calls[2][0]).toEqual({
          realm: config.realm,
          ...config.bot,
          timeoutMs: 120_000,
        });
      });

      it("should allow a margin over the server's long-poll timeout, so a quiet poll is answered by its heartbeat", () => {
        expect(longpollTimeoutMs(90)).toBe(120_000);
        expect(longpollTimeoutMs(600)).toBe(630_000);
      });

      it("should build the events client at init with Zulip's default long-poll timeout and the margin", () => {
        expect(timeouts()).toEqual([undefined, undefined, 120_000, 120_000]);
        expect(eventsClient()).toMatchObject({ realm: config.realm, ...config.bot });
      });

      it("should rebuild the events client with the server's long-poll timeout and the margin", async () => {
        fetchMock.mockResolvedValue(
          json({
            result: 'success',
            msg: '',
            queue_id: 'q1',
            last_event_id: -1,
            event_queue_longpoll_timeout_seconds: 600,
          }),
        );

        await sut.registerQueue();

        expect(timeouts()).toEqual([undefined, undefined, 120_000, 120_000, 630_000]);
        expect(eventsClient()).toMatchObject({ realm: config.realm, ...config.bot });
      });

      it('should keep the default when the server does not say', async () => {
        fetchMock.mockResolvedValue(json({ result: 'success', msg: '', queue_id: 'q1', last_event_id: -1 }));

        await sut.registerQueue();

        expect(timeouts()).toEqual([undefined, undefined, 120_000, 120_000]);
      });
    });
  });

  describe('deleteQueue', () => {
    beforeEach(async () => {
      await sut.init(config);
    });

    it('should delete the queue as the bot', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '' }));

      await expect(sut.deleteQueue('q1')).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(request(0).method).toBe('DELETE');
      expect(request(0).url).toBe('https://zulip.example.com/api/v1/events');
      expect(request(0).headers.get('authorization')).toBe(basic(config.bot));
      expect(request(0).headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      expect(await request(0).text()).toBe('queue_id=q1');
    });

    it('should reject when the queue is already gone', async () => {
      fetchMock.mockResolvedValue(
        json({ result: 'error', code: 'BAD_EVENT_QUEUE_ID', msg: 'Bad event queue ID: q1' }, { status: 400 }),
      );

      await expect(sut.deleteQueue('q1')).rejects.toMatchObject({ code: 'BAD_EVENT_QUEUE_ID' });
    });
  });

  describe('deleteMessage', () => {
    beforeEach(async () => {
      await sut.init(config);
    });

    it('should delete the message as the bot', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '' }));

      await expect(sut.deleteMessage(42)).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(request(0).method).toBe('DELETE');
      expect(request(0).url).toBe('https://zulip.example.com/api/v1/messages/42');
      expect(request(0).headers.get('authorization')).toBe(basic(config.bot));
    });

    it('should throw with the reason when Zulip refuses', async () => {
      fetchMock.mockResolvedValue(
        json(
          { result: 'error', code: 'BAD_REQUEST', msg: "You don't have permission to delete this message" },
          { status: 400 },
        ),
      );

      await expect(sut.deleteMessage(42)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        msg: "You don't have permission to delete this message",
      });
    });
  });

  describe('uploadFile', () => {
    beforeEach(async () => {
      await sut.init(config);
    });

    it('should upload the file as the bot, multipart, and return its URL and the name Zulip stored', async () => {
      const url = '/user_uploads/2/86/VJFs070o1ZEFFeoCx6VH2lir/s1-test-x.txt';
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '', uri: url, url, filename: 's1 test [x].txt' }));

      await expect(sut.uploadFile(new File(['hello s1'], 's1 test [x].txt', { type: 'text/plain' }))).resolves.toEqual({
        url,
        filename: 's1 test [x].txt',
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const upload = request(0);
      expect(upload.method).toBe('POST');
      expect(upload.url).toBe('https://zulip.example.com/api/v1/user_uploads');
      expect(upload.headers.get('authorization')).toBe(basic(config.bot));
      expect(upload.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
      const part = (await upload.formData()).get('filename') as File;
      expect(part.name).toBe('s1 test [x].txt');
      expect(part.type).toBe('text/plain');
      expect(await part.text()).toBe('hello s1');
    });

    it('should fall back to the name it sent when Zulip does not say', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '', url: '/user_uploads/2/ab/cd/x.txt' }));

      await expect(sut.uploadFile(new File(['x'], 'x.txt'))).resolves.toEqual({
        url: '/user_uploads/2/ab/cd/x.txt',
        filename: 'x.txt',
      });
    });

    it('should throw when Zulip returns no URL', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '' }));

      await expect(sut.uploadFile(new File(['x'], 'x.txt'))).rejects.toThrow('Zulip returned no URL for the upload');
    });

    it('should throw when Zulip refuses the upload', async () => {
      fetchMock.mockResolvedValue(
        json(
          {
            result: 'error',
            code: 'BAD_REQUEST',
            msg: "File is larger than this server's configured maximum upload size (25 MiB).",
          },
          { status: 400 },
        ),
      );

      await expect(sut.uploadFile(new File(['x'], 'x.txt'))).rejects.toBeInstanceOf(ZulipApiError);
    });
  });

  describe('downloadUpload', () => {
    const PATH = '/user_uploads/2/86/VJFs070o1ZEFFeoCx6VH2lir/s1-test%20x.txt';
    const S3 = 'https://uploads.s3.example.com/2/86/VJFs070o1ZEFFeoCx6VH2lir/s1-test%20x.txt?X-Amz-Signature=abc';

    const file = (
      body: BodyInit = 'hello s1',
      headers: Record<string, string> = { 'content-type': 'text/plain; charset="ascii"' },
    ) => new Response(body, { status: 200, headers });
    const redirect = (location?: string) =>
      new Response(null, { status: 302, headers: location === undefined ? {} : { location } });
    const init = (index: number) => fetchMock.mock.calls[index][1];

    /** A body handing out `size`-byte chunks as they are read, `count` of them. */
    const trickle = (size: number, count = Number.POSITIVE_INFINITY) => {
      const state = { read: 0, cancelled: false };
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (state.read === count) {
              controller.close();
              return;
            }
            state.read++;
            controller.enqueue(new Uint8Array(size).fill(7));
          },
          cancel() {
            state.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return { body, state };
    };

    beforeEach(async () => {
      await sut.init(config);
    });

    it('should download the file as the bot, without following redirects, named after its decoded last segment', async () => {
      fetchMock.mockResolvedValue(file());

      const result = await sut.downloadUpload(PATH, 100);

      expect(result).toBeInstanceOf(File);
      expect(result!.name).toBe('s1-test x.txt');
      expect(result!.type).toBe('text/plain');
      expect(await result!.text()).toBe('hello s1');
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(request(0).method).toBe('GET');
      expect(request(0).url).toBe(`https://zulip.example.com${PATH}`);
      expect(request(0).headers.get('authorization')).toBe(basic(config.bot));
      expect(init(0)?.redirect).toBe('manual');
      expect(init(0)?.signal).toBeInstanceOf(AbortSignal);
    });

    it.each([
      '/user_uploads/a/../../api/v1/x',
      '/user_uploads/2/ab/cd/../../../api/v1/users/me',
      '/user_uploads/2/ab/cd/..',
      '/user_uploads/2/ab/cd/.',
      '/user_uploads/2/ab/cd/%2e%2e',
      '/user_uploads/2/ab/cd/x%2Fy.txt',
      '/user_uploads/2/ab/cd/x%5cy.txt',
      '/user_uploads/2/ab/cd/x\\y.txt',
      '/user_uploads/2/ab/cd/x.txt?download=1',
      '/user_uploads/2/ab/cd/x.txt#y',
      '/user_uploads/2/ab/x.txt',
      '/user_uploads/2/a.b/cd/x.txt',
      '/user_uploads/2/ab/cd/r%zz.txt',
      '/user_uploads/2/ab/cd/résumé.pdf',
      '//evil.example/user_uploads/2/ab/cd/x.txt',
      'https://evil.example/user_uploads/2/ab/cd/x.txt',
      '/api/v1/users/me',
      '',
    ])('should refuse %j without fetching anything', async (path) => {
      await expect(sut.downloadUpload(path, 100)).rejects.toThrow(ZulipUploadRefused);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should follow a redirect to another HTTPS origin once, without credentials and refusing any further redirect', async () => {
      fetchMock.mockResolvedValueOnce(redirect(S3)).mockResolvedValueOnce(file());

      const result = await sut.downloadUpload(PATH, 100);

      expect(await result!.text()).toBe('hello s1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(request(1).url).toBe(S3);
      expect(request(1).headers.get('authorization')).toBeNull();
      expect(init(1)?.redirect).toBe('error');
      expect(init(1)?.signal).toBe(init(0)?.signal);
    });

    it.each([
      { name: 'the login page, relative', location: '/accounts/login/?next=/user_uploads/2/86/abc/x.txt' },
      { name: 'the login page, absolute', location: 'https://zulip.example.com/accounts/login/' },
      { name: 'plain HTTP', location: 'http://uploads.s3.example.com/x.txt' },
      { name: 'nowhere', location: undefined },
    ])('should refuse a redirect to $name', async ({ location }) => {
      fetchMock.mockResolvedValueOnce(redirect(location));

      await expect(sut.downloadUpload(PATH, 100)).rejects.toThrow(ZulipUploadRefused);

      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it.each([401, 403, 404, 500])('should refuse an answer with status %i', async (status) => {
      fetchMock.mockResolvedValueOnce(new Response('nope', { status }));

      await expect(sut.downloadUpload(PATH, 100)).rejects.toThrow(`Zulip answered the download with status ${status}`);
    });

    it('should refuse a web page, which is what an unauthenticated request can get back', async () => {
      fetchMock.mockResolvedValueOnce(file('<html>login</html>', { 'content-type': 'text/html; charset=utf-8' }));

      await expect(sut.downloadUpload(PATH, 100)).rejects.toThrow('Zulip answered the download with a web page');
    });

    it('should accept a web page that is the file itself', async () => {
      fetchMock.mockResolvedValueOnce(file('<html>page</html>', { 'content-type': 'text/html' }));

      const result = await sut.downloadUpload('/user_uploads/2/ab/cd/page.HTM', 100);

      expect(result!.name).toBe('page.HTM');
      expect(await result!.text()).toBe('<html>page</html>');
    });

    it('should give up without reading the body when its length is over the limit', async () => {
      const { body, state } = trickle(4);
      fetchMock.mockResolvedValueOnce(file(body, { 'content-length': '101' }));

      await expect(sut.downloadUpload(PATH, 100)).resolves.toBeUndefined();

      expect(state).toEqual({ read: 0, cancelled: true });
    });

    it('should stop reading once the body runs past the limit', async () => {
      const { body, state } = trickle(4);
      fetchMock.mockResolvedValueOnce(file(body));

      await expect(sut.downloadUpload(PATH, 10)).resolves.toBeUndefined();

      expect(state).toEqual({ read: 3, cancelled: true });
    });

    it('should keep an empty file', async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const result = await sut.downloadUpload(PATH, 10);

      expect(result!.size).toBe(0);
      expect(result!.type).toBe('');
    });

    it('should keep a file of exactly the limit, whatever its chunks', async () => {
      const { body } = trickle(5, 2);
      fetchMock.mockResolvedValueOnce(file(body, { 'content-type': 'application/octet-stream' }));

      const result = await sut.downloadUpload(PATH, 10);

      expect(new Uint8Array(await result!.arrayBuffer())).toEqual(new Uint8Array(10).fill(7));
      expect(result!.type).toBe('application/octet-stream');
    });
  });

  describe('getStreamMessagesBefore', () => {
    beforeEach(async () => {
      await sut.init(config);
    });

    it('should ask for the messages of the stream before the anchor, leaving out a sender, as raw markdown', async () => {
      fetchMock.mockResolvedValue(
        json({
          result: 'success',
          msg: '',
          messages: [
            {
              id: 481,
              sender_id: 12,
              sender_email: 'alice@example.com',
              sender_full_name: 'Alice',
              type: 'stream',
              stream_id: 120,
              subject: '#dev',
              content: 'hello',
              timestamp: 1_700_000_000,
            },
          ],
        }),
      );

      await expect(
        sut.getStreamMessagesBefore({ stream: 120, before: 482, count: 100, excludeSenderId: 9 }),
      ).resolves.toEqual([
        {
          id: 481,
          senderId: 12,
          senderEmail: 'alice@example.com',
          senderFullName: 'Alice',
          type: 'stream',
          streamId: 120,
          topic: '#dev',
          content: 'hello',
          timestamp: 1_700_000_000,
        },
      ]);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(request(0).method).toBe('GET');
      expect(request(0).headers.get('authorization')).toBe(basic(config.bot));
      const url = new URL(request(0).url);
      expect(url.pathname).toBe('/api/v1/messages');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        anchor: '482',
        include_anchor: 'false',
        num_before: '100',
        num_after: '0',
        narrow: JSON.stringify([
          { operator: 'channel', operand: 120 },
          { operator: 'sender', operand: 9, negated: true },
        ]),
        apply_markdown: 'false',
      });
    });

    it('should start from the newest message of the whole stream without an anchor', async () => {
      fetchMock.mockResolvedValue(json({ result: 'success', msg: '', messages: [] }));

      await expect(sut.getStreamMessagesBefore({ stream: 120, count: 100 })).resolves.toEqual([]);

      const url = new URL(request(0).url);
      expect(url.searchParams.get('anchor')).toBe('newest');
      expect(url.searchParams.get('narrow')).toBe(JSON.stringify([{ operator: 'channel', operand: 120 }]));
    });
  });

  describe('getEmojiCodes', () => {
    beforeEach(async () => {
      await sut.init({ ...config, realm: 'https://zulip.example.com/api/' });
    });

    it("should read the realm's static emoji table without credentials, joining multi-codepoint emoji", async () => {
      fetchMock.mockResolvedValue(
        json({
          names: ['+1'],
          name_to_codepoint: { '+1': '1f44d', smile: '1f604', hash: '0023-20e3', flag_gb: '1f1ec-1f1e7' },
          codepoint_to_name: {},
        }),
      );

      await expect(sut.getEmojiCodes()).resolves.toEqual({
        '+1': '👍',
        smile: '😄',
        hash: '#⃣',
        flag_gb: '🇬🇧',
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(request(0).url).toBe('https://zulip.example.com/static/generated/emoji/emoji_codes.json');
      expect(request(0).headers.get('authorization')).toBeNull();
    });

    it('should skip an entry that is not a codepoint sequence', async () => {
      fetchMock.mockResolvedValue(
        json({
          name_to_codepoint: { ok: '1f44d', text: 'smile', number: 128_077, empty: '', huge: '110000', gap: '1f44d-' },
        }),
      );

      await expect(sut.getEmojiCodes()).resolves.toEqual({ ok: '👍' });
    });

    it('should throw when the table cannot be fetched', async () => {
      fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));

      await expect(sut.getEmojiCodes()).rejects.toThrow('Could not fetch the Zulip emoji codes: 404');
    });

    it.each([{}, { name_to_codepoint: ['1f44d'] }, { name_to_codepoint: 'x' }, null])(
      'should throw when the answer %j has no table',
      async (body) => {
        fetchMock.mockResolvedValue(json(body));

        await expect(sut.getEmojiCodes()).rejects.toThrow('The Zulip emoji codes have no name_to_codepoint table');
      },
    );
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
