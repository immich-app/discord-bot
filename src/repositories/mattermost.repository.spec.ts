import { MattermostRepository } from 'src/repositories/mattermost.repository';
import { beforeEach, describe, expect, it, vitest } from 'vitest';

const { clients } = vitest.hoisted(() => ({
  clients: [] as { getCustomEmojis: ReturnType<typeof vitest.fn> }[],
}));

vitest.mock('src/config', () => ({
  getConfig: () => ({ mattermost: { domain: 'https://mattermost.example.com', botToken: 'token' } }),
}));

vitest.mock('@mattermost/client', () => ({
  Client4: class {
    getCustomEmojis = vitest.fn();

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
    initialize() {}

    addMissedMessageListener() {}
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
});
