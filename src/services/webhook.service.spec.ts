import { UnauthorizedException } from '@nestjs/common';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import type { WebhookOrderPaidPayload } from '@polar-sh/sdk/models/components/webhookorderpaidpayload.js';
import { EmbedBuilder } from 'discord.js';
import _ from 'lodash';
import { ReleaseMessages } from 'src/constants';
import { GithubStatusComponent, GithubStatusIncident, PaymentIntent, StripeBase } from 'src/dtos/webhook.dto';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import {
  FourthwallOrderCreateWebhook,
  FourthwallOrderUpdateWebhook,
  IFourthwallRepository,
} from 'src/interfaces/fourthwall.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { IOutlineInterface } from 'src/interfaces/outline.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';
import { NotificationService } from 'src/services/notification.service';
import { WebhookService } from 'src/services/webhook.service';
import { Mocked, afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

/**
 * Characterization tests: these pin the CURRENT payloads sent to Discord, Mattermost and Zulip
 * for every notification path in WebhookService. They intentionally pin quirks of the current
 * implementation (trailing `undefined` entries in Mattermost `content` arrays, raw GitHub action
 * names such as `converted_to_draft` in titles, etc). If a snapshot changes during a refactor,
 * the refactor drifted - fix the code, never the snapshot.
 */

vitest.mock('src/config', () => ({
  getConfig: () => ({
    slugs: {
      githubWebhook: 'github-slug',
      githubStatusWebhook: 'github-status-slug',
      stripeWebhook: 'stripe-slug',
      polarWebhook: 'polar-slug',
      fourthwallWebhook: 'fourthwall-slug',
    },
    fourthwall: { user: 'fw-user', password: 'fw-password' },
    polar: { immichClientSecret: 'client-secret', immichServerSecret: 'server-secret' },
  }),
}));

const newDatabaseMockRepository = (): Mocked<IDatabaseRepository> => ({
  addDiscordLink: vitest.fn(),
  createPayment: vitest.fn(),
  getDiscordLinks: vitest.fn(),
  getDiscordLink: vitest.fn(),
  removeDiscordLink: vitest.fn(),
  getTotalLicenseCount: vitest.fn(),
  runMigrations: vitest.fn(),
  updateDiscordLink: vitest.fn(),
  addDiscordMessage: vitest.fn(),
  getDiscordMessage: vitest.fn(),
  getDiscordMessages: vitest.fn(),
  removeDiscordMessage: vitest.fn(),
  updateDiscordMessage: vitest.fn(),
  createFourthwallOrder: vitest.fn(),
  getTotalFourthwallOrders: vitest.fn(),
  streamFourthwallOrders: vitest.fn(),
  updateFourthwallOrder: vitest.fn(),
  createRSSFeed: vitest.fn(),
  getRSSFeeds: vitest.fn(),
  updateRSSFeed: vitest.fn(),
  removeRSSFeed: vitest.fn(),
  getScheduledMessages: vitest.fn(),
  getScheduledMessage: vitest.fn(),
  createScheduledMessage: vitest.fn(),
  updateScheduledMessage: vitest.fn(),
  removeScheduledMessage: vitest.fn(),
  createPullRequest: vitest.fn(),
  getPullRequestById: vitest.fn(),
  updatePullRequest: vitest.fn(),
  upsertPullRequest: vitest.fn(),
  getLatestPullRequestByNumber: vitest.fn(),
});

const newDiscordMockRepository = (): Mocked<IDiscordInterface> => ({
  login: vitest.fn(),
  sendMessage: vitest.fn(),
  createEmote: vitest.fn(),
  getEmotes: vitest.fn(),
  setThreadArchived: vitest.fn(),
  createThread: vitest.fn(),
  updateThread: vitest.fn(),
});

const newFourthwallMockRepository = (): Mocked<IFourthwallRepository> => ({
  getOrder: vitest.fn(),
});

const newGithubMockRepository = (): Mocked<IGithubInterface> => ({
  search: vitest.fn(),
  getDiscussionMessage: vitest.fn(),
  getForkCount: vitest.fn(),
  getIssueOrPrMessage: vitest.fn(),
  getStarCount: vitest.fn(),
  init: vitest.fn(),
  getRepositoryFileContent: vitest.fn(),
  getCheckSuiteTriggerCommit: vitest.fn(),
  getLatestReleaseTag: vitest.fn(),
  isCollaborator: vitest.fn(),
  getPullRequests: vitest.fn(),
});

const newOutlineMockRepository = (): Mocked<IOutlineInterface> => ({
  addToDocument: vitest.fn(),
  createDocument: vitest.fn(),
  shareDocument: vitest.fn(),
  searchDocuments: vitest.fn(),
});

const newMattermostMockRepository = (): Mocked<IMattermostInterface> => ({
  init: vitest.fn(),
  registerEventListener: vitest.fn() as any,
  send: vitest.fn(),
  reply: vitest.fn(),
  updatePost: vitest.fn(),
  createEmote: vitest.fn(),
  streamChannels: vitest.fn(),
  joinChannel: vitest.fn(),
  registerCommand: vitest.fn() as any,
  runCommand: vitest.fn(),
  openDialog: vitest.fn(),
  submitDialog: vitest.fn(),
});

const newZulipMockRepository = (): Mocked<IZulipInterface> => ({
  init: vitest.fn(),
  createEmote: vitest.fn(),
  sendMessage: vitest.fn(),
});

// --- fixtures -------------------------------------------------------------------------------

const githubEvent = (name: EmitterWebhookEvent['name'], payload: Record<string, unknown>) =>
  ({ id: 'delivery-1', name, payload }) as unknown as EmitterWebhookEvent;

const sender = {
  login: 'alextran1502',
  html_url: 'https://github.com/alextran1502',
  avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
  type: 'User',
};

const immichRepo = { full_name: 'immich-app/immich', name: 'immich', owner: { login: 'immich-app' }, private: false };
const immichPrivateRepo = {
  full_name: 'immich-app/immich-private',
  name: 'immich-private',
  owner: { login: 'immich-app' },
  private: true,
};
const immichOtherRepo = {
  full_name: 'immich-app/static-pages',
  name: 'static-pages',
  owner: { login: 'immich-app' },
  private: false,
};
const fhsCoreRepo = { full_name: 'futo-org/fhs-core', name: 'fhs-core', owner: { login: 'futo-org' }, private: false };
const unrelatedRepo = {
  full_name: 'octocat/hello-world',
  name: 'hello-world',
  owner: { login: 'octocat' },
  private: false,
};

const makePullRequest = (overrides: Record<string, unknown> = {}) => ({
  node_id: 'PR_node_1234',
  number: 1234,
  title: 'feat: add thing',
  html_url: 'https://github.com/immich-app/immich/pull/1234',
  body: 'This PR adds a thing.',
  draft: false,
  merged: false,
  merged_at: null,
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const issue = {
  number: 42,
  title: 'Bug: thumbnails missing',
  html_url: 'https://github.com/immich-app/immich/issues/42',
  body: 'Steps to reproduce: open the timeline.',
};

const discussion = {
  number: 7,
  title: 'Feature: nicer timeline',
  html_url: 'https://github.com/immich-app/immich/discussions/7',
  body: 'It would be nice if the timeline were nicer.',
};

const makeRelease = (overrides: Record<string, unknown> = {}) => ({
  name: 'v1.2.0',
  tag_name: 'v1.2.0',
  html_url: 'https://github.com/immich-app/immich/releases/tag/v1.2.0',
  body: 'Release notes',
  ...overrides,
});

const releaseMessage = ReleaseMessages[0];

const makeIncident = (overrides: { status?: string; impact?: string } = {}): GithubStatusIncident => ({
  meta: {
    unsubscribe: 'https://www.githubstatus.com/?unsubscribe=abc',
    documentation: 'https://doers.statuspage.io/customer-notifications/webhooks/',
  },
  page: { id: 'kctbh9vrtdwd', status_indicator: 'minor', status_description: 'Minor Service Outage' },
  incident: {
    name: 'Incident with Actions',
    status: overrides.status ?? 'investigating',
    impact: overrides.impact ?? 'minor',
    shortlink: 'https://stspg.io/abc123',
    incident_updates: [
      {
        body: 'We are investigating reports of degraded performance.<br />More updates soon.',
        status: overrides.status ?? 'investigating',
      },
    ],
  } as GithubStatusIncident['incident'],
});

const componentUpdate: GithubStatusComponent = {
  meta: {
    unsubscribe: 'https://www.githubstatus.com/?unsubscribe=abc',
    documentation: 'https://doers.statuspage.io/customer-notifications/webhooks/',
  },
  page: { id: 'kctbh9vrtdwd', status_indicator: 'none', status_description: 'All Systems Operational' },
  component_update: {
    createdAt: '2026-01-01T00:00:00Z',
    new_status: 'operational',
    old_status: 'degraded_performance',
    id: 'cu_1',
    component_id: 'c_1',
  },
  component: { created_at: '2026-01-01T00:00:00Z', id: 'c_1', name: 'Actions', status: 'operational' },
};

const fourthwallOrderData = {
  id: 'ord_1',
  friendlyId: 'ABC-123',
  status: 'CONFIRMED',
  username: 'buyer',
  message: 'Love the project!',
  email: 'buyer@example.com',
  createdAt: '2026-01-01T00:00:00Z',
  amounts: {
    discount: { value: 5, currency: 'USD' },
    donation: { value: 0, currency: 'USD' },
    shipping: { value: 8, currency: 'USD' },
    subtotal: { value: 40, currency: 'USD' },
    tax: { value: 3, currency: 'USD' },
    total: { value: 46, currency: 'USD' },
  },
} as unknown as FourthwallOrderCreateWebhook['data'];

const makeOrderPlaced = (
  overrides: Partial<FourthwallOrderCreateWebhook['data']> = {},
  testMode = false,
): FourthwallOrderCreateWebhook => ({
  testMode,
  id: 'wh_1',
  webhookId: 'whk_1',
  shopId: 'shop_1',
  type: 'ORDER_PLACED',
  apiVersion: 'V1',
  createdAt: '2026-01-01T00:00:00Z',
  data: { ...fourthwallOrderData, ...overrides },
});

const makeOrderUpdated = (
  overrides: Partial<FourthwallOrderCreateWebhook['data']> = {},
  testMode = false,
): FourthwallOrderUpdateWebhook => ({
  testMode,
  id: 'wh_2',
  webhookId: 'whk_1',
  shopId: 'shop_1',
  type: 'ORDER_UPDATED',
  apiVersion: 'V1',
  createdAt: '2026-01-02T00:00:00Z',
  data: { order: { ...fourthwallOrderData, ...overrides }, update: { type: 'STATUS' } },
});

const makeStripeEvent = (overrides: Partial<PaymentIntent> = {}): StripeBase<PaymentIntent> => ({
  id: 'evt_1',
  object: 'event',
  type: 'payment_intent.succeeded',
  data: {
    object: {
      id: 'pi_1',
      object: 'payment_intent',
      amount: 10_000,
      currency: 'usd',
      created: 1_767_225_600,
      description: 'immich-server',
      status: 'succeeded',
      receipt_email: 'buyer@example.com',
      livemode: true,
      ...overrides,
    },
  },
});

const polarEvent = {
  type: 'order.paid',
  data: {
    id: 'order_1',
    description: 'polar-description',
    totalAmount: 2500,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    currency: 'usd',
    status: 'paid',
  },
} as unknown as WebhookOrderPaidPayload;

describe(WebhookService.name, () => {
  let sut: WebhookService;

  let databaseMock: Mocked<IDatabaseRepository>;
  let discordMock: Mocked<IDiscordInterface>;
  let fourthwallMock: Mocked<IFourthwallRepository>;
  let githubMock: Mocked<IGithubInterface>;
  let outlineMock: Mocked<IOutlineInterface>;
  let mattermostMock: Mocked<IMattermostInterface>;
  let zulipMock: Mocked<IZulipInterface>;

  /** Everything that was posted, with Discord embeds serialised via `toJSON()` so the snapshot shows the wire shape. */
  const sent = () => ({
    discord: discordMock.sendMessage.mock.calls.map(([dto]) => ({
      ...dto,
      message:
        typeof dto.message === 'string'
          ? dto.message
          : {
              ...dto.message,
              embeds: dto.message.embeds?.map((embed) => (embed instanceof EmbedBuilder ? embed.toJSON() : embed)),
            },
    })),
    mattermost: mattermostMock.send.mock.calls.map(([post]) => post),
    zulip: zulipMock.sendMessage.mock.calls.map(([payload]) => payload),
  });

  beforeEach(() => {
    databaseMock = newDatabaseMockRepository();
    discordMock = newDiscordMockRepository();
    fourthwallMock = newFourthwallMockRepository();
    githubMock = newGithubMockRepository();
    outlineMock = newOutlineMockRepository();
    mattermostMock = newMattermostMockRepository();
    zulipMock = newZulipMockRepository();

    sut = new WebhookService(
      databaseMock,
      discordMock,
      fourthwallMock,
      githubMock,
      outlineMock,
      mattermostMock,
      zulipMock,
      new NotificationService(discordMock, mattermostMock),
    );
  });

  afterEach(() => {
    vitest.restoreAllMocks();
    vitest.useRealTimers();
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onGithubStatus', () => {
    it('should reject an unknown slug', async () => {
      await expect(sut.onGithubStatus(makeIncident(), 'wrong-slug')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(sent()).toEqual({ discord: [], mattermost: [], zulip: [] });
    });

    it('should ignore component updates', async () => {
      await sut.onGithubStatus(componentUpdate, 'github-status-slug');
      expect(sent()).toEqual({ discord: [], mattermost: [], zulip: [] });
    });

    it('should post a minor incident (Orange)', async () => {
      await sut.onGithubStatus(makeIncident({ impact: 'minor' }), 'github-status-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "1240662502912692236",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "name": "GitHub Status",
                      "url": "https://githubstatus.com",
                    },
                    "color": 15105570,
                    "fields": [
                      {
                        "name": "Incident with Actions",
                        "value": "We are investigating reports of degraded performance.
        More updates soon.",
                      },
                    ],
                    "title": "Minor Service Outage",
                    "url": "https://stspg.io/abc123",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "4ht6ooks83n3fq8t8kijbnyeww",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#e67e22",
                    "border": true,
                    "content": [
                      {
                        "is_subtle": true,
                        "size": "small",
                        "text": "[GitHub Status](https://githubstatus.com)",
                        "type": "text",
                      },
                      {
                        "text": "##### [Minor Service Outage](https://stspg.io/abc123)",
                        "type": "text",
                      },
                      {
                        "text": "**Incident with Actions**",
                        "type": "text",
                      },
                      {
                        "text": "We are investigating reports of degraded performance.
        More updates soon.",
                        "type": "text",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post a major incident (Red)', async () => {
      await sut.onGithubStatus(makeIncident({ impact: 'major' }), 'github-status-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "1240662502912692236",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "name": "GitHub Status",
                      "url": "https://githubstatus.com",
                    },
                    "color": 15548997,
                    "fields": [
                      {
                        "name": "Incident with Actions",
                        "value": "We are investigating reports of degraded performance.
        More updates soon.",
                      },
                    ],
                    "title": "Minor Service Outage",
                    "url": "https://stspg.io/abc123",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "4ht6ooks83n3fq8t8kijbnyeww",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#ed4245",
                    "border": true,
                    "content": [
                      {
                        "is_subtle": true,
                        "size": "small",
                        "text": "[GitHub Status](https://githubstatus.com)",
                        "type": "text",
                      },
                      {
                        "text": "##### [Minor Service Outage](https://stspg.io/abc123)",
                        "type": "text",
                      },
                      {
                        "text": "**Incident with Actions**",
                        "type": "text",
                      },
                      {
                        "text": "We are investigating reports of degraded performance.
        More updates soon.",
                        "type": "text",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post any other impact level as Grey', async () => {
      await sut.onGithubStatus(makeIncident({ impact: 'critical' }), 'github-status-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "1240662502912692236",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "name": "GitHub Status",
                      "url": "https://githubstatus.com",
                    },
                    "color": 9807270,
                    "fields": [
                      {
                        "name": "Incident with Actions",
                        "value": "We are investigating reports of degraded performance.
        More updates soon.",
                      },
                    ],
                    "title": "Minor Service Outage",
                    "url": "https://stspg.io/abc123",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "4ht6ooks83n3fq8t8kijbnyeww",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#95a5a6",
                    "border": true,
                    "content": [
                      {
                        "is_subtle": true,
                        "size": "small",
                        "text": "[GitHub Status](https://githubstatus.com)",
                        "type": "text",
                      },
                      {
                        "text": "##### [Minor Service Outage](https://stspg.io/abc123)",
                        "type": "text",
                      },
                      {
                        "text": "**Incident with Actions**",
                        "type": "text",
                      },
                      {
                        "text": "We are investigating reports of degraded performance.
        More updates soon.",
                        "type": "text",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post a resolved incident as Green regardless of impact', async () => {
      await sut.onGithubStatus(makeIncident({ impact: 'major', status: 'resolved' }), 'github-status-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "1240662502912692236",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "name": "GitHub Status",
                      "url": "https://githubstatus.com",
                    },
                    "color": 5763719,
                    "fields": [
                      {
                        "name": "Incident with Actions",
                        "value": "We are investigating reports of degraded performance.
        More updates soon.",
                      },
                    ],
                    "title": "Minor Service Outage",
                    "url": "https://stspg.io/abc123",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "4ht6ooks83n3fq8t8kijbnyeww",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#57f287",
                    "border": true,
                    "content": [
                      {
                        "is_subtle": true,
                        "size": "small",
                        "text": "[GitHub Status](https://githubstatus.com)",
                        "type": "text",
                      },
                      {
                        "text": "##### [Minor Service Outage](https://stspg.io/abc123)",
                        "type": "text",
                      },
                      {
                        "text": "**Incident with Actions**",
                        "type": "text",
                      },
                      {
                        "text": "We are investigating reports of degraded performance.
        More updates soon.",
                        "type": "text",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });
  });

  describe('handleFourthwallOrder', () => {
    beforeEach(() => {
      vitest.useFakeTimers();
      fourthwallMock.getOrder.mockResolvedValue({ profit: { value: 12, currency: 'USD' } } as never);
      databaseMock.getTotalFourthwallOrders.mockResolvedValue({ revenue: 500, profit: 250 });
    });

    const run = async (dto: FourthwallOrderCreateWebhook | FourthwallOrderUpdateWebhook) => {
      const promise = sut['handleFourthwallOrder'](dto);
      await vitest.advanceTimersByTimeAsync(10_000);
      await promise;
    };

    it('should wait 10 seconds before looking up the order', async () => {
      const promise = sut['handleFourthwallOrder'](makeOrderPlaced());
      await vitest.advanceTimersByTimeAsync(9_999);
      expect(fourthwallMock.getOrder).not.toHaveBeenCalled();
      await vitest.advanceTimersByTimeAsync(1);
      await promise;
      expect(fourthwallMock.getOrder).toHaveBeenCalledWith({ id: 'ord_1', user: 'fw-user', password: 'fw-password' });
    });

    it('should post an ORDER_PLACED order (DarkGreen) to Mattermost only', async () => {
      await run(makeOrderPlaced());

      expect(databaseMock.createFourthwallOrder).toHaveBeenCalledWith({
        id: 'ord_1',
        discount: 5,
        tax: 3,
        shipping: 8,
        subtotal: 40,
        total: 46,
        revenue: 40,
        profit: 12,
        username: 'buyer',
        message: 'Love the project!',
        status: 'CONFIRMED',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        testMode: false,
      });
      expect(databaseMock.updateFourthwallOrder).not.toHaveBeenCalled();
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [],
          "mattermost": [
            {
              "channelId": "ijh1ciffcp8fdyy4y5snxnornr",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#1f8b4c",
                    "border": true,
                    "content": [
                      {
                        "is_subtle": true,
                        "size": "small",
                        "text": "[Fourthwall](https://fourthwall.com)",
                        "type": "text",
                      },
                      {
                        "text": "##### [Immich merch purchased](https://immich-shop.fourthwall.com/admin/dashboard/contributions/orders/ord_1)",
                        "type": "text",
                      },
                      {
                        "text": "Price: 40 USD; Profit: 12 USD",
                        "type": "text",
                      },
                      {
                        "type": "divider",
                      },
                      {
                        "columns": [
                          {
                            "gap": "small",
                            "items": [
                              {
                                "text": "**Revenue**",
                                "type": "text",
                              },
                              {
                                "text": "500 USD",
                                "type": "text",
                              },
                            ],
                            "type": "column",
                          },
                          {
                            "gap": "small",
                            "items": [
                              {
                                "text": "**Profit**",
                                "type": "text",
                              },
                              {
                                "text": "250 USD",
                                "type": "text",
                              },
                            ],
                            "type": "column",
                          },
                          {
                            "gap": "small",
                            "items": [
                              {
                                "text": "**Message**",
                                "type": "text",
                              },
                              {
                                "text": "Love the project!",
                                "type": "text",
                              },
                            ],
                            "type": "column",
                          },
                        ],
                        "type": "column_set",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post a cancelled ORDER_UPDATED order (Red) without a message column', async () => {
      await run(makeOrderUpdated({ status: 'CANCELLED', message: undefined }));

      expect(databaseMock.updateFourthwallOrder).toHaveBeenCalledWith({
        id: 'ord_1',
        discount: 5,
        tax: 3,
        shipping: 8,
        subtotal: 40,
        total: 46,
        revenue: 40,
        profit: 12,
        username: 'buyer',
        message: undefined,
        status: 'CANCELLED',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      expect(databaseMock.createFourthwallOrder).not.toHaveBeenCalled();
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [],
          "mattermost": [
            {
              "channelId": "ijh1ciffcp8fdyy4y5snxnornr",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#ed4245",
                    "border": true,
                    "content": [
                      {
                        "is_subtle": true,
                        "size": "small",
                        "text": "[Fourthwall](https://fourthwall.com)",
                        "type": "text",
                      },
                      {
                        "text": "##### [Immich merch order updated](https://immich-shop.fourthwall.com/admin/dashboard/contributions/orders/ord_1)",
                        "type": "text",
                      },
                      {
                        "text": "Price: 40 USD; Profit: 12 USD",
                        "type": "text",
                      },
                      {
                        "type": "divider",
                      },
                      {
                        "columns": [
                          {
                            "gap": "small",
                            "items": [
                              {
                                "text": "**Revenue**",
                                "type": "text",
                              },
                              {
                                "text": "500 USD",
                                "type": "text",
                              },
                            ],
                            "type": "column",
                          },
                          {
                            "gap": "small",
                            "items": [
                              {
                                "text": "**Profit**",
                                "type": "text",
                              },
                              {
                                "text": "250 USD",
                                "type": "text",
                              },
                            ],
                            "type": "column",
                          },
                        ],
                        "type": "column_set",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should update but not post a non-cancelled ORDER_UPDATED order', async () => {
      await run(makeOrderUpdated({ status: 'SHIPPED' }));

      expect(databaseMock.updateFourthwallOrder).toHaveBeenCalledOnce();
      expect(databaseMock.getTotalFourthwallOrders).not.toHaveBeenCalled();
      expect(sent()).toEqual({ discord: [], mattermost: [], zulip: [] });
    });

    it('should post a test mode order (Yellow) with a randomised profit', async () => {
      vitest.spyOn(Math, 'random').mockReturnValue(0.5);

      await run(makeOrderPlaced({}, true));

      expect(fourthwallMock.getOrder).toHaveBeenCalledOnce();
      expect(databaseMock.createFourthwallOrder).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ord_1', profit: 20, testMode: true }),
      );
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [],
          "mattermost": [
            {
              "channelId": "ijh1ciffcp8fdyy4y5snxnornr",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#fee75c",
                    "border": true,
                    "content": [
                      {
                        "is_subtle": true,
                        "size": "small",
                        "text": "[Fourthwall](https://fourthwall.com)",
                        "type": "text",
                      },
                      {
                        "text": "##### [TEST ORDER - Immich merch purchased](https://immich-shop.fourthwall.com/admin/dashboard/contributions/orders/ord_1)",
                        "type": "text",
                      },
                      {
                        "text": "Price: 40 USD; Profit: 20 USD",
                        "type": "text",
                      },
                      {
                        "type": "divider",
                      },
                      {
                        "columns": [
                          {
                            "gap": "small",
                            "items": [
                              {
                                "text": "**Revenue**",
                                "type": "text",
                              },
                              {
                                "text": "500 USD",
                                "type": "text",
                              },
                            ],
                            "type": "column",
                          },
                          {
                            "gap": "small",
                            "items": [
                              {
                                "text": "**Profit**",
                                "type": "text",
                              },
                              {
                                "text": "250 USD",
                                "type": "text",
                              },
                            ],
                            "type": "column",
                          },
                          {
                            "gap": "small",
                            "items": [
                              {
                                "text": "**Message**",
                                "type": "text",
                              },
                              {
                                "text": "Love the project!",
                                "type": "text",
                              },
                            ],
                            "type": "column",
                          },
                        ],
                        "type": "column_set",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
            },
          ],
          "zulip": [],
        }
      `);
    });
  });

  describe('handlePayment', () => {
    beforeEach(() => {
      databaseMock.getTotalLicenseCount.mockResolvedValue({ server: 3, client: 4 });
    });

    it('should post a live Stripe payment (Green) to Mattermost only', async () => {
      const event = makeStripeEvent();

      await sut['handlePayment'](event);

      expect(databaseMock.createPayment).toHaveBeenCalledWith({
        event_id: 'pi_1',
        id: 'pi_1',
        amount: 10_000,
        currency: 'usd',
        status: 'succeeded',
        description: 'immich-server',
        created: 1_767_225_600,
        livemode: true,
        data: JSON.stringify(event),
      });
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [],
          "mattermost": [
            {
              "channelId": "ijh1ciffcp8fdyy4y5snxnornr",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#57f287",
                    "border": true,
                    "content": [
                      {
                        "is_subtle": true,
                        "size": "small",
                        "text": "[Stripe payments](https://stripe.com)",
                        "type": "text",
                      },
                      {
                        "text": "##### [Immich server product key purchased](https://dashboard.stripe.com/payments/pi_1)",
                        "type": "text",
                      },
                      {
                        "text": "Price: 100 USD",
                        "type": "text",
                      },
                      {
                        "type": "divider",
                      },
                      {
                        "columns": [
                          {
                            "gap": "small",
                            "items": [
                              {
                                "text": "**Server keys**",
                                "type": "text",
                              },
                              {
                                "text": "$300 - 3 keys",
                                "type": "text",
                              },
                            ],
                            "type": "column",
                          },
                          {
                            "gap": "small",
                            "items": [
                              {
                                "text": "**Client keys**",
                                "type": "text",
                              },
                              {
                                "text": "$100 - 4 keys",
                                "type": "text",
                              },
                            ],
                            "type": "column",
                          },
                        ],
                        "type": "column_set",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post a test Stripe payment (Yellow) with the test dashboard url', async () => {
      await sut['handlePayment'](makeStripeEvent({ livemode: false, description: 'immich-client' }));

      expect(databaseMock.createPayment).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'immich-client', livemode: false }),
      );
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [],
          "mattermost": [
            {
              "channelId": "ijh1ciffcp8fdyy4y5snxnornr",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#fee75c",
                    "border": true,
                    "content": [
                      {
                        "is_subtle": true,
                        "size": "small",
                        "text": "[Stripe payments](https://stripe.com)",
                        "type": "text",
                      },
                      {
                        "text": "##### [TEST PAYMENT - Immich client product key purchased](https://dashboard.stripe.com/test/payments/pi_1)",
                        "type": "text",
                      },
                      {
                        "text": "Price: 100 USD",
                        "type": "text",
                      },
                      {
                        "type": "divider",
                      },
                      {
                        "columns": [
                          {
                            "gap": "small",
                            "items": [
                              {
                                "text": "**Server keys**",
                                "type": "text",
                              },
                              {
                                "text": "$300 - 3 keys",
                                "type": "text",
                              },
                            ],
                            "type": "column",
                          },
                          {
                            "gap": "small",
                            "items": [
                              {
                                "text": "**Client keys**",
                                "type": "text",
                              },
                              {
                                "text": "$100 - 4 keys",
                                "type": "text",
                              },
                            ],
                            "type": "column",
                          },
                        ],
                        "type": "column_set",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post a Polar payment (Green) using the org slug as the product', async () => {
      await sut['handlePayment'](polarEvent, 'immich-server');

      expect(databaseMock.createPayment).toHaveBeenCalledWith({
        event_id: 'order_1',
        id: 'order_1',
        amount: 2500,
        currency: 'usd',
        status: 'paid',
        description: 'immich-server',
        created: 1_767_225_600,
        livemode: true,
        data: JSON.stringify(polarEvent),
      });
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [],
          "mattermost": [
            {
              "channelId": "ijh1ciffcp8fdyy4y5snxnornr",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#57f287",
                    "border": true,
                    "content": [
                      {
                        "is_subtle": true,
                        "size": "small",
                        "text": "[Polar Payments](https://polar.sh)",
                        "type": "text",
                      },
                      {
                        "text": "##### [Immich server product key purchased](https://polar.sh/dashboard/immich-server/sales/order_1)",
                        "type": "text",
                      },
                      {
                        "text": "Price: 25 USD",
                        "type": "text",
                      },
                      {
                        "type": "divider",
                      },
                      {
                        "columns": [
                          {
                            "gap": "small",
                            "items": [
                              {
                                "text": "**Server keys**",
                                "type": "text",
                              },
                              {
                                "text": "$300 - 3 keys",
                                "type": "text",
                              },
                            ],
                            "type": "column",
                          },
                          {
                            "gap": "small",
                            "items": [
                              {
                                "text": "**Client keys**",
                                "type": "text",
                              },
                              {
                                "text": "$100 - 4 keys",
                                "type": "text",
                              },
                            ],
                            "type": "column",
                          },
                        ],
                        "type": "column_set",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should record but not post a payment that did not succeed', async () => {
      await sut['handlePayment'](makeStripeEvent({ status: 'requires_payment_method' }));

      expect(databaseMock.createPayment).toHaveBeenCalledOnce();
      expect(databaseMock.getTotalLicenseCount).not.toHaveBeenCalled();
      expect(sent()).toEqual({ discord: [], mattermost: [], zulip: [] });
    });
  });

  describe('handlePullRequestNotification', () => {
    const pullRequestEvent = (action: string, pull_request: Record<string, unknown>, repository = immichRepo) =>
      githubEvent('pull_request', { action, sender, repository, pull_request });

    it('should reject an unknown slug', async () => {
      await expect(sut.onGithub(pullRequestEvent('opened', makePullRequest()), 'wrong-slug')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(sent()).toEqual({ discord: [], mattermost: [], zulip: [] });
    });

    it('should post an opened non-draft PR (Green) with its body', async () => {
      await sut.onGithub(pullRequestEvent('opened', makePullRequest()), 'github-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "991483093179445350",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "icon_url": "https://avatars.githubusercontent.com/u/1?v=4",
                      "name": "alextran1502",
                      "url": "https://github.com/alextran1502",
                    },
                    "color": 5763719,
                    "description": "This PR adds a thing.",
                    "title": "[immich-app/immich] Pull request opened: #1234 feat: add thing",
                    "url": "https://github.com/immich-app/immich/pull/1234",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "i1fbjrqj67n1ibx4f6isuioguc",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#57f287",
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "size": "small",
                        "text": "##### [[immich-app/immich] Pull request opened: #1234 feat: add thing](https://github.com/immich-app/immich/pull/1234)",
                        "type": "text",
                      },
                      {
                        "text": "This PR adds a thing.",
                        "type": "text",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post an opened draft PR (Grey) with its body', async () => {
      await sut.onGithub(pullRequestEvent('opened', makePullRequest({ draft: true })), 'github-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "991483093179445350",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "icon_url": "https://avatars.githubusercontent.com/u/1?v=4",
                      "name": "alextran1502",
                      "url": "https://github.com/alextran1502",
                    },
                    "color": 9807270,
                    "description": "This PR adds a thing.",
                    "title": "[immich-app/immich] Pull request opened: #1234 feat: add thing",
                    "url": "https://github.com/immich-app/immich/pull/1234",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "i1fbjrqj67n1ibx4f6isuioguc",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#95a5a6",
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "size": "small",
                        "text": "##### [[immich-app/immich] Pull request opened: #1234 feat: add thing](https://github.com/immich-app/immich/pull/1234)",
                        "type": "text",
                      },
                      {
                        "text": "This PR adds a thing.",
                        "type": "text",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post a merged PR (Purple) as "merged" without its body', async () => {
      await sut.onGithub(
        pullRequestEvent('closed', makePullRequest({ merged: true, merged_at: '2026-01-02T00:00:00Z' })),
        'github-slug',
      );
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "991483093179445350",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "icon_url": "https://avatars.githubusercontent.com/u/1?v=4",
                      "name": "alextran1502",
                      "url": "https://github.com/alextran1502",
                    },
                    "color": 10181046,
                    "description": undefined,
                    "title": "[immich-app/immich] Pull request merged: #1234 feat: add thing",
                    "url": "https://github.com/immich-app/immich/pull/1234",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "i1fbjrqj67n1ibx4f6isuioguc",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#9b59b6",
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "size": "small",
                        "text": "##### [[immich-app/immich] Pull request merged: #1234 feat: add thing](https://github.com/immich-app/immich/pull/1234)",
                        "type": "text",
                      },
                      undefined,
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post a closed unmerged PR (Red) without its body', async () => {
      await sut.onGithub(pullRequestEvent('closed', makePullRequest({ merged: false })), 'github-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "991483093179445350",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "icon_url": "https://avatars.githubusercontent.com/u/1?v=4",
                      "name": "alextran1502",
                      "url": "https://github.com/alextran1502",
                    },
                    "color": 15548997,
                    "description": undefined,
                    "title": "[immich-app/immich] Pull request closed: #1234 feat: add thing",
                    "url": "https://github.com/immich-app/immich/pull/1234",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "i1fbjrqj67n1ibx4f6isuioguc",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#ed4245",
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "size": "small",
                        "text": "##### [[immich-app/immich] Pull request closed: #1234 feat: add thing](https://github.com/immich-app/immich/pull/1234)",
                        "type": "text",
                      },
                      undefined,
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post a closed PR with unknown merge state without a colour', async () => {
      await sut.onGithub(pullRequestEvent('closed', makePullRequest({ merged: null })), 'github-slug');

      const { discord, mattermost } = sent();
      expect(discord).toHaveLength(1);
      expect(mattermost).toHaveLength(1);
      expect((discord[0].message as { embeds: { color?: number }[] }).embeds[0].color).toBeUndefined();
      expect((mattermost[0].props!.mm_blocks as { accent_color?: string }[])[0].accent_color).toBeUndefined();
    });

    it('should post a PR converted to draft (Grey) without its body', async () => {
      await sut.onGithub(pullRequestEvent('converted_to_draft', makePullRequest({ draft: true })), 'github-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "991483093179445350",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "icon_url": "https://avatars.githubusercontent.com/u/1?v=4",
                      "name": "alextran1502",
                      "url": "https://github.com/alextran1502",
                    },
                    "color": 9807270,
                    "description": undefined,
                    "title": "[immich-app/immich] Pull request converted_to_draft: #1234 feat: add thing",
                    "url": "https://github.com/immich-app/immich/pull/1234",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "i1fbjrqj67n1ibx4f6isuioguc",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#95a5a6",
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "size": "small",
                        "text": "##### [[immich-app/immich] Pull request converted_to_draft: #1234 feat: add thing](https://github.com/immich-app/immich/pull/1234)",
                        "type": "text",
                      },
                      undefined,
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post a PR marked ready for review (Green) without its body', async () => {
      await sut.onGithub(pullRequestEvent('ready_for_review', makePullRequest()), 'github-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "991483093179445350",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "icon_url": "https://avatars.githubusercontent.com/u/1?v=4",
                      "name": "alextran1502",
                      "url": "https://github.com/alextran1502",
                    },
                    "color": 5763719,
                    "description": undefined,
                    "title": "[immich-app/immich] Pull request ready_for_review: #1234 feat: add thing",
                    "url": "https://github.com/immich-app/immich/pull/1234",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "i1fbjrqj67n1ibx4f6isuioguc",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#57f287",
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "size": "small",
                        "text": "##### [[immich-app/immich] Pull request ready_for_review: #1234 feat: add thing](https://github.com/immich-app/immich/pull/1234)",
                        "type": "text",
                      },
                      undefined,
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should truncate a long body to 500 characters', async () => {
      await sut.onGithub(pullRequestEvent('opened', makePullRequest({ body: 'x'.repeat(600) })), 'github-slug');

      const { discord, mattermost } = sent();
      const expected = 'x'.repeat(497) + '...';
      expect((discord[0].message as { embeds: { description?: string }[] }).embeds[0].description).toBe(expected);
      expect((mattermost[0].props!.mm_blocks as { content: { text: string }[] }[])[0].content[2].text).toBe(expected);
    });

    it('should omit the body of an opened PR when it is empty', async () => {
      await sut.onGithub(pullRequestEvent('opened', makePullRequest({ body: null })), 'github-slug');

      const { discord, mattermost } = sent();
      expect((discord[0].message as { embeds: { description?: string }[] }).embeds[0].description).toBeUndefined();
      expect((mattermost[0].props!.mm_blocks as { content: unknown[] }[])[0].content).toHaveLength(3);
      expect((mattermost[0].props!.mm_blocks as { content: unknown[] }[])[0].content[2]).toBeUndefined();
    });

    it('should ignore other PR actions', async () => {
      await sut.onGithub(pullRequestEvent('synchronize', makePullRequest()), 'github-slug');
      expect(sent()).toEqual({ discord: [], mattermost: [], zulip: [] });
    });

    it('should post a private immich repo PR to Mattermost only', async () => {
      await sut.onGithub(pullRequestEvent('opened', makePullRequest(), immichPrivateRepo), 'github-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [],
          "mattermost": [
            {
              "channelId": "i1fbjrqj67n1ibx4f6isuioguc",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#57f287",
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "size": "small",
                        "text": "##### [[immich-app/immich-private] Pull request opened: #1234 feat: add thing](https://github.com/immich-app/immich/pull/1234)",
                        "type": "text",
                      },
                      {
                        "text": "This PR adds a thing.",
                        "type": "text",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post a FUTO fhs-core PR to the FHS Mattermost channel only', async () => {
      await sut.onGithub(pullRequestEvent('opened', makePullRequest(), fhsCoreRepo), 'github-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [],
          "mattermost": [
            {
              "channelId": "b3dajyaywffymb8updr8sb64ay",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#57f287",
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "size": "small",
                        "text": "##### [[futo-org/fhs-core] Pull request opened: #1234 feat: add thing](https://github.com/immich-app/immich/pull/1234)",
                        "type": "text",
                      },
                      {
                        "text": "This PR adds a thing.",
                        "type": "text",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should ignore PRs from unrelated repositories', async () => {
      await sut.onGithub(pullRequestEvent('opened', makePullRequest(), unrelatedRepo), 'github-slug');
      expect(sent()).toEqual({ discord: [], mattermost: [], zulip: [] });
    });
  });

  describe('handleIssueNotification', () => {
    const issueEvent = (action: string, repository = immichRepo) =>
      githubEvent('issues', { action, sender, repository, issue });

    it('should post an opened issue (Green) with its body', async () => {
      await sut.onGithub(issueEvent('opened'), 'github-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "991483015958106202",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "icon_url": "https://avatars.githubusercontent.com/u/1?v=4",
                      "name": "alextran1502",
                      "url": "https://github.com/alextran1502",
                    },
                    "color": 5763719,
                    "description": "Steps to reproduce: open the timeline.",
                    "title": "[immich-app/immich] Issue opened: #42 Bug: thumbnails missing",
                    "url": "https://github.com/immich-app/immich/issues/42",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "zpn38kj84pyg3bmbj7d66kdnge",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#57f287",
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "size": "small",
                        "text": "##### [[immich-app/immich] Issue opened: #42 Bug: thumbnails missing](https://github.com/immich-app/immich/issues/42)",
                        "type": "text",
                      },
                      {
                        "text": "Steps to reproduce: open the timeline.",
                        "type": "text",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post a reopened issue (DarkGreen) without its body', async () => {
      await sut.onGithub(issueEvent('reopened'), 'github-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "991483015958106202",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "icon_url": "https://avatars.githubusercontent.com/u/1?v=4",
                      "name": "alextran1502",
                      "url": "https://github.com/alextran1502",
                    },
                    "color": 2067276,
                    "description": undefined,
                    "title": "[immich-app/immich] Issue reopened: #42 Bug: thumbnails missing",
                    "url": "https://github.com/immich-app/immich/issues/42",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "zpn38kj84pyg3bmbj7d66kdnge",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#1f8b4c",
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "size": "small",
                        "text": "##### [[immich-app/immich] Issue reopened: #42 Bug: thumbnails missing](https://github.com/immich-app/immich/issues/42)",
                        "type": "text",
                      },
                      undefined,
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post a closed issue (NotQuiteBlack) without its body', async () => {
      await sut.onGithub(issueEvent('closed'), 'github-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "991483015958106202",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "icon_url": "https://avatars.githubusercontent.com/u/1?v=4",
                      "name": "alextran1502",
                      "url": "https://github.com/alextran1502",
                    },
                    "color": 2303786,
                    "description": undefined,
                    "title": "[immich-app/immich] Issue closed: #42 Bug: thumbnails missing",
                    "url": "https://github.com/immich-app/immich/issues/42",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "zpn38kj84pyg3bmbj7d66kdnge",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#23272a",
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "size": "small",
                        "text": "##### [[immich-app/immich] Issue closed: #42 Bug: thumbnails missing](https://github.com/immich-app/immich/issues/42)",
                        "type": "text",
                      },
                      undefined,
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should ignore other issue actions', async () => {
      await sut.onGithub(issueEvent('edited'), 'github-slug');
      expect(sent()).toEqual({ discord: [], mattermost: [], zulip: [] });
    });

    it('should ignore issues in private repositories', async () => {
      await sut.onGithub(issueEvent('opened', immichPrivateRepo), 'github-slug');
      expect(sent()).toEqual({ discord: [], mattermost: [], zulip: [] });
    });
  });

  describe('handleDiscussionNotification', () => {
    const discussionEvent = (action: string, repository = immichRepo) =>
      githubEvent('discussion', { action, sender, repository, discussion });

    it('should post a created discussion (Orange) with its body', async () => {
      await sut.onGithub(discussionEvent('created'), 'github-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "991483015958106202",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "icon_url": "https://avatars.githubusercontent.com/u/1?v=4",
                      "name": "alextran1502",
                      "url": "https://github.com/alextran1502",
                    },
                    "color": 15105570,
                    "description": "It would be nice if the timeline were nicer.",
                    "title": "[immich-app/immich] Discussion created: #7 Feature: nicer timeline",
                    "url": "https://github.com/immich-app/immich/discussions/7",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "zpn38kj84pyg3bmbj7d66kdnge",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#e67e22",
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "size": "small",
                        "text": "##### [[immich-app/immich] Discussion created: #7 Feature: nicer timeline](https://github.com/immich-app/immich/discussions/7)",
                        "type": "text",
                      },
                      {
                        "text": "It would be nice if the timeline were nicer.",
                        "type": "text",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post a reopened discussion (DarkOrange) without its body', async () => {
      await sut.onGithub(discussionEvent('reopened'), 'github-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "991483015958106202",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "icon_url": "https://avatars.githubusercontent.com/u/1?v=4",
                      "name": "alextran1502",
                      "url": "https://github.com/alextran1502",
                    },
                    "color": 11027200,
                    "description": undefined,
                    "title": "[immich-app/immich] Discussion reopened: #7 Feature: nicer timeline",
                    "url": "https://github.com/immich-app/immich/discussions/7",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "zpn38kj84pyg3bmbj7d66kdnge",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#a84300",
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "size": "small",
                        "text": "##### [[immich-app/immich] Discussion reopened: #7 Feature: nicer timeline](https://github.com/immich-app/immich/discussions/7)",
                        "type": "text",
                      },
                      undefined,
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post a deleted discussion (NotQuiteBlack) without its body', async () => {
      await sut.onGithub(discussionEvent('deleted'), 'github-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "991483015958106202",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "icon_url": "https://avatars.githubusercontent.com/u/1?v=4",
                      "name": "alextran1502",
                      "url": "https://github.com/alextran1502",
                    },
                    "color": 2303786,
                    "description": undefined,
                    "title": "[immich-app/immich] Discussion deleted: #7 Feature: nicer timeline",
                    "url": "https://github.com/immich-app/immich/discussions/7",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "zpn38kj84pyg3bmbj7d66kdnge",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#23272a",
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "size": "small",
                        "text": "##### [[immich-app/immich] Discussion deleted: #7 Feature: nicer timeline](https://github.com/immich-app/immich/discussions/7)",
                        "type": "text",
                      },
                      undefined,
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post an answered discussion (Green) without its body', async () => {
      await sut.onGithub(discussionEvent('answered'), 'github-slug');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "991483015958106202",
              "message": {
                "embeds": [
                  {
                    "author": {
                      "icon_url": "https://avatars.githubusercontent.com/u/1?v=4",
                      "name": "alextran1502",
                      "url": "https://github.com/alextran1502",
                    },
                    "color": 5763719,
                    "description": undefined,
                    "title": "[immich-app/immich] Discussion answered: #7 Feature: nicer timeline",
                    "url": "https://github.com/immich-app/immich/discussions/7",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "zpn38kj84pyg3bmbj7d66kdnge",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": "#57f287",
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "size": "small",
                        "text": "##### [[immich-app/immich] Discussion answered: #7 Feature: nicer timeline](https://github.com/immich-app/immich/discussions/7)",
                        "type": "text",
                      },
                      undefined,
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should ignore other discussion actions', async () => {
      await sut.onGithub(discussionEvent('edited'), 'github-slug');
      expect(sent()).toEqual({ discord: [], mattermost: [], zulip: [] });
    });

    it('should ignore discussions in private repositories', async () => {
      await sut.onGithub(discussionEvent('created', immichPrivateRepo), 'github-slug');
      expect(sent()).toEqual({ discord: [], mattermost: [], zulip: [] });
    });
  });

  describe('handleReleaseNotification', () => {
    const releaseEvent = (release: Record<string, unknown>, repository = immichRepo, action = 'published') =>
      githubEvent('release', { action, sender, repository, release });

    beforeEach(() => {
      vitest.spyOn(_, 'sample').mockReturnValue(releaseMessage as never);
    });

    it('should post an immich minor release to releases, announcements, Mattermost and Zulip', async () => {
      await sut.onGithub(releaseEvent(makeRelease()), 'github-slug');

      expect(_.sample).toHaveBeenCalledWith(ReleaseMessages);
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "991477056791658567",
              "crosspost": true,
              "message": {
                "embeds": [
                  {
                    "author": {
                      "icon_url": "https://avatars.githubusercontent.com/u/1?v=4",
                      "name": "alextran1502",
                      "url": "https://github.com/alextran1502",
                    },
                    "description": "A day with a release is a good day!",
                    "title": "[immich-app/immich] New release: v1.2.0",
                    "url": "https://github.com/immich-app/immich/releases/tag/v1.2.0",
                  },
                ],
              },
            },
            {
              "channelId": "991930592843272342",
              "crosspost": true,
              "message": {
                "embeds": [
                  {
                    "author": {
                      "icon_url": "https://avatars.githubusercontent.com/u/1?v=4",
                      "name": "alextran1502",
                      "url": "https://github.com/alextran1502",
                    },
                    "description": "A day with a release is a good day!",
                    "title": "[immich-app/immich] New release: v1.2.0",
                    "url": "https://github.com/immich-app/immich/releases/tag/v1.2.0",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "97d9ihrnb3rwbcoob6erhdfrcr",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": undefined,
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "text": "##### [[immich-app/immich] New release: v1.2.0](https://github.com/immich-app/immich/releases/tag/v1.2.0)",
                        "type": "text",
                      },
                      {
                        "size": "small",
                        "text": "A day with a release is a good day!",
                        "type": "text",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [
            {
              "content": "A day with a release is a good day! https://github.com/immich-app/immich/releases/tag/v1.2.0",
              "stream": 54,
              "topic": "release",
            },
          ],
        }
      `);
    });

    it('should post an immich patch release without an announcement', async () => {
      await sut.onGithub(
        releaseEvent(
          makeRelease({
            name: 'v1.2.3',
            tag_name: 'v1.2.3',
            html_url: 'https://github.com/immich-app/immich/releases/tag/v1.2.3',
          }),
        ),
        'github-slug',
      );
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "991477056791658567",
              "crosspost": true,
              "message": {
                "embeds": [
                  {
                    "author": {
                      "icon_url": "https://avatars.githubusercontent.com/u/1?v=4",
                      "name": "alextran1502",
                      "url": "https://github.com/alextran1502",
                    },
                    "description": "A day with a release is a good day!",
                    "title": "[immich-app/immich] New release: v1.2.3",
                    "url": "https://github.com/immich-app/immich/releases/tag/v1.2.3",
                  },
                ],
              },
            },
          ],
          "mattermost": [
            {
              "channelId": "97d9ihrnb3rwbcoob6erhdfrcr",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": undefined,
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "text": "##### [[immich-app/immich] New release: v1.2.3](https://github.com/immich-app/immich/releases/tag/v1.2.3)",
                        "type": "text",
                      },
                      {
                        "size": "small",
                        "text": "A day with a release is a good day!",
                        "type": "text",
                      },
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [
            {
              "content": "A day with a release is a good day! https://github.com/immich-app/immich/releases/tag/v1.2.3",
              "stream": 54,
              "topic": "release",
            },
          ],
        }
      `);
    });

    it('should post an immich prerelease without an announcement', async () => {
      await sut.onGithub(
        releaseEvent(
          makeRelease({
            name: 'v1.3.0-rc.1',
            tag_name: 'v1.3.0-rc.1',
            html_url: 'https://github.com/immich-app/immich/releases/tag/v1.3.0-rc.1',
          }),
        ),
        'github-slug',
      );

      const { discord, mattermost, zulip } = sent();
      expect(discord.map(({ channelId }) => channelId)).toEqual(['991477056791658567']);
      expect(mattermost.map(({ channelId }) => channelId)).toEqual(['97d9ihrnb3rwbcoob6erhdfrcr']);
      expect(zulip).toHaveLength(1);
    });

    it('should fall back to the tag name when the release has no name', async () => {
      await sut.onGithub(releaseEvent(makeRelease({ name: null })), 'github-slug');

      const { discord } = sent();
      expect((discord[0].message as { embeds: { title: string }[] }).embeds[0].title).toBe(
        '[immich-app/immich] New release: v1.2.0',
      );
    });

    it('should keep the raw description on Discord but shorten it for Mattermost', async () => {
      vitest.spyOn(_, 'sample').mockReturnValue('y'.repeat(600) as never);

      await sut.onGithub(releaseEvent(makeRelease()), 'github-slug');

      const { discord, mattermost, zulip } = sent();
      expect((discord[0].message as { embeds: { description: string }[] }).embeds[0].description).toBe('y'.repeat(600));
      expect((discord[1].message as { embeds: { description: string }[] }).embeds[0].description).toBe('y'.repeat(600));
      expect((mattermost[0].props!.mm_blocks as { content: { text: string }[] }[])[0].content[2].text).toBe(
        'y'.repeat(497) + '...',
      );
      expect(zulip[0].content).toBe(`${'y'.repeat(600)} https://github.com/immich-app/immich/releases/tag/v1.2.0`);
    });

    it('should post a private immich-app release to Mattermost only, without a description', async () => {
      await sut.onGithub(
        releaseEvent(
          makeRelease({ html_url: 'https://github.com/immich-app/immich-private/releases/tag/v1.2.0' }),
          immichPrivateRepo,
        ),
        'github-slug',
      );

      expect(_.sample).not.toHaveBeenCalled();
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [],
          "mattermost": [
            {
              "channelId": "97d9ihrnb3rwbcoob6erhdfrcr",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": undefined,
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "text": "##### [[immich-app/immich-private] New release: v1.2.0](https://github.com/immich-app/immich-private/releases/tag/v1.2.0)",
                        "type": "text",
                      },
                      undefined,
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
              "silent": true,
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should post a public non-main immich-app release to Discord and Mattermost without a description', async () => {
      await sut.onGithub(
        releaseEvent(
          makeRelease({ html_url: 'https://github.com/immich-app/static-pages/releases/tag/v1.2.0' }),
          immichOtherRepo,
        ),
        'github-slug',
      );

      const { discord, mattermost, zulip } = sent();
      expect(discord.map(({ channelId }) => channelId)).toEqual(['991477056791658567']);
      expect((discord[0].message as { embeds: { description?: string }[] }).embeds[0].description).toBeUndefined();
      expect(mattermost.map(({ channelId }) => channelId)).toEqual(['97d9ihrnb3rwbcoob6erhdfrcr']);
      expect(zulip).toEqual([]);
    });

    it('should post a FUTO fhs-core release to the FHS Mattermost channel only', async () => {
      await sut.onGithub(
        releaseEvent(
          makeRelease({ html_url: 'https://github.com/futo-org/fhs-core/releases/tag/v1.2.0' }),
          fhsCoreRepo,
        ),
        'github-slug',
      );
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [],
          "mattermost": [
            {
              "channelId": "ggnayby577f45reuin1j143xsc",
              "message": "",
              "props": {
                "mm_blocks": [
                  {
                    "accent_color": undefined,
                    "border": true,
                    "content": [
                      {
                        "content": [
                          {
                            "alt_text": "alextran1502's avatar",
                            "horizontal_alignment": "left",
                            "image_style": "person",
                            "max_width": 26,
                            "size": "small",
                            "type": "image",
                            "url": "https://avatars.githubusercontent.com/u/1?v=4",
                          },
                          {
                            "is_subtle": true,
                            "text": "[alextran1502](https://github.com/alextran1502)",
                            "type": "text",
                          },
                        ],
                        "flow": "horizontal",
                        "gap": "small",
                        "type": "container",
                      },
                      {
                        "text": "##### [[futo-org/fhs-core] New release: v1.2.0](https://github.com/futo-org/fhs-core/releases/tag/v1.2.0)",
                        "type": "text",
                      },
                      undefined,
                    ],
                    "gap": "small",
                    "type": "container",
                  },
                ],
              },
            },
          ],
          "zulip": [],
        }
      `);
    });

    it('should ignore releases that are not published', async () => {
      await sut.onGithub(releaseEvent(makeRelease(), immichRepo, 'edited'), 'github-slug');
      expect(sent()).toEqual({ discord: [], mattermost: [], zulip: [] });
    });

    it('should ignore published releases without a sender', async () => {
      await sut.onGithub(
        githubEvent('release', { action: 'published', sender: null, repository: immichRepo, release: makeRelease() }),
        'github-slug',
      );
      expect(sent()).toEqual({ discord: [], mattermost: [], zulip: [] });
    });
  });

  describe('handleWorkflowRunFailure', () => {
    const workflowRunEvent = (conclusion: string, action = 'completed') =>
      githubEvent('workflow_run', {
        action,
        repository: immichRepo,
        workflow_run: {
          conclusion,
          check_suite_node_id: 'CS_node_1',
          display_title: 'Release v1.2.0',
          html_url: 'https://github.com/immich-app/immich/actions/runs/1',
        },
      });

    it('should post a failed release workflow (Red) to the team alerts channel', async () => {
      githubMock.getCheckSuiteTriggerCommit.mockResolvedValue('v1.2.0');
      githubMock.getLatestReleaseTag.mockResolvedValue('v1.2.0');

      await sut.onGithub(workflowRunEvent('failure'), 'github-slug');

      expect(githubMock.getCheckSuiteTriggerCommit).toHaveBeenCalledWith('immich-app', 'immich', 'CS_node_1');
      expect(githubMock.getLatestReleaseTag).toHaveBeenCalledWith('immich-app', 'immich');
      expect(sent()).toMatchInlineSnapshot(`
        {
          "discord": [
            {
              "channelId": "1360190417643110460",
              "message": {
                "embeds": [
                  {
                    "color": 15548997,
                    "description": "[Release v1.2.0](https://github.com/immich-app/immich/actions/runs/1)",
                    "title": "Release Workflow Failed <a:peepoAlert:1367804942638776423>",
                  },
                ],
              },
            },
          ],
          "mattermost": [],
          "zulip": [],
        }
      `);
    });

    it('should ignore failures that were not triggered by the latest release', async () => {
      githubMock.getCheckSuiteTriggerCommit.mockResolvedValue('abc123');
      githubMock.getLatestReleaseTag.mockResolvedValue('v1.2.0');

      await sut.onGithub(workflowRunEvent('failure'), 'github-slug');

      expect(sent()).toEqual({ discord: [], mattermost: [], zulip: [] });
    });

    it('should ignore successful workflow runs', async () => {
      await sut.onGithub(workflowRunEvent('success'), 'github-slug');

      expect(githubMock.getCheckSuiteTriggerCommit).not.toHaveBeenCalled();
      expect(sent()).toEqual({ discord: [], mattermost: [], zulip: [] });
    });

    it('should swallow errors from the GitHub API', async () => {
      githubMock.getCheckSuiteTriggerCommit.mockRejectedValue(new Error('boom'));

      await expect(sut.onGithub(workflowRunEvent('timed_out'), 'github-slug')).resolves.toBeUndefined();
      expect(sent()).toEqual({ discord: [], mattermost: [], zulip: [] });
    });
  });
});
