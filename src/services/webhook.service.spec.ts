import { Logger, UnauthorizedException } from '@nestjs/common';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import type { WebhookOrderPaidPayload } from '@polar-sh/sdk/models/components/webhookorderpaidpayload.js';
import { CommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import _ from 'lodash';
import { Constants, ReleaseMessages } from 'src/constants';
import { DiscordCommands } from 'src/discord/commands';
import { GithubStatusComponent, GithubStatusIncident, PaymentIntent, StripeBase } from 'src/dtos/webhook.dto';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';
import {
  FourthwallOrderCreateWebhook,
  FourthwallOrderUpdateWebhook,
  IFourthwallRepository,
} from 'src/interfaces/fourthwall.interface';
import { IGithubInterface, PullRequestBaseEvent } from 'src/interfaces/github.interface';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { IOutlineInterface } from 'src/interfaces/outline.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';
import { ZulipApiError } from 'src/repositories/zulip.client';
import { GithubService } from 'src/services/github.service';
import { NotificationService } from 'src/services/notification.service';
import { BackfillReport, WebhookService, formatBackfillReport } from 'src/services/webhook.service';
import { Mocked, afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

/**
 * Characterization tests: these pin the CURRENT payloads sent to Discord, Mattermost and Zulip
 * for every notification path in WebhookService. They intentionally pin quirks of the current
 * implementation (trailing `undefined` entries in Mattermost `content` arrays, etc). If a snapshot
 * changes during a refactor, the refactor drifted - fix the code, never the snapshot.
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
  getMirrorConversation: vitest.fn(),
  getMirrorConversationByDiscord: vitest.fn(),
  getMirrorConversationByZulipTopic: vitest.fn(),
  getMirrorConversationsByAnchors: vitest.fn(),
  getActiveMirrorThreads: vitest.fn(),
  createMirrorConversation: vitest.fn(),
  updateMirrorConversation: vitest.fn(),
  removeMirrorConversation: vitest.fn(),
  createMirrorMessages: vitest.fn(),
  getMirrorMessagesByDiscordIds: vitest.fn(),
  getMirrorMessagesByZulipIds: vitest.fn(),
  getMirrorMessagesByConversation: vitest.fn(),
  getNewestMirrorZulipMessageId: vitest.fn(),
  updateMirrorMessages: vitest.fn(),
  markMirrorMessagesDeleted: vitest.fn(),
  removeMirrorMessages: vitest.fn(),
  getMirrorZulipHighWater: vitest.fn(),
  getMirrorDiscordHighWater: vitest.fn(),
});

const newDiscordMockRepository = (): Mocked<IDiscordInterface> => ({
  login: vitest.fn(),
  isReady: vitest.fn().mockReturnValue(true),
  onHandlerError: vitest.fn(),
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
  getPullRequest: vitest.fn(),
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
  listEmoji: vitest.fn(),
  streamChannels: vitest.fn(),
  joinChannel: vitest.fn(),
  registerCommand: vitest.fn() as any,
  runCommand: vitest.fn(),
  openDialog: vitest.fn(),
  submitDialog: vitest.fn(),
});

const newZulipMockRepository = (): Mocked<IZulipInterface> => ({
  init: vitest.fn(),
  isInitialised: vitest.fn().mockReturnValue(false),
  createEmote: vitest.fn(),
  sendMessage: vitest.fn(),
  getMessage: vitest.fn(),
  updateMessage: vitest.fn(),
  listEmoji: vitest.fn(),
  getSubscriptions: vitest.fn(),
  getOwnUser: vitest.fn(),
  getMessages: vitest.fn(),
  registerQueue: vitest.fn(),
  getEvents: vitest.fn(),
  deleteQueue: vitest.fn(),
  deleteMessage: vitest.fn(),
  uploadFile: vitest.fn(),
  downloadUpload: vitest.fn(),
  getStreamMessagesBefore: vitest.fn(),
  getEmojiCodes: vitest.fn(),
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
      new NotificationService(discordMock, mattermostMock, zulipMock),
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

    it('should report a failed insert to Discord bot-spam and the Zulip bot topic, and carry on', async () => {
      vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      zulipMock.isInitialised.mockReturnValue(true);
      databaseMock.createPayment.mockRejectedValue(new Error('invalid input syntax for type integer: "@**all**"'));

      await sut['handlePayment'](makeStripeEvent({ status: 'requires_payment_method' }));

      expect(sent()).toEqual({
        discord: [
          {
            channelId: DiscordChannel.BotSpam,
            message: 'Failed to insert payment into database: Error: invalid input syntax for type integer: "@**all**"',
          },
        ],
        mattermost: [],
        zulip: [
          {
            stream: Constants.Zulip.Streams.ImmichAlerts,
            topic: 'bot',
            content:
              'Failed to insert payment into database:\n~~~ quote\nError: invalid input syntax for type integer: "@​**all**"\n~~~',
          },
        ],
      });
    });

    it('should fall back to no licences when the count fails, and report it', async () => {
      vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      databaseMock.getTotalLicenseCount.mockRejectedValue(new Error('connection lost'));

      await sut['handlePayment'](makeStripeEvent());

      const [report, purchase] = sent().discord;
      expect(report).toEqual({
        channelId: DiscordChannel.BotSpam,
        message: 'Failed to insert payment into database: Error: connection lost',
      });
      expect(purchase).toBeUndefined();
      const [post] = mattermostMock.send.mock.calls[0];
      expect(JSON.stringify(post.props)).toContain('$0 - 0 keys');
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
                    "title": "[immich-app/immich] Pull request converted to draft: #1234 feat: add thing",
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
                        "text": "##### [[immich-app/immich] Pull request converted to draft: #1234 feat: add thing](https://github.com/immich-app/immich/pull/1234)",
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
                    "title": "[immich-app/immich] Pull request ready for review: #1234 feat: add thing",
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
                        "text": "##### [[immich-app/immich] Pull request ready for review: #1234 feat: add thing](https://github.com/immich-app/immich/pull/1234)",
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

    it.each([
      { action: 'converted_to_draft', words: 'converted to draft' },
      { action: 'ready_for_review', words: 'ready for review' },
    ])('should write $action as words on Zulip too', async ({ action, words }) => {
      zulipMock.isInitialised.mockReturnValue(true);
      databaseMock.getPullRequestById.mockResolvedValue(undefined);

      await sut.onGithub(pullRequestEvent(action, makePullRequest()), 'github-slug');

      expect(sent().zulip.map(({ content }) => content)).toEqual([
        expect.stringContaining(`Pull request ${words}: #1234 feat: add thing`),
      ]);
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

    it('should fail the webhook when the Zulip announcement fails, after the other posts were made', async () => {
      zulipMock.sendMessage.mockRejectedValue(
        new Error('Zulip POST /api/v1/messages failed with 429 RATE_LIMIT_HIT: API usage exceeded rate limit'),
      );

      await expect(sut.onGithub(releaseEvent(makeRelease()), 'github-slug')).rejects.toThrow('RATE_LIMIT_HIT');

      await vitest.waitFor(() => {
        expect(discordMock.sendMessage).toHaveBeenCalledTimes(2);
        expect(mattermostMock.send).toHaveBeenCalledOnce();
      });
      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
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
  describe('handlePullRequestZulipTopic', () => {
    const PR_STREAM = 112;
    const TOPIC = '#1234: feat: add thing';
    const FIRST_MESSAGE =
      '**[feat: add thing](https://github.com/immich-app/immich/pull/1234)**\n\n~~~ quote\nThis PR adds a thing.\n~~~';

    const storedPullRequest = (overrides: Record<string, unknown> = {}) =>
      ({
        nodeId: 'PR_node_1234',
        organization: 'immich-app',
        repository: 'immich',
        number: 1234,
        discordThreadId: 'thread-1',
        zulipMessageId: 42,
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        closedAt: null,
        ...overrides,
      }) as any;

    const event = (
      action: string,
      overrides: Record<string, unknown> = {},
      extra: Record<string, unknown> = {},
      name: EmitterWebhookEvent['name'] = 'pull_request',
    ) =>
      githubEvent(name, { action, sender, repository: immichRepo, pull_request: makePullRequest(overrides), ...extra });

    const refusal = (code: string, msg: string) => new ZulipApiError(400, code, msg, 'PATCH /api/v1/messages/42');
    const noPermission = () => refusal('BAD_REQUEST', "You don't have permission to edit this message");
    const timeLimit = () =>
      refusal(
        'MOVE_MESSAGES_TIME_LIMIT_EXCEEDED',
        'You only have permission to move the 2/5 most recent messages in this topic.',
      );
    const noResolvePermission = () =>
      refusal('BAD_REQUEST', "You don't have permission to resolve topics in this channel.");
    const noMovePermission = () => refusal('BAD_REQUEST', "You don't have permission to move this message");
    const topicTimeLimit = () => refusal('BAD_REQUEST', "The time limit for editing this message's topic has passed.");
    const translated = () => refusal('BAD_REQUEST', 'Sie haben keine Berechtigung, Themen in diesem Kanal zu lösen.');

    const topicPosts = () =>
      zulipMock.sendMessage.mock.calls.map(([payload]) => payload).filter(({ stream }) => stream === PR_STREAM);

    beforeEach(() => {
      zulipMock.isInitialised.mockReturnValue(true);
      zulipMock.sendMessage.mockResolvedValue({ id: 500 });
      zulipMock.getMessage.mockResolvedValue({ id: 42, topic: TOPIC });
      zulipMock.updateMessage.mockResolvedValue();
      databaseMock.getPullRequestById.mockResolvedValue(storedPullRequest());
      vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    });

    describe('opened', () => {
      beforeEach(() => {
        databaseMock.getPullRequestById.mockResolvedValue(storedPullRequest({ zulipMessageId: null }));
      });

      it('should open a topic with the full title linked and the quoted body, and store the message ID', async () => {
        await sut.onGithub(event('opened'), 'github-slug');

        expect(topicPosts()).toEqual([{ stream: PR_STREAM, topic: TOPIC, content: FIRST_MESSAGE }]);
        expect(databaseMock.updatePullRequest).toHaveBeenCalledWith({ nodeId: 'PR_node_1234', zulipMessageId: 500 });
        expect(zulipMock.getMessage).not.toHaveBeenCalled();
        expect(zulipMock.updateMessage).not.toHaveBeenCalled();
      });

      it('should post only the linked title when the PR has no body', async () => {
        await sut.onGithub(event('opened', { body: null }), 'github-slug');

        expect(topicPosts()).toEqual([
          {
            stream: PR_STREAM,
            topic: TOPIC,
            content: '**[feat: add thing](https://github.com/immich-app/immich/pull/1234)**',
          },
        ]);
      });

      it('should keep the whole of a long title in the first message, which the topic name cuts', async () => {
        const title = 'feat(server): a title that goes on well past the sixty character mark of Zulip';

        await sut.onGithub(event('opened', { title, body: null }), 'github-slug');

        expect(topicPosts()).toEqual([
          {
            stream: PR_STREAM,
            topic: '#1234: feat(server): a title that goes on well past the...',
            content: `**[${title}](https://github.com/immich-app/immich/pull/1234)**`,
          },
        ]);
      });

      it('should keep a title from ending the link early or adding one of its own', async () => {
        await sut.onGithub(
          event('opened', { title: 'fix: lone ] bracket [x](https://evil.example) @**all**', body: null }),
          'github-slug',
        );

        expect(topicPosts()[0].content).toBe(
          '**[fix: lone &#93; bracket &#91;x&#93;(https://evil.example) @\u200B**all**](https://github.com/immich-app/immich/pull/1234)**',
        );
      });

      it('should neutralise mentions in the body and keep its fences inside the quote', async () => {
        await sut.onGithub(event('opened', { body: 'cc @**all** and #**general**\n~~~\ncode\n~~~' }), 'github-slug');

        expect(topicPosts()[0].content).toBe(
          '**[feat: add thing](https://github.com/immich-app/immich/pull/1234)**\n\n~~~~ quote\ncc @\u200B**all** and #\u200B**general**\n~~~\ncode\n~~~\n~~~~',
        );
      });

      it('should cap the body at 2000 code points', async () => {
        await sut.onGithub(event('opened', { body: 'x'.repeat(2001) }), 'github-slug');

        expect(topicPosts()[0].content).toBe(
          `**[feat: add thing](https://github.com/immich-app/immich/pull/1234)**\n\n~~~ quote\n${'x'.repeat(1997)}...\n~~~`,
        );
      });

      it('should ignore a PR opened by a bot, as Discord does', async () => {
        await sut.onGithub(event('opened', {}, { sender: { ...sender, type: 'Bot' } }), 'github-slug');

        expect(topicPosts()).toEqual([]);
        expect(databaseMock.updatePullRequest).not.toHaveBeenCalledWith(
          expect.objectContaining({ zulipMessageId: 500 }),
        );
      });

      it('should do nothing for another action on a PR without a topic', async () => {
        await sut.onGithub(event('closed'), 'github-slug');

        expect(topicPosts()).toEqual([]);
        expect(zulipMock.getMessage).not.toHaveBeenCalled();
        expect(zulipMock.updateMessage).not.toHaveBeenCalled();
      });

      it('should still open the topic and store the ID when the Discord path rejects, then rethrow that error', async () => {
        databaseMock.getPullRequestById.mockResolvedValue(
          storedPullRequest({ zulipMessageId: null, discordThreadId: null }),
        );
        const discordError = new Error('Missing Access');
        discordMock.createThread.mockRejectedValue(discordError);

        await expect(sut.onGithub(event('opened'), 'github-slug')).rejects.toBe(discordError);

        expect(topicPosts()).toEqual([{ stream: PR_STREAM, topic: TOPIC, content: FIRST_MESSAGE }]);
        expect(databaseMock.updatePullRequest).toHaveBeenCalledWith({ nodeId: 'PR_node_1234', zulipMessageId: 500 });
        const topicPost = zulipMock.sendMessage.mock.calls.findIndex(([{ stream }]) => stream === PR_STREAM);
        expect(discordMock.createThread.mock.invocationCallOrder[0]).toBeLessThan(
          zulipMock.sendMessage.mock.invocationCallOrder[topicPost],
        );
        expect(Logger.prototype.error).not.toHaveBeenCalled();
      });

      it('should log and carry on when the topic cannot be opened, without storing an ID', async () => {
        zulipMock.sendMessage.mockRejectedValue(
          new ZulipApiError(503, 'UNKNOWN_ERROR', 'Service Unavailable', 'POST /api/v1/messages'),
        );

        await expect(sut.onGithub(event('opened'), 'github-slug')).resolves.toBeUndefined();

        expect(databaseMock.updatePullRequest).not.toHaveBeenCalledWith(
          expect.objectContaining({ zulipMessageId: expect.anything() }),
        );
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'Zulip failed while updating the topic of pull request #1234',
          expect.any(ZulipApiError),
        );
      });

      it('should log a failure that is not Zulip as an unexpected error, so that a bug is not read as an outage', async () => {
        databaseMock.updatePullRequest.mockRejectedValue(new Error('relation "pull_request" does not exist'));

        await expect(sut.onGithub(event('opened'), 'github-slug')).resolves.toBeUndefined();

        expect(Logger.prototype.error).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'Unexpected error while updating the Zulip topic of pull request #1234',
          expect.any(Error),
        );
      });
    });

    describe('topic name', () => {
      beforeEach(() => {
        databaseMock.getPullRequestById.mockResolvedValue(storedPullRequest({ zulipMessageId: null }));
      });

      it("should cut the name to 58 characters, Zulip's 60 less the resolved prefix, not the 100 Discord allows", async () => {
        const title = 'feat(server): a title that goes on well past the sixty character mark of Zulip';

        await sut.onGithub(event('opened', { title }), 'github-slug');

        const [{ topic }] = topicPosts();
        expect(topic).toBe('#1234: feat(server): a title that goes on well past the...');
        expect(topic).toHaveLength(58);
        expect(discordMock.updateThread).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ name: `#1234: ${title}` }),
        );
      });

      it('should count multibyte characters as one each and never cut one in half', async () => {
        const fits = '🎉'.repeat(51);
        await sut.onGithub(event('opened', { title: fits }), 'github-slug');
        expect(topicPosts()[0].topic).toBe(`#1234: ${fits}`);
        expect([...topicPosts()[0].topic!]).toHaveLength(58);

        zulipMock.sendMessage.mockClear();
        await sut.onGithub(event('opened', { title: '🎉'.repeat(52) }), 'github-slug');
        expect(topicPosts()[0].topic).toBe(`#1234: ${'🎉'.repeat(48)}...`);
        expect([...topicPosts()[0].topic!]).toHaveLength(58);
        expect(topicPosts()[0].topic!.isWellFormed()).toBe(true);
      });

      it('should trim trailing whitespace, as Zulip does before storing a name', async () => {
        await sut.onGithub(event('opened', { title: 'x'.repeat(48) + '   ' }), 'github-slug');

        expect(topicPosts()[0].topic).toBe(`#1234: ${'x'.repeat(48)}`);
      });
    });

    describe('closed', () => {
      it('should post the merge notice in the current topic, then resolve the whole topic', async () => {
        await sut.onGithub(event('closed', { merged: true, merged_at: '2026-01-02T00:00:00Z' }), 'github-slug');

        expect(zulipMock.getMessage).toHaveBeenCalledWith(42);
        expect(topicPosts()).toEqual([
          {
            stream: PR_STREAM,
            topic: TOPIC,
            content: 'Pull request has been merged by [@alextran1502](https://github.com/alextran1502)',
          },
        ]);
        expect(zulipMock.updateMessage).toHaveBeenCalledOnce();
        expect(zulipMock.updateMessage).toHaveBeenCalledWith(42, { topic: `✔ ${TOPIC}`, propagateMode: 'change_all' });
        expect(zulipMock.sendMessage.mock.invocationCallOrder.at(-1)).toBeLessThan(
          zulipMock.updateMessage.mock.invocationCallOrder[0],
        );
      });

      it('should say "closed" when the PR was not merged', async () => {
        await sut.onGithub(event('closed'), 'github-slug');

        expect(topicPosts()[0].content).toBe(
          'Pull request has been closed by [@alextran1502](https://github.com/alextran1502)',
        );
        expect(zulipMock.updateMessage).toHaveBeenCalledWith(42, { topic: `✔ ${TOPIC}`, propagateMode: 'change_all' });
      });

      it('should follow a human rename: post there and resolve that name, not the stored title', async () => {
        zulipMock.getMessage.mockResolvedValue({ id: 42, topic: '#1234: the thing we discussed' });

        await sut.onGithub(event('closed'), 'github-slug');

        expect(topicPosts()[0].topic).toBe('#1234: the thing we discussed');
        expect(zulipMock.updateMessage).toHaveBeenCalledWith(42, {
          topic: '✔ #1234: the thing we discussed',
          propagateMode: 'change_all',
        });
      });

      it('should not resolve a topic a human already resolved', async () => {
        zulipMock.getMessage.mockResolvedValue({ id: 42, topic: `✔ ${TOPIC}` });

        await sut.onGithub(event('closed'), 'github-slug');

        expect(topicPosts()[0].topic).toBe(`✔ ${TOPIC}`);
        expect(zulipMock.updateMessage).not.toHaveBeenCalled();
      });

      it('should resolve a maximal name the bot gave, multibyte characters included, within the 60 of Zulip', async () => {
        databaseMock.getPullRequestById.mockResolvedValue(storedPullRequest({ zulipMessageId: null }));
        await sut.onGithub(event('opened', { title: '🎉'.repeat(60) }), 'github-slug');
        const [{ topic }] = topicPosts();
        expect([...topic!]).toHaveLength(58);

        databaseMock.getPullRequestById.mockResolvedValue(storedPullRequest());
        zulipMock.getMessage.mockResolvedValue({ id: 42, topic: topic! });
        zulipMock.sendMessage.mockClear();
        await sut.onGithub(event('closed'), 'github-slug');

        const [, { topic: resolved }] = zulipMock.updateMessage.mock.calls[0];
        expect(resolved).toBe(`✔ ${topic}`);
        expect([...resolved!]).toHaveLength(60);
        expect(resolved!.isWellFormed()).toBe(true);
      });

      it('should send the full "✔ " + name past 60 for a topic a human renamed to the full 60, and let Zulip truncate', async () => {
        const topic = `#1234: ${'x'.repeat(53)}`;
        zulipMock.getMessage.mockResolvedValue({ id: 42, topic });

        await sut.onGithub(event('closed'), 'github-slug');

        const [, { topic: resolved }] = zulipMock.updateMessage.mock.calls[0];
        expect(resolved).toBe(`✔ ${topic}`);
        expect([...resolved!]).toHaveLength(62);
      });

      it('should still post the notice and resolve the topic when the Discord path rejects, then rethrow that error', async () => {
        const discordError = new Error('You are being rate limited.');
        discordMock.sendMessage.mockRejectedValue(discordError);

        await expect(
          sut.onGithub(event('closed', { merged: true, merged_at: '2026-01-02T00:00:00Z' }), 'github-slug'),
        ).rejects.toBe(discordError);

        expect(topicPosts().map(({ content }) => content)).toEqual([
          'Pull request has been merged by [@alextran1502](https://github.com/alextran1502)',
        ]);
        expect(zulipMock.updateMessage).toHaveBeenCalledWith(42, { topic: `✔ ${TOPIC}`, propagateMode: 'change_all' });
        expect(Logger.prototype.error).not.toHaveBeenCalledWith(
          expect.stringContaining('pull request #1234'),
          expect.anything(),
        );
      });

      it('should run the Discord path first and leave it unchanged', async () => {
        await sut.onGithub(event('closed'), 'github-slug');

        expect(discordMock.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-1' }));
        expect(discordMock.setThreadArchived).toHaveBeenCalledWith(
          { channelId: expect.any(String), threadId: 'thread-1' },
          true,
        );
        expect(discordMock.setThreadArchived.mock.invocationCallOrder[0]).toBeLessThan(
          zulipMock.getMessage.mock.invocationCallOrder[0],
        );
      });
    });

    describe('reopened', () => {
      it('should post the notice in the resolved topic, then unresolve it', async () => {
        zulipMock.getMessage.mockResolvedValue({ id: 42, topic: `✔ ${TOPIC}` });

        await sut.onGithub(event('reopened'), 'github-slug');

        expect(topicPosts()).toEqual([
          {
            stream: PR_STREAM,
            topic: `✔ ${TOPIC}`,
            content: 'Pull request has been reopened by [@alextran1502](https://github.com/alextran1502)',
          },
        ]);
        expect(zulipMock.updateMessage).toHaveBeenCalledWith(42, { topic: TOPIC, propagateMode: 'change_all' });
      });

      it('should not rename a topic that is not resolved', async () => {
        await sut.onGithub(event('reopened'), 'github-slug');

        expect(topicPosts()).toHaveLength(1);
        expect(zulipMock.updateMessage).not.toHaveBeenCalled();
      });
    });

    it('should post the draft notice and nothing else on converted_to_draft', async () => {
      await sut.onGithub(event('converted_to_draft'), 'github-slug');

      expect(topicPosts()).toEqual([
        { stream: PR_STREAM, topic: TOPIC, content: 'Pull request has been converted to draft' },
      ]);
      expect(zulipMock.updateMessage).not.toHaveBeenCalled();
    });

    describe('edited', () => {
      it('should rename the topic, then rewrite the title in the first message, when the title changed', async () => {
        await sut.onGithub(
          event('edited', { title: 'feat: add the thing' }, { changes: { title: { from: 'feat: add thing' } } }),
          'github-slug',
        );

        expect(zulipMock.getMessage).toHaveBeenCalledWith(42);
        expect(zulipMock.updateMessage.mock.calls).toEqual([
          [42, { topic: '#1234: feat: add the thing', propagateMode: 'change_all' }],
          [
            42,
            {
              content:
                '**[feat: add the thing](https://github.com/immich-app/immich/pull/1234)**\n\n~~~ quote\nThis PR adds a thing.\n~~~',
            },
          ],
        ]);
        expect(topicPosts()).toEqual([]);
      });

      it('should keep a resolved topic resolved when renaming it', async () => {
        zulipMock.getMessage.mockResolvedValue({ id: 42, topic: `✔ ${TOPIC}` });

        await sut.onGithub(
          event('edited', { title: 'feat: add the thing' }, { changes: { title: { from: 'feat: add thing' } } }),
          'github-slug',
        );

        expect(zulipMock.updateMessage).toHaveBeenCalledWith(42, {
          topic: '✔ #1234: feat: add the thing',
          propagateMode: 'change_all',
        });
      });

      it('should edit the first message, keeping its title, when the body changed', async () => {
        await sut.onGithub(
          event('edited', { body: 'Now with tests.' }, { changes: { body: { from: 'This PR adds a thing.' } } }),
          'github-slug',
        );

        expect(zulipMock.updateMessage).toHaveBeenCalledOnce();
        expect(zulipMock.updateMessage).toHaveBeenCalledWith(42, {
          content:
            '**[feat: add thing](https://github.com/immich-app/immich/pull/1234)**\n\n~~~ quote\nNow with tests.\n~~~',
        });
      });

      it('should rename and edit in two separate requests when both changed', async () => {
        await sut.onGithub(
          event(
            'edited',
            { title: 'feat: add the thing', body: 'Now with tests.' },
            { changes: { title: { from: 'feat: add thing' }, body: { from: 'This PR adds a thing.' } } },
          ),
          'github-slug',
        );

        expect(zulipMock.updateMessage.mock.calls).toEqual([
          [42, { topic: '#1234: feat: add the thing', propagateMode: 'change_all' }],
          [
            42,
            {
              content:
                '**[feat: add the thing](https://github.com/immich-app/immich/pull/1234)**\n\n~~~ quote\nNow with tests.\n~~~',
            },
          ],
        ]);
      });

      it('should leave a human rename alone, without reading the topic, when neither title nor body changed', async () => {
        zulipMock.getMessage.mockResolvedValue({ id: 42, topic: '#1234: the thing we discussed' });

        await sut.onGithub(
          event('edited', {}, { changes: { base: { ref: { from: 'main' }, sha: { from: 'abc' } } } }),
          'github-slug',
        );

        expect(zulipMock.getMessage).not.toHaveBeenCalled();
        expect(zulipMock.updateMessage).not.toHaveBeenCalled();
      });

      it.each(['synchronize', 'ready_for_review', 'labeled', 'assigned'])(
        'should not rename the topic on %s even when the title drifted: only a title edit renames, by decision',
        async (action) => {
          zulipMock.getMessage.mockResolvedValue({ id: 42, topic: '#1234: STALE NAME' });

          await sut.onGithub(event(action, { title: 'feat: the current title' }), 'github-slug');

          expect(zulipMock.getMessage).not.toHaveBeenCalled();
          expect(zulipMock.updateMessage).not.toHaveBeenCalled();
          expect(topicPosts()).toEqual([]);
          expect(discordMock.updateThread).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ name: '#1234: feat: the current title' }),
          );
        },
      );

      it.each([
        {
          what: 'review',
          name: 'pull_request_review' as const,
          extra: { review: { id: 1, body: 'LGTM' }, changes: { body: { from: 'LGTM?' } } },
        },
        {
          what: 'review comment',
          name: 'pull_request_review_comment' as const,
          extra: { comment: { id: 1, body: 'nit' }, changes: { body: { from: 'nitpick' } } },
        },
      ])(
        'should ignore an edited $what, whose changes are about itself, without reading the topic',
        async ({ name, extra }) => {
          await sut.onGithub(event('edited', {}, extra, name), 'github-slug');

          expect(zulipMock.getMessage).not.toHaveBeenCalled();
          expect(zulipMock.updateMessage).not.toHaveBeenCalled();
          expect(topicPosts()).toEqual([]);
        },
      );
    });

    it('should not read the topic for a review, which is not echoed there', async () => {
      await sut.onGithub(
        event('submitted', {}, { review: { id: 1, state: 'approved' } }, 'pull_request_review'),
        'github-slug',
      );

      expect(zulipMock.getMessage).not.toHaveBeenCalled();
      expect(zulipMock.updateMessage).not.toHaveBeenCalled();
      expect(topicPosts()).toEqual([]);
    });

    describe('skipped', () => {
      it('should do nothing when Zulip is not initialised', async () => {
        zulipMock.isInitialised.mockReturnValue(false);

        await sut.onGithub(event('closed'), 'github-slug');

        expect(zulipMock.getMessage).not.toHaveBeenCalled();
        expect(zulipMock.sendMessage).not.toHaveBeenCalled();
        expect(discordMock.setThreadArchived).toHaveBeenCalledOnce();
      });

      it('should do nothing for a PR the database does not know', async () => {
        databaseMock.getPullRequestById.mockResolvedValue(undefined);

        await sut.onGithub(event('closed'), 'github-slug');

        expect(zulipMock.getMessage).not.toHaveBeenCalled();
        expect(topicPosts()).toEqual([]);
      });

      it('should do nothing for another immich-app repository', async () => {
        await sut.onGithub(
          githubEvent('pull_request', {
            action: 'closed',
            sender,
            repository: immichOtherRepo,
            pull_request: makePullRequest(),
          }),
          'github-slug',
        );

        expect(zulipMock.getMessage).not.toHaveBeenCalled();
        expect(topicPosts()).toEqual([]);
      });

      it('should do nothing for a private repository', async () => {
        await sut.onGithub(
          githubEvent('pull_request', {
            action: 'closed',
            sender,
            repository: immichPrivateRepo,
            pull_request: makePullRequest(),
          }),
          'github-slug',
        );

        expect(zulipMock.getMessage).not.toHaveBeenCalled();
        expect(topicPosts()).toEqual([]);
      });
    });

    describe('degrading without permissions', () => {
      it.each([
        { reason: 'edit permission', error: noPermission },
        { reason: 'move time limit code', error: timeLimit },
        { reason: 'can_resolve_topics_group', error: noResolvePermission },
        { reason: 'can_move_messages_between_topics_group', error: noMovePermission },
        { reason: 'move_messages_within_stream_limit_seconds', error: topicTimeLimit },
        { reason: 'translated message', error: translated },
      ])('should post a plain message and carry on when the resolve is refused ($reason)', async ({ error }) => {
        zulipMock.updateMessage.mockRejectedValue(error());

        await expect(
          sut.onGithub(event('closed', { merged: true, merged_at: '2026-01-02T00:00:00Z' }), 'github-slug'),
        ).resolves.toBeUndefined();

        expect(topicPosts()).toEqual([
          {
            stream: PR_STREAM,
            topic: TOPIC,
            content: 'Pull request has been merged by [@alextran1502](https://github.com/alextran1502)',
          },
          { stream: PR_STREAM, topic: TOPIC, content: `The topic could not be resolved automatically: ${error().msg}` },
        ]);
        expect(Logger.prototype.warn).toHaveBeenCalledOnce();
        expect(Logger.prototype.warn).toHaveBeenCalledWith(
          `Zulip refused to rename topic "${TOPIC}" to "✔ ${TOPIC}": ${error().message}`,
        );
        expect(Logger.prototype.error).not.toHaveBeenCalled();
        expect(discordMock.setThreadArchived).toHaveBeenCalledOnce();
        expect(databaseMock.updatePullRequest).toHaveBeenCalledWith({
          nodeId: 'PR_node_1234',
          closedAt: expect.any(Date),
        });
      });

      it('should post a plain message and carry on when the unresolve is refused', async () => {
        zulipMock.getMessage.mockResolvedValue({ id: 42, topic: `✔ ${TOPIC}` });
        zulipMock.updateMessage.mockRejectedValue(timeLimit());

        await expect(sut.onGithub(event('reopened'), 'github-slug')).resolves.toBeUndefined();

        expect(topicPosts().map(({ content }) => content)).toEqual([
          'Pull request has been reopened by [@alextran1502](https://github.com/alextran1502)',
          'The topic could not be unresolved automatically: You only have permission to move the 2/5 most recent messages in this topic.',
        ]);
        expect(topicPosts().every(({ topic }) => topic === `✔ ${TOPIC}`)).toBe(true);
        expect(Logger.prototype.warn).toHaveBeenCalledOnce();
      });

      it('should post the new title as a plain message when the rename is refused', async () => {
        zulipMock.updateMessage.mockRejectedValueOnce(timeLimit());

        await expect(
          sut.onGithub(
            event('edited', { title: 'feat: add the thing' }, { changes: { title: { from: 'feat: add thing' } } }),
            'github-slug',
          ),
        ).resolves.toBeUndefined();

        expect(topicPosts()).toEqual([
          { stream: PR_STREAM, topic: TOPIC, content: 'Pull request has been renamed to: feat: add the thing' },
        ]);
        expect(Logger.prototype.warn).toHaveBeenCalledOnce();
      });

      it('should neutralise mentions in the title when it is posted as a message after a refused rename', async () => {
        zulipMock.updateMessage.mockRejectedValue(timeLimit());

        await sut.onGithub(
          event('edited', { title: 'ping @**all** and #**general**' }, { changes: { title: { from: 'x' } } }),
          'github-slug',
        );

        expect(zulipMock.updateMessage).toHaveBeenCalledWith(42, {
          topic: '#1234: ping @**all** and #**general**',
          propagateMode: 'change_all',
        });
        expect(topicPosts().map(({ content }) => content)).toEqual([
          'Pull request has been renamed to: ping @​**all** and #​**general**',
        ]);
      });

      it('should post the full title, not the name the topic would have had, after a refused rename', async () => {
        zulipMock.updateMessage.mockRejectedValue(timeLimit());
        const title = 'feat(server): a title that goes on well past the sixty character mark of Zulip';

        await sut.onGithub(event('edited', { title }, { changes: { title: { from: 'x' } } }), 'github-slug');

        expect(topicPosts().map(({ content }) => content)).toEqual([`Pull request has been renamed to: ${title}`]);
      });

      it('should log and carry on when the fallback message itself cannot be posted', async () => {
        zulipMock.updateMessage.mockRejectedValue(timeLimit());
        zulipMock.sendMessage.mockImplementation(async ({ content }) => {
          if (content.startsWith('The topic could not be resolved')) {
            throw new ZulipApiError(502, 'UNKNOWN_ERROR', 'Bad Gateway', 'POST /api/v1/messages');
          }
          return { id: 500 };
        });

        await expect(sut.onGithub(event('closed'), 'github-slug')).resolves.toBeUndefined();

        expect(topicPosts().map(({ content }) => content)).toEqual([
          'Pull request has been closed by [@alextran1502](https://github.com/alextran1502)',
          `The topic could not be resolved automatically: ${timeLimit().msg}`,
        ]);
        expect(Logger.prototype.warn).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          `Could not post the fallback message in Zulip topic "${TOPIC}" after the refused rename`,
          expect.any(ZulipApiError),
        );
        expect(discordMock.setThreadArchived).toHaveBeenCalledOnce();
      });

      it.each([
        { reason: 'a programming error', error: () => refusal('BAD_REQUEST', 'Nothing to change') },
        { reason: 'an empty topic', error: () => refusal('BAD_REQUEST', "Topic can't be empty") },
        { reason: 'a deleted message', error: () => refusal('BAD_REQUEST', 'Invalid message(s)') },
        { reason: 'a bad parameter', error: () => refusal('REQUEST_VARIABLE_INVALID', 'Invalid propagate_mode') },
        {
          reason: 'a server error',
          error: () => new ZulipApiError(500, 'INTERNAL_ERROR', 'Internal server error', 'PATCH /api/v1/messages/42'),
        },
      ])('should treat $reason on the rename as an outage: an error and no fallback message', async ({ error }) => {
        zulipMock.updateMessage.mockRejectedValue(error());

        await expect(sut.onGithub(event('closed'), 'github-slug')).resolves.toBeUndefined();

        expect(topicPosts()).toHaveLength(1);
        expect(Logger.prototype.warn).not.toHaveBeenCalled();
        expect(Logger.prototype.error).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          `Could not rename Zulip topic "${TOPIC}" to "✔ ${TOPIC}"`,
          expect.any(ZulipApiError),
        );
      });

      it('should post the notice in the empty "general chat" topic and not try to resolve it', async () => {
        zulipMock.getMessage.mockResolvedValue({ id: 42, topic: '' });

        await sut.onGithub(event('closed'), 'github-slug');

        expect(topicPosts()).toEqual([
          {
            stream: PR_STREAM,
            topic: '',
            content: 'Pull request has been closed by [@alextran1502](https://github.com/alextran1502)',
          },
        ]);
        expect(zulipMock.updateMessage).not.toHaveBeenCalled();
        expect(Logger.prototype.warn).not.toHaveBeenCalled();
        expect(Logger.prototype.error).not.toHaveBeenCalled();
      });

      it.each([
        'The time limit for editing this message has passed',
        'The time limit for editing this message has past',
        'Your organization has turned off message editing',
      ])('should log and carry on, with no fallback, when the edit is refused (%s)', async (msg) => {
        zulipMock.updateMessage.mockRejectedValue(refusal('BAD_REQUEST', msg));

        await expect(
          sut.onGithub(
            event('edited', { body: 'Now with tests.' }, { changes: { body: { from: 'This PR adds a thing.' } } }),
            'github-slug',
          ),
        ).resolves.toBeUndefined();

        expect(topicPosts()).toEqual([]);
        expect(Logger.prototype.warn).toHaveBeenCalledOnce();
        expect(Logger.prototype.warn).toHaveBeenCalledWith(
          `Zulip refused to edit message 42: Zulip PATCH /api/v1/messages/42 failed with 400 BAD_REQUEST: ${msg}`,
        );
        expect(Logger.prototype.error).not.toHaveBeenCalled();
      });

      it('should still edit the body after a refused rename', async () => {
        zulipMock.updateMessage.mockRejectedValueOnce(noPermission()).mockResolvedValueOnce();

        await sut.onGithub(
          event(
            'edited',
            { title: 'feat: add the thing', body: 'Now with tests.' },
            { changes: { title: { from: 'feat: add thing' }, body: { from: 'This PR adds a thing.' } } },
          ),
          'github-slug',
        );

        expect(zulipMock.updateMessage).toHaveBeenCalledTimes(2);
        expect(zulipMock.updateMessage).toHaveBeenLastCalledWith(42, {
          content:
            '**[feat: add the thing](https://github.com/immich-app/immich/pull/1234)**\n\n~~~ quote\nNow with tests.\n~~~',
        });
        expect(topicPosts().map(({ content }) => content)).toEqual([
          'Pull request has been renamed to: feat: add the thing',
        ]);
      });

      it.each([
        {
          reason: 'a 5xx',
          error: () => new ZulipApiError(502, 'UNKNOWN_ERROR', 'Bad Gateway', 'PATCH /api/v1/messages/42'),
        },
        {
          reason: 'a rate limit that outlasted the retries',
          error: () =>
            new ZulipApiError(429, 'RATE_LIMIT_HIT', 'API usage exceeded rate limit', 'PATCH /api/v1/messages/42'),
        },
        {
          reason: 'a timeout',
          error: () => new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        },
      ])('should log an outage ($reason) on a move as an error, with no fallback message', async ({ error }) => {
        zulipMock.updateMessage.mockRejectedValue(error());

        await expect(sut.onGithub(event('closed'), 'github-slug')).resolves.toBeUndefined();

        expect(topicPosts()).toHaveLength(1);
        expect(Logger.prototype.warn).not.toHaveBeenCalled();
        expect(Logger.prototype.error).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          `Could not rename Zulip topic "${TOPIC}" to "✔ ${TOPIC}"`,
          expect.anything(),
        );
      });

      it('should log an outage on an edit as an error', async () => {
        zulipMock.updateMessage.mockRejectedValue(new Error('fetch failed'));

        await expect(
          sut.onGithub(
            event('edited', { body: 'Now with tests.' }, { changes: { body: { from: 'This PR adds a thing.' } } }),
            'github-slug',
          ),
        ).resolves.toBeUndefined();

        expect(Logger.prototype.error).toHaveBeenCalledWith('Could not edit Zulip message 42', expect.any(Error));
        expect(topicPosts()).toEqual([]);
      });

      it('should never fail the webhook when the topic cannot even be read', async () => {
        zulipMock.getMessage.mockRejectedValue(new TypeError('fetch failed'));

        await expect(sut.onGithub(event('closed'), 'github-slug')).resolves.toBeUndefined();

        expect(topicPosts()).toEqual([]);
        expect(zulipMock.updateMessage).not.toHaveBeenCalled();
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'Zulip failed while updating the topic of pull request #1234',
          expect.any(TypeError),
        );
        expect(discordMock.setThreadArchived).toHaveBeenCalledOnce();
      });

      it('should never fail the webhook when the notice cannot be posted', async () => {
        zulipMock.sendMessage.mockRejectedValue(new Error('fetch failed'));

        await expect(sut.onGithub(event('closed'), 'github-slug')).resolves.toBeUndefined();

        expect(zulipMock.updateMessage).not.toHaveBeenCalled();
      });

      it.each([
        {
          reason: 'any other BAD_REQUEST',
          error: () => new ZulipApiError(400, 'BAD_REQUEST', 'Malformed request', 'GET /api/v1/messages/42'),
        },
        {
          reason: 'a 5xx',
          error: () => new ZulipApiError(502, 'UNKNOWN_ERROR', 'Bad Gateway', 'GET /api/v1/messages/42'),
        },
        { reason: 'a network failure', error: () => new TypeError('fetch failed') },
        {
          reason: 'a timeout',
          error: () => new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        },
      ])('should log $reason on the read as a Zulip failure and not rebuild the topic', async ({ error }) => {
        zulipMock.getMessage.mockRejectedValue(error());

        await expect(sut.onGithub(event('closed'), 'github-slug')).resolves.toBeUndefined();

        expect(topicPosts()).toEqual([]);
        expect(zulipMock.updateMessage).not.toHaveBeenCalled();
        expect(databaseMock.updatePullRequest).not.toHaveBeenCalledWith(
          expect.objectContaining({ zulipMessageId: expect.anything() }),
        );
        expect(Logger.prototype.warn).not.toHaveBeenCalled();
        expect(Logger.prototype.error).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'Zulip failed while updating the topic of pull request #1234',
          expect.anything(),
        );
      });
    });

    describe('first message deleted', () => {
      const gone = () => new ZulipApiError(400, 'BAD_REQUEST', 'Invalid message(s)', 'GET /api/v1/messages/42');

      beforeEach(() => {
        zulipMock.getMessage.mockRejectedValue(gone());
        let next = 500;
        zulipMock.sendMessage.mockImplementation(async ({ stream }) => ({ id: stream === PR_STREAM ? next++ : 1 }));
      });

      it('should rebuild the topic under the current title, store the new ID, then post and resolve there', async () => {
        await expect(
          sut.onGithub(event('closed', { merged: true, merged_at: '2026-01-02T00:00:00Z' }), 'github-slug'),
        ).resolves.toBeUndefined();

        expect(zulipMock.getMessage).toHaveBeenCalledOnce();
        expect(topicPosts()).toEqual([
          { stream: PR_STREAM, topic: TOPIC, content: FIRST_MESSAGE },
          {
            stream: PR_STREAM,
            topic: TOPIC,
            content: 'Pull request has been merged by [@alextran1502](https://github.com/alextran1502)',
          },
        ]);
        expect(databaseMock.updatePullRequest).toHaveBeenCalledWith({ nodeId: 'PR_node_1234', zulipMessageId: 500 });
        expect(zulipMock.updateMessage).toHaveBeenCalledOnce();
        expect(zulipMock.updateMessage).toHaveBeenCalledWith(500, {
          topic: `✔ ${TOPIC}`,
          propagateMode: 'change_all',
        });
        expect(Logger.prototype.warn).toHaveBeenCalledOnce();
        expect(Logger.prototype.warn).toHaveBeenCalledWith(
          'Zulip message 42 of pull request #1234 is gone (Invalid message(s)), recreating the topic',
        );
        expect(Logger.prototype.error).not.toHaveBeenCalled();
        expect(discordMock.setThreadArchived).toHaveBeenCalledOnce();
      });

      it('should rebuild with the current title and body on an edit, then apply the edit to the new message', async () => {
        await sut.onGithub(
          event(
            'edited',
            { title: 'feat: add the thing', body: 'Now with tests.' },
            { changes: { body: { from: 'This PR adds a thing.' } } },
          ),
          'github-slug',
        );

        expect(topicPosts()).toEqual([
          {
            stream: PR_STREAM,
            topic: '#1234: feat: add the thing',
            content:
              '**[feat: add the thing](https://github.com/immich-app/immich/pull/1234)**\n\n~~~ quote\nNow with tests.\n~~~',
          },
        ]);
        expect(databaseMock.updatePullRequest).toHaveBeenCalledWith({ nodeId: 'PR_node_1234', zulipMessageId: 500 });
        expect(zulipMock.updateMessage).toHaveBeenCalledOnce();
        expect(zulipMock.updateMessage).toHaveBeenCalledWith(500, {
          content:
            '**[feat: add the thing](https://github.com/immich-app/immich/pull/1234)**\n\n~~~ quote\nNow with tests.\n~~~',
        });
      });

      it('should log and carry on, keeping the dead ID, when the rebuild itself fails', async () => {
        zulipMock.sendMessage.mockReset().mockRejectedValue(new TypeError('fetch failed'));

        await expect(sut.onGithub(event('closed'), 'github-slug')).resolves.toBeUndefined();

        expect(databaseMock.updatePullRequest).not.toHaveBeenCalledWith(
          expect.objectContaining({ zulipMessageId: expect.anything() }),
        );
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          'Zulip failed while updating the topic of pull request #1234',
          expect.any(TypeError),
        );
        expect(discordMock.setThreadArchived).toHaveBeenCalledOnce();
      });
    });
  });

  describe('backfillPullRequests', () => {
    const BOTH = { discord: true, zulip: true };
    const DISCORD_ONLY = { discord: true, zulip: false };

    const open = (number: number, sender: 'User' | 'Bot' = 'User'): PullRequestBaseEvent => ({
      repository: { full_name: 'immich-app/immich' },
      sender: { type: sender },
      pull_request: {
        number,
        id: 1000 + number,
        node_id: `PR_node_${number}`,
        title: `PR ${number}`,
        body: `Body ${number}`,
        html_url: `https://github.com/immich-app/immich/pull/${number}`,
      },
    });

    const rows = new Map<string, Record<string, unknown>>();
    const track = (number: number, overrides: Record<string, unknown> = {}) =>
      rows.set(`PR_node_${number}`, {
        nodeId: `PR_node_${number}`,
        organization: 'immich-app',
        repository: 'immich',
        number,
        discordThreadId: null,
        zulipMessageId: null,
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        closedAt: null,
        ...overrides,
      });
    const row = (number: number) => rows.get(`PR_node_${number}`);
    const report = (overrides: Partial<BackfillReport>): BackfillReport => ({
      total: 0,
      threads: [],
      topics: [],
      skipped: [],
      failed: [],
      ...overrides,
    });

    beforeEach(() => {
      rows.clear();
      databaseMock.getPullRequestById.mockImplementation((nodeId) => Promise.resolve(rows.get(nodeId) as any));
      databaseMock.updatePullRequest.mockImplementation(({ nodeId, ...fields }) => {
        Object.assign(rows.get(nodeId)!, fields);
        return Promise.resolve();
      });
      discordMock.createThread.mockImplementation((_, { name }) => Promise.resolve({ threadId: `thread-${name}` }));
      zulipMock.isInitialised.mockReturnValue(true);
      zulipMock.sendMessage.mockImplementation(({ topic = '' }) =>
        Promise.resolve({ id: Number(topic.slice(1, topic.indexOf(':'))) + 500 }),
      );
      vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      vitest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    });

    it('should create the Discord thread and the Zulip topic a tracked pull request lacks, through the real paths, and report both', async () => {
      track(1);

      await expect(sut.backfillPullRequests([open(1)], BOTH)).resolves.toEqual(
        report({ total: 1, threads: [1], topics: [1] }),
      );

      expect(discordMock.createThread).toHaveBeenCalledExactlyOnceWith(Constants.Discord.Channels.TeamPullRequests, {
        name: '#1: PR 1',
        message: 'Body 1',
      });
      expect(discordMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        channelId: Constants.Discord.Channels.TeamPullRequests,
        threadId: 'thread-#1: PR 1',
        message: { content: 'https://github.com/immich-app/immich/pull/1', flags: [MessageFlags.SuppressEmbeds] },
        pin: true,
      });
      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        stream: Constants.Zulip.Streams.ImmichPullRequests,
        topic: '#1: PR 1',
        content: '**[PR 1](https://github.com/immich-app/immich/pull/1)**\n\n~~~ quote\nBody 1\n~~~',
      });
      expect(row(1)).toMatchObject({ discordThreadId: 'thread-#1: PR 1', zulipMessageId: 501 });
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it('should create only the Zulip topic for a pull request that has its thread, and not touch the thread', async () => {
      track(1, { discordThreadId: 'thread-old' });

      await expect(sut.backfillPullRequests([open(1)], BOTH)).resolves.toEqual(report({ total: 1, topics: [1] }));

      expect(discordMock.createThread).not.toHaveBeenCalled();
      expect(discordMock.updateThread).not.toHaveBeenCalled();
      expect(discordMock.sendMessage).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
      expect(row(1)).toMatchObject({ discordThreadId: 'thread-old', zulipMessageId: 501 });
    });

    it('should create only the Discord thread for a pull request that has its topic', async () => {
      track(1, { zulipMessageId: 42 });

      await expect(sut.backfillPullRequests([open(1)], BOTH)).resolves.toEqual(report({ total: 1, threads: [1] }));

      expect(discordMock.createThread).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      expect(zulipMock.getMessage).not.toHaveBeenCalled();
      expect(row(1)).toMatchObject({ discordThreadId: 'thread-#1: PR 1', zulipMessageId: 42 });
    });

    it('should skip a pull request that has both, without a call to either platform', async () => {
      track(1, { discordThreadId: 'thread-old', zulipMessageId: 42 });

      await expect(sut.backfillPullRequests([open(1)], BOTH)).resolves.toEqual(
        report({ total: 1, skipped: [{ number: 1, reason: 'already complete' }] }),
      );

      expect(discordMock.createThread).not.toHaveBeenCalled();
      expect(discordMock.updateThread).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      expect(databaseMock.getPullRequestById).toHaveBeenCalledOnce();
    });

    it('should skip a pull request that is not in the table, which neither path would create for', async () => {
      await expect(sut.backfillPullRequests([open(1)], BOTH)).resolves.toEqual(
        report({ total: 1, skipped: [{ number: 1, reason: 'not tracked' }] }),
      );

      expect(discordMock.createThread).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should skip a pull request opened by a bot, which neither path creates for', async () => {
      track(1);

      await expect(sut.backfillPullRequests([open(1, 'Bot')], BOTH)).resolves.toEqual(
        report({ total: 1, skipped: [{ number: 1, reason: 'opened by a bot' }] }),
      );

      expect(discordMock.createThread).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should create on Discord alone when asked for Discord alone, and report no Zulip side', async () => {
      track(1);
      track(2, { discordThreadId: 'thread-old' });

      await expect(sut.backfillPullRequests([open(1), open(2)], DISCORD_ONLY)).resolves.toEqual(
        report({ total: 2, threads: [1], topics: undefined, skipped: [{ number: 2, reason: 'already complete' }] }),
      );

      expect(discordMock.createThread).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      expect(row(1)).toMatchObject({ zulipMessageId: null });
    });

    it('should not ask Zulip when it is not initialised', async () => {
      zulipMock.isInitialised.mockReturnValue(false);
      track(1);

      await expect(sut.backfillPullRequests([open(1)], BOTH)).resolves.toEqual(
        report({ total: 1, threads: [1], topics: undefined }),
      );

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should carry on past a Discord rejection, log it by number, still create that Zulip topic, and report the failure', async () => {
      track(1);
      track(2);
      track(3);
      const error = new Error('rate limited');
      discordMock.createThread
        .mockResolvedValueOnce({ threadId: 'thread-1' })
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ threadId: 'thread-3' });

      await expect(sut.backfillPullRequests([open(1), open(2), open(3)], BOTH)).resolves.toEqual(
        report({ total: 3, threads: [1, 3], topics: [1, 2, 3], failed: [2] }),
      );

      expect(zulipMock.sendMessage.mock.calls.map(([{ topic }]) => topic)).toEqual([
        '#1: PR 1',
        '#2: PR 2',
        '#3: PR 3',
      ]);
      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith('Could not backfill pull request #2', error);
      expect(row(2)).toMatchObject({ discordThreadId: null, zulipMessageId: 502 });
    });

    it('should report a Zulip failure, which the Zulip path has logged, beside the thread it created', async () => {
      track(1);
      zulipMock.sendMessage.mockRejectedValue(new TypeError('fetch failed'));

      await expect(sut.backfillPullRequests([open(1)], BOTH)).resolves.toEqual(
        report({ total: 1, threads: [1], failed: [1] }),
      );

      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        'Zulip failed while updating the topic of pull request #1',
        expect.any(TypeError),
      );
    });

    it('should report a thread Discord did not create, and say so, since that path logs nothing', async () => {
      track(1);
      discordMock.createThread.mockResolvedValue({});

      await expect(sut.backfillPullRequests([open(1)], DISCORD_ONLY)).resolves.toEqual(
        report({ total: 1, topics: undefined, failed: [1] }),
      );

      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        'Could not backfill pull request #1: Discord created no thread',
      );
    });

    it('should report a lookup that fails as that pull request failing, and do the rest', async () => {
      track(2);
      databaseMock.getPullRequestById.mockRejectedValueOnce(new Error('db down'));

      await expect(sut.backfillPullRequests([open(1), open(2)], BOTH)).resolves.toEqual(
        report({ total: 2, threads: [2], topics: [2], failed: [1] }),
      );

      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        'Could not backfill pull request #1',
        expect.any(Error),
      );
    });

    it('should do nothing with no pull requests', async () => {
      await expect(sut.backfillPullRequests([], BOTH)).resolves.toEqual(report({ total: 0 }));

      expect(databaseMock.getPullRequestById).not.toHaveBeenCalled();
    });

    describe('formatBackfillReport', () => {
      it('should say what was created, skipped and failed, platform by platform asked', () => {
        expect(
          formatBackfillReport({
            total: 5,
            threads: [1],
            topics: [1, 2],
            skipped: [
              { number: 3, reason: 'not tracked' },
              { number: 4, reason: 'already complete' },
            ],
            failed: [5],
          }),
        ).toBe(
          'Backfill of 5 open pull requests done: created 1 Discord thread and 2 Zulip topics; skipped 2 (1 already complete, 1 not tracked); failed 1 (#5), see the log.',
        );
      });

      it('should name only the platforms asked', () => {
        expect(formatBackfillReport({ total: 2, threads: [1, 2], skipped: [], failed: [] })).toBe(
          'Backfill of 2 open pull requests done: created 2 Discord threads; skipped 0; failed 0.',
        );
        expect(formatBackfillReport({ total: 0, skipped: [], failed: [] })).toBe(
          'Backfill of 0 open pull requests done: created nothing, no platform was asked; skipped 0; failed 0.',
        );
      });

      it('should take a subject for one pull request', () => {
        expect(
          formatBackfillReport(
            { total: 1, threads: [], topics: [], skipped: [{ number: 1234, reason: 'opened by a bot' }], failed: [] },
            'pull request #1234',
          ),
        ).toBe(
          'Backfill of pull request #1234 done: created 0 Discord threads and 0 Zulip topics; skipped 1 (1 opened by a bot); failed 0.',
        );
      });
    });

    describe('/backfill-pull-requests on Discord', () => {
      const run = (pullRequests: PullRequestBaseEvent[]) => {
        const edit = vitest.fn().mockResolvedValue(undefined);
        const interaction = {
          deferReply: vitest.fn().mockResolvedValue({ edit }),
        } as unknown as CommandInteraction;
        const githubService = { getOpenPullRequests: vitest.fn().mockResolvedValue(pullRequests) };
        const commands = new DiscordCommands(
          undefined as never,
          undefined as never,
          undefined as never,
          githubService as unknown as GithubService,
          sut,
        );
        return { interaction, edit, result: commands.backfillPullRequests(interaction) };
      };

      it('should create the thread every open pull request lacks on Discord alone, and reply with the report', async () => {
        track(1);
        track(2, { discordThreadId: 'thread-old' });
        track(3);
        const backfill = vitest.spyOn(sut, 'backfillPullRequests');

        const { interaction, edit, result } = run([open(1), open(2), open(3), open(4)]);
        await result;

        expect(interaction.deferReply).toHaveBeenCalledExactlyOnceWith({ flags: [MessageFlags.Ephemeral] });
        expect(backfill).toHaveBeenCalledExactlyOnceWith([open(1), open(2), open(3), open(4)], DISCORD_ONLY);
        expect(discordMock.createThread.mock.calls.map(([, { name }]) => name)).toEqual(['#1: PR 1', '#3: PR 3']);
        expect(discordMock.updateThread).not.toHaveBeenCalled();
        expect(zulipMock.sendMessage).not.toHaveBeenCalled();
        expect(edit).toHaveBeenCalledExactlyOnceWith(
          'Backfill of 4 open pull requests done: created 2 Discord threads; skipped 2 (1 already complete, 1 not tracked); failed 0.',
        );
      });

      it('should report a pull request that fails rather than stop at it', async () => {
        track(1);
        track(2);
        discordMock.createThread.mockRejectedValueOnce(new Error('boom 1')).mockResolvedValueOnce({ threadId: 't2' });

        const { edit, result } = run([open(1), open(2)]);
        await result;

        expect(edit).toHaveBeenCalledExactlyOnceWith(
          'Backfill of 2 open pull requests done: created 1 Discord thread; skipped 0; failed 1 (#1), see the log.',
        );
      });

      it('should let a failure to list the pull requests through, with no reply', async () => {
        const edit = vitest.fn();
        const interaction = { deferReply: vitest.fn().mockResolvedValue({ edit }) } as unknown as CommandInteraction;
        const error = new Error('GitHub is down');
        const githubService = { getOpenPullRequests: vitest.fn().mockRejectedValue(error) };
        const commands = new DiscordCommands(
          undefined as never,
          undefined as never,
          undefined as never,
          githubService as unknown as GithubService,
          sut,
        );

        await expect(commands.backfillPullRequests(interaction)).rejects.toBe(error);
        expect(edit).not.toHaveBeenCalled();
      });
    });
  });
});
