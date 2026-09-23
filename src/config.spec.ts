import { getConfig } from 'src/config';
import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

const REQUIRED = {
  uri: 'postgres://postgres:postgres@localhost:5432/discord-bot',
  BOT_TOKEN: 'bot-token',
  ZULIP_BOT_USERNAME: 'immich-bot@zulip.example.com',
  ZULIP_BOT_API_KEY: 'bot-key',
  ZULIP_USER_USERNAME: 'human@example.com',
  ZULIP_USER_API_KEY: 'user-key',
  ZULIP_DOMAIN: 'https://zulip.example.com',
  FOURTHWALL_USER: 'fw-user',
  FOURTHWALL_PASSWORD: 'fw-password',
  GITHUB_APP_ID: '1',
  GITHUB_INSTALLATION_ID: '2',
  GITHUB_PRIVATE_KEY: 'private-key',
  OUTLINE_API_KEY: 'outline-key',
  LOOPDEDUPE_SEARCH_API_KEY: 'loop-key',
  POLAR_PAYMENT_IMMICH_CLIENT_WEBHOOK_SECRET: 'client-secret',
  POLAR_PAYMENT_IMMICH_SERVER_WEBHOOK_SECRET: 'server-secret',
  MATTERMOST_DOMAIN: 'https://mattermost.example.com',
  MATTERMOST_BOT_TOKEN: 'mattermost-token',
};

describe('getConfig', () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(REQUIRED)) {
      vitest.stubEnv(key, value);
    }
  });

  afterEach(() => {
    vitest.unstubAllEnvs();
    vitest.restoreAllMocks();
  });

  it('should trim the whitespace a secret was stored with from every Zulip value', () => {
    vitest.stubEnv('ZULIP_BOT_USERNAME', ' immich-bot@zulip.example.com\n');
    vitest.stubEnv('ZULIP_BOT_API_KEY', 'bot-key\n');
    vitest.stubEnv('ZULIP_USER_USERNAME', '\thuman@example.com ');
    vitest.stubEnv('ZULIP_USER_API_KEY', 'user-key\r\n');
    vitest.stubEnv('ZULIP_DOMAIN', 'https://zulip.example.com\n');

    expect(getConfig().zulip).toEqual({
      bot: { username: 'immich-bot@zulip.example.com', apiKey: 'bot-key' },
      user: { username: 'human@example.com', apiKey: 'user-key' },
      realm: 'https://zulip.example.com',
    });
  });

  it('should refuse a Zulip value that is nothing but whitespace, as it refuses a missing one', () => {
    vitest.spyOn(console, 'log').mockImplementation(() => {});
    vitest.stubEnv('ZULIP_USER_API_KEY', '\n');

    expect(() => getConfig()).toThrow('Missing required environment variables');
  });
});
