import { MattermostRepository } from 'src/repositories/mattermost.repository';
import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

const { clients, sockets, config } = vitest.hoisted(() => ({
  clients: [] as {
    getCustomEmojis: ReturnType<typeof vitest.fn>;
    getMe: ReturnType<typeof vitest.fn>;
    getMyTeams: ReturnType<typeof vitest.fn>;
    getAllChannels: ReturnType<typeof vitest.fn>;
  }[],
  sockets: [] as { initialize: ReturnType<typeof vitest.fn> }[],
  config: { mattermost: { domain: 'https://mattermost.example.com', botToken: 'token' } },
}));

vitest.mock('src/config', () => ({ getConfig: () => config }));

vitest.mock('@mattermost/client', () => ({
  Client4: class {
    getCustomEmojis = vitest.fn();
    getMe = vitest.fn().mockResolvedValue({ id: 'bot' });
    getMyTeams = vitest.fn().mockResolvedValue([]);
    getAllChannels = vitest.fn();

    constructor() {
      clients.push(this);
    }

    setUrl() {}

    setToken() {}

    getWebSocketUrl() {
      return 'wss://mattermost.example.com/api/v4/websocket';
    }
  },
  WebSocketClient: class {
    initialize = vitest.fn();

    constructor() {
      sockets.push(this);
    }

    addMissedMessageListener() {}

    addMessageListener() {}
  },
}));

const emoji = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ name: `emoji_${from + index}` }));

describe('MattermostRepository', () => {
  let sut: MattermostRepository;
  let client: (typeof clients)[number];

  beforeEach(() => {
    sut = new MattermostRepository();
    client = clients.at(-1)!;
  });

  describe('listEmoji', () => {
    it('should page through every custom emoji, 200 at a time, until a page comes back short', async () => {
      client.getCustomEmojis
        .mockResolvedValueOnce(emoji(0, 200))
        .mockResolvedValueOnce(emoji(200, 200))
        .mockResolvedValueOnce(emoji(400, 3));

      const names = await sut.listEmoji();

      expect(client.getCustomEmojis.mock.calls).toEqual([
        [0, 200],
        [1, 200],
        [2, 200],
      ]);
      expect(names).toEqual(emoji(0, 403).map(({ name }) => name));
    });

    it('should read one more, empty, page when the last one was full', async () => {
      client.getCustomEmojis.mockResolvedValueOnce(emoji(0, 200)).mockResolvedValueOnce([]);

      await expect(sut.listEmoji()).resolves.toHaveLength(200);

      expect(client.getCustomEmojis).toHaveBeenCalledTimes(2);
    });

    it('should let a failed page through, so the sync can tell it from an empty realm', async () => {
      client.getCustomEmojis.mockResolvedValueOnce(emoji(0, 200)).mockRejectedValueOnce(new Error('fetch failed'));

      await expect(sut.listEmoji()).rejects.toThrow('fetch failed');
    });
  });

  describe('init', () => {
    it('should connect, and count as initialised once it has', async () => {
      expect(sockets.at(-1)!.initialize).toHaveBeenCalledOnce();
      expect(sut.isInitialised()).toBe(false);

      await sut.init();

      expect(client.getMe).toHaveBeenCalledOnce();
      expect(sut.isInitialised()).toBe(true);
    });
  });

  describe.each([
    { name: 'domain', mattermost: { domain: 'dev', botToken: 'token' } },
    { name: 'token', mattermost: { domain: 'https://mattermost.example.com', botToken: 'dev' } },
  ])('with the dev $name', ({ mattermost }) => {
    const configured = config.mattermost;

    beforeEach(() => {
      config.mattermost = mattermost;
      sockets.length = 0;
      sut = new MattermostRepository();
      client = clients.at(-1)!;
    });

    afterEach(() => {
      config.mattermost = configured;
    });

    it('should open no websocket and call nothing on init', async () => {
      await sut.init();

      expect(sockets).toHaveLength(0);
      expect(client.getMe).not.toHaveBeenCalled();
      expect(sut.isInitialised()).toBe(false);
    });

    it('should register no command and list no channel', async () => {
      await expect(sut.registerCommand({ trigger: 'x' } as never, () => {})).resolves.toBeUndefined();

      const channels = [];
      for await (const channel of sut.streamChannels('team')) {
        channels.push(channel);
      }
      expect(channels).toEqual([]);
      expect(client.getAllChannels).not.toHaveBeenCalled();
    });
  });
});
