import { Inject, Injectable, Logger, RawBodyRequest, UnauthorizedException } from '@nestjs/common';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import { WebhookOrderPaidPayload } from '@polar-sh/sdk/models/components/webhookorderpaidpayload.js';
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks.js';
import { MessageFlags, roleMention } from 'discord.js';
import { Request, Response } from 'express';
import _ from 'lodash';
import { DateTime } from 'luxon';
import semver from 'semver';
import { getConfig } from 'src/config';
import { Constants, GithubOrg, GithubRepo, ReleaseMessages } from 'src/constants';
import { GithubStatusComponent, GithubStatusIncident, PaymentIntent, StripeBase } from 'src/dtos/webhook.dto';
import { neutraliseZulipMentions, shorten, shortenCodePoints, toZulipQuote } from 'src/format';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import {
  FourthwallOrderCreateWebhook,
  FourthwallOrderUpdateWebhook,
  IFourthwallRepository,
} from 'src/interfaces/fourthwall.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { CommandWebhookRequest, DialogResponse, IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { Notification, NotificationAccent, NotificationAuthor } from 'src/interfaces/notification.interface';
import { IOutlineInterface } from 'src/interfaces/outline.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';
import { FourthwallRepository } from 'src/repositories/fourthwall.repository';
import { ZulipApiError } from 'src/repositories/zulip.client';
import { NotificationService } from 'src/services/notification.service';
import { makeLicenseFields, makeOrderFields, withErrorLogging } from 'src/util';

const isIncidentUpdate = (dto: GithubStatusComponent | GithubStatusIncident): dto is GithubStatusIncident => {
  return !!(dto as GithubStatusIncident).incident;
};

const isPaymentEvent = (payload: StripeBase): payload is StripeBase<PaymentIntent> =>
  payload.data.object.object === 'payment_intent';

const isImmichProduct = (description: string) => ['immich-server', 'immich-client'].includes(description);

const isMainRepo = (name: string) => name === 'immich-app/immich';

const getActionName = (action: string, pullRequest: { merged: boolean | null }) => {
  if (action === 'closed' && pullRequest.merged) {
    return 'merged';
  }
  return action;
};

type PullRequestEvent = EmitterWebhookEvent<
  'pull_request' | 'pull_request_review' | 'pull_request_review_comment' | 'pull_request_review_thread'
>['payload'];

type PullRequestEditedEvent = EmitterWebhookEvent<'pull_request.edited'>['payload'];

/** Review and review-comment events are also `edited`, with `changes` about the review or the comment, not the PR. */
const isPullRequestEdited = (dto: PullRequestEvent): dto is PullRequestEditedEvent =>
  dto.action === 'edited' && !('review' in dto) && !('comment' in dto);

type BaseEvent = {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
};

type GithubUser = { login: string; html_url: string; avatar_url: string };

const toAuthor = ({ login, html_url, avatar_url }: GithubUser): NotificationAuthor => ({
  name: login,
  url: html_url,
  iconUrl: avatar_url,
});

const getEventNotification = ({
  action,
  repositoryName,
  title,
  user,
  event,
  accent,
}: {
  action: string;
  repositoryName: string;
  title: string;
  user: GithubUser;
  event: BaseEvent;
  accent?: NotificationAccent;
}): Notification => ({
  kind: 'feed',
  accent,
  author: toAuthor(user),
  title: `[${repositoryName}] ${title} ${action}: #${event.number} ${event.title}`,
  url: event.html_url,
  body: (action === 'opened' || action === 'created') && event.body ? shorten(event.body, 500) : undefined,
});

const getIncidentAccent = ({ status, impact }: { status: string; impact: string }): NotificationAccent => {
  if (status === 'resolved') {
    return 'incident.resolved';
  }

  switch (impact) {
    case 'minor': {
      return 'incident.minor';
    }
    case 'major': {
      return 'incident.major';
    }
    default: {
      return 'incident.unknown';
    }
  }
};

const getPullRequestAccent = (
  dto: {
    action: 'opened' | 'closed' | 'converted_to_draft' | 'ready_for_review';
    isDraft: boolean;
    isMerged: boolean | null;
  },
  logger: Logger,
): NotificationAccent | undefined => {
  switch (dto.action) {
    case 'opened': {
      return dto.isDraft ? 'pr.draft' : 'pr.opened';
    }
    case 'closed': {
      if (dto.isMerged === null) {
        logger.error('Closed PR should have isMerged set.');
        return undefined;
      }
      return dto.isMerged ? 'pr.merged' : 'pr.closed';
    }
    case 'converted_to_draft': {
      return 'pr.draft';
    }
    case 'ready_for_review': {
      return 'pr.opened';
    }
  }
};

const IssueAccents: Record<'opened' | 'reopened' | 'closed', NotificationAccent> = {
  opened: 'issue.opened',
  reopened: 'issue.reopened',
  closed: 'issue.closed',
};

const ZULIP_MAX_TOPIC_LENGTH = 60;

const ZULIP_RESOLVED_PREFIX = '✔ ';

const ZULIP_MAX_UNRESOLVED_TOPIC_LENGTH = ZULIP_MAX_TOPIC_LENGTH - [...ZULIP_RESOLVED_PREFIX].length;

const isResolvedTopic = (topic: string) => topic.startsWith(ZULIP_RESOLVED_PREFIX);

const unresolveTopic = (topic: string) => (isResolvedTopic(topic) ? topic.slice(ZULIP_RESOLVED_PREFIX.length) : topic);

/**
 * Never truncated: Zulip only treats a move as a resolve when the name sent is exactly `✔ ` plus the current
 * name, and the empty "general chat" topic cannot be resolved at all.
 */
const resolveTopic = (topic: string) =>
  isResolvedTopic(topic) || topic === '' ? topic : `${ZULIP_RESOLVED_PREFIX}${topic}`;

const toZulipTopicName = ({ number, title }: { number: number; title: string }) =>
  shortenCodePoints(`#${number}: ${title}`, ZULIP_MAX_UNRESOLVED_TOPIC_LENGTH).trim();

const toZulipPullRequestMessage = ({ html_url, body }: { html_url: string; body: string | null }) => {
  const text = body?.trim();
  return text ? `${html_url}\n\n${toZulipQuote(neutraliseZulipMentions(shortenCodePoints(text, 2000)))}` : html_url;
};

const ZULIP_TOPIC_NOTICE_ACTIONS = new Set(['closed', 'converted_to_draft', 'reopened']);

const touchesZulipTopic = (dto: PullRequestEvent) =>
  dto.action === 'edited'
    ? isPullRequestEdited(dto) && !!(dto.changes.title || dto.changes.body)
    : ZULIP_TOPIC_NOTICE_ACTIONS.has(dto.action);

/**
 * Zulip has no distinct code for a missing message, so the documented `msg` is the only way to tell it from
 * other `BAD_REQUEST`s; if it is ever reworded the read counts as an outage, which is the safe direction.
 */
const ZULIP_MESSAGE_GONE_MESSAGE = 'Invalid message(s)';

const isZulipMessageGone = (error: unknown): error is ZulipApiError =>
  error instanceof ZulipApiError &&
  error.status === 400 &&
  error.code === 'BAD_REQUEST' &&
  error.msg === ZULIP_MESSAGE_GONE_MESSAGE;

/**
 * Inverted on purpose: the spec lists none of the move refusals the server raises, so a `400 BAD_REQUEST`
 * is a refusal unless its `msg` is one of these documented non-refusals.
 */
const ZULIP_UPDATE_OUTAGE_MESSAGES = new Set(['Nothing to change', "Topic can't be empty", ZULIP_MESSAGE_GONE_MESSAGE]);

const isZulipRefusal = (error: unknown): error is ZulipApiError =>
  error instanceof ZulipApiError &&
  (error.code === 'MOVE_MESSAGES_TIME_LIMIT_EXCEEDED' ||
    (error.status === 400 && error.code === 'BAD_REQUEST' && !ZULIP_UPDATE_OUTAGE_MESSAGES.has(error.msg)));

const isZulipFailure = (error: unknown) =>
  error instanceof ZulipApiError ||
  (error instanceof TypeError && error.message === 'fetch failed') ||
  (error instanceof DOMException && error.name === 'TimeoutError');

const DiscussionAccents: Record<'created' | 'reopened' | 'deleted' | 'answered', NotificationAccent> = {
  created: 'discussion.created',
  reopened: 'discussion.reopened',
  deleted: 'discussion.deleted',
  answered: 'discussion.answered',
};

@Injectable()
export class WebhookService {
  private logger = new Logger(WebhookService.name);

  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
    @Inject(IFourthwallRepository) private fourthwall: FourthwallRepository,
    @Inject(IGithubInterface) private github: IGithubInterface,
    @Inject(IOutlineInterface) private outline: IOutlineInterface,
    @Inject(IMattermostInterface) private mattermost: IMattermostInterface,
    @Inject(IZulipInterface) private zulip: IZulipInterface,
    private notifications: NotificationService,
  ) {}

  async onGithub(event: EmitterWebhookEvent, slug: string) {
    const { slugs } = getConfig();
    if (!slugs.githubWebhook || slug !== slugs.githubWebhook) {
      throw new UnauthorizedException();
    }

    switch (event.name) {
      case 'pull_request':
      case 'pull_request_review':
      case 'pull_request_review_comment':
      case 'pull_request_review_thread': {
        const { payload } = event;
        await this.upsertPullRequest(payload);
        await this.handlePullRequestNotification(payload);

        if (!payload.repository.private) {
          await this.handlePullRequestTeamPlatforms(payload);
        }
        break;
      }

      case 'workflow_run': {
        const { payload } = event;
        if (payload.action !== 'completed') {
          break;
        }

        const conclusion = payload.workflow_run.conclusion;
        if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required') {
          await this.handleWorkflowRunFailure(payload);
        }
        break;
      }

      case 'issues':
      case 'issue_comment': {
        const { payload } = event;
        if (!payload.repository.private) {
          await this.handleIssueNotification(payload);
        }
        break;
      }

      case 'discussion':
      case 'discussion_comment': {
        const { payload } = event;
        if (!payload.repository.private) {
          await this.handleDiscussionNotification(payload);
        }
        break;
      }

      case 'release': {
        const { payload } = event;
        await Promise.all([this.handleReleaseNotification(payload), this.handleCreateReleaseNotes(payload)]);
        break;
      }
    }
  }

  async onGithubStatus(dto: GithubStatusIncident | GithubStatusComponent, slug: string) {
    const { slugs } = getConfig();
    if (!slugs.githubStatusWebhook || slug !== slugs.githubStatusWebhook) {
      throw new UnauthorizedException();
    }

    this.logger.debug(dto);

    if (isIncidentUpdate(dto)) {
      const notification: Notification = {
        kind: 'incident',
        accent: getIncidentAccent(dto.incident),
        author: { name: 'GitHub Status', url: 'https://githubstatus.com' },
        title: dto.page.status_description,
        url: dto.incident.shortlink,
        fields: [{ name: dto.incident.name, value: dto.incident.incident_updates[0].body.replaceAll('<br />', '\n') }],
      };

      await this.notifications.notify('community.github-status', notification);
      await this.notifications.notify('team.github-status', notification);
    }
  }

  onStripePayment(dto: StripeBase, slug: string) {
    const { slugs } = getConfig();
    if (!slugs.stripeWebhook || slug !== slugs.stripeWebhook) {
      throw new UnauthorizedException();
    }

    if (isPaymentEvent(dto) && isImmichProduct(dto.data.object.description)) {
      void this.handlePayment(dto);
    }
  }

  async onPolarPayment(
    request: RawBodyRequest<Request>,
    response: Response,
    slug: string,
    orgSlug: 'immich-client' | 'immich-server',
  ) {
    const { slugs, polar } = getConfig();
    if (!slugs.polarWebhook || slug !== slugs.polarWebhook) {
      throw new UnauthorizedException();
    }

    try {
      const secret = orgSlug === 'immich-client' ? polar.immichClientSecret : polar.immichServerSecret;
      const event = validateEvent(JSON.stringify(request.body), request.headers as Record<string, string>, secret);
      if (event.type !== 'order.paid') {
        return;
      }

      await this.handlePayment(event, orgSlug);
      response.status(202).send('');
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        response.status(403).send('');
        return;
      }
      throw error;
    }
  }

  async onFourthwallOrder(dto: FourthwallOrderCreateWebhook | FourthwallOrderUpdateWebhook, slug: string) {
    const { slugs } = getConfig();
    if (!slugs.fourthwallWebhook || slug !== slugs.fourthwallWebhook) {
      throw new UnauthorizedException();
    }

    void this.handleFourthwallOrder(dto);
  }

  async onMattermostCommand(dto: CommandWebhookRequest<never>, slug: string) {
    return this.mattermost.runCommand(slug, dto);
  }

  async onMattermostDialog(dto: DialogResponse, slug: string) {
    return this.mattermost.submitDialog(dto, slug);
  }

  private async handleFourthwallOrder(dto: FourthwallOrderCreateWebhook | FourthwallOrderUpdateWebhook) {
    const { fourthwall } = getConfig();

    const dtoOrder = dto.type === 'ORDER_PLACED' ? dto.data : dto.data.order;

    await new Promise((resolve) => setTimeout(resolve, 10_000));

    let order = await this.fourthwall.getOrder({
      id: dtoOrder.id,
      user: fourthwall.user,
      password: fourthwall.password,
    });

    if (dto.testMode) {
      order = {
        profit: {
          value: dtoOrder.amounts.subtotal.value - Math.random() * dtoOrder.amounts.subtotal.value,
          currency: 'USD',
        },
      } as any;
    }

    switch (dto.type) {
      case 'ORDER_PLACED': {
        await this.database.createFourthwallOrder({
          id: dtoOrder.id,
          discount: dtoOrder.amounts.discount.value,
          tax: dtoOrder.amounts.tax.value,
          shipping: dtoOrder.amounts.shipping.value,
          subtotal: dtoOrder.amounts.subtotal.value,
          total: dtoOrder.amounts.total.value,
          revenue: dtoOrder.amounts.subtotal.value,
          profit: order.profit.value,
          username: dtoOrder.username,
          message: dtoOrder.message,
          status: dtoOrder.status,
          createdAt: new Date(dtoOrder.createdAt),
          testMode: dto.testMode,
        });
        break;
      }
      case 'ORDER_UPDATED': {
        await this.database.updateFourthwallOrder({
          id: dtoOrder.id,
          discount: dtoOrder.amounts.discount.value,
          tax: dtoOrder.amounts.tax.value,
          shipping: dtoOrder.amounts.shipping.value,
          subtotal: dtoOrder.amounts.subtotal.value,
          total: dtoOrder.amounts.total.value,
          revenue: dtoOrder.amounts.subtotal.value,
          profit: order.profit.value,
          username: dtoOrder.username,
          message: dtoOrder.message,
          status: dtoOrder.status,
          createdAt: new Date(dtoOrder.createdAt),
        });
        if (dtoOrder.status !== 'CANCELLED') {
          return;
        }
        break;
      }
    }

    const { revenue, profit } = await this.database.getTotalFourthwallOrders();

    // await this.discord.sendMessage({
    //   channelId: DiscordChannel.Purchases,
    //   message: {
    //     embeds: [
    //       new EmbedBuilder()
    //         .setTitle(
    //           `${dto.testMode ? 'TEST ORDER - ' : ''}Immich merch ${dto.type === 'ORDER_PLACED' ? 'purchased' : 'order updated'}`,
    //         )
    //         .setURL(`https://immich-shop.fourthwall.com/admin/dashboard/contributions/orders/${dtoOrder.id}`)
    //         .setAuthor({ name: 'Fourthwall', url: 'https://fourthwall.com' })
    //         .setDescription(
    //           `Price: ${dtoOrder.amounts.subtotal.value.toLocaleString()} USD; Profit: ${order.profit.value.toLocaleString()} USD`,
    //         )
    //         .setColor(dto.testMode ? Colors.Yellow : dtoOrder.status === 'CANCELLED' ? Colors.Red : Colors.DarkGreen)
    //         .setFields(makeOrderFields({ revenue, profit, message: dtoOrder.message })),
    //     ],
    //     flags: [MessageFlags.SuppressNotifications],
    //   },
    // });

    await this.notifications.notify('team.purchases', {
      kind: 'purchase',
      accent: dto.testMode ? 'order.test' : dtoOrder.status === 'CANCELLED' ? 'order.cancelled' : 'order.placed',
      author: { name: 'Fourthwall', url: 'https://fourthwall.com' },
      title: `${dto.testMode ? 'TEST ORDER - ' : ''}Immich merch ${dto.type === 'ORDER_PLACED' ? 'purchased' : 'order updated'}`,
      url: `https://immich-shop.fourthwall.com/admin/dashboard/contributions/orders/${dtoOrder.id}`,
      body: `Price: ${dtoOrder.amounts.subtotal.value.toLocaleString()} USD; Profit: ${order.profit.value.toLocaleString()} USD`,
      fields: makeOrderFields({ revenue, profit, message: dtoOrder.message }),
    });
  }

  private async handlePayment(
    event: StripeBase<PaymentIntent> | WebhookOrderPaidPayload,
    orgSlug?: 'immich-client' | 'immich-server',
  ) {
    let data: {
      id: string;
      description: string;
      amount: number;
      created: number;
      currency: string;
      status: string;
      livemode: boolean;
      source: 'stripe' | 'polar';
    };

    if ('object' in event.data) {
      data = { ...event.data.object, source: 'stripe' };
    } else {
      data = {
        id: event.data.id,
        description: orgSlug ?? event.data.description,
        amount: event.data.totalAmount,
        created: DateTime.fromJSDate(event.data.createdAt).toUnixInteger(),
        currency: event.data.currency,
        status: event.data.status,
        source: 'polar',
        livemode: true,
      };
    }

    const { id, description, amount, created, currency, status, livemode, source } = data;

    await withErrorLogging({
      method: () =>
        this.database.createPayment({
          event_id: id,
          id,
          amount,
          currency,
          status,
          description,
          created,
          livemode,
          data: JSON.stringify(event),
        }),
      message: 'Failed to insert payment into database',
      fallbackValue: undefined,
      discord: this.discord,
      logger: this.logger,
    });

    if (status !== 'succeeded' && status !== 'paid') {
      return;
    }

    const { server, client } = await withErrorLogging({
      method: () => this.database.getTotalLicenseCount(),
      message: 'Failed to insert payment into database',
      fallbackValue: { server: 0, client: 0 },
      discord: this.discord,
      logger: this.logger,
    });

    const licenseType = description.split('-')[1];
    const url =
      source === 'stripe'
        ? `https://dashboard.stripe.com/${livemode ? '' : 'test/'}payments/${id}`
        : `https://polar.sh/dashboard/${orgSlug}/sales/${id}`;

    // await this.discord.sendMessage({
    //   channelId: DiscordChannel.Purchases,
    //   message: {
    //     embeds: [
    //       new EmbedBuilder()
    //         .setTitle(`${livemode ? '' : 'TEST PAYMENT - '}Immich ${licenseType} license purchased`)
    //         .setURL(url)
    //         .setAuthor({
    //           name: source === 'stripe' ? 'Stripe Payments' : 'Polar payments',
    //           url: source === 'stripe' ? 'https://stripe.com' : 'https://polar.sh',
    //         })
    //         .setDescription(`Price: ${(amount / 100).toLocaleString()} ${currency.toUpperCase()}`)
    //         .setColor(livemode ? Colors.Green : Colors.Yellow)
    //         .setFields(makeLicenseFields({ server, client })),
    //     ],
    //     flags: [MessageFlags.SuppressNotifications],
    //   },
    // });
    await this.notifications.notify('team.purchases', {
      kind: 'purchase',
      accent: livemode ? 'purchase.live' : 'purchase.test',
      author:
        source === 'stripe'
          ? { name: 'Stripe payments', url: 'https://stripe.com' }
          : { name: 'Polar Payments', url: 'https://polar.sh' },
      title: `${livemode ? '' : 'TEST PAYMENT - '}Immich ${licenseType} product key purchased`,
      url,
      body: `Price: ${(amount / 100).toLocaleString()} ${currency.toUpperCase()}`,
      fields: makeLicenseFields({ server, client }),
    });
  }

  private async handleWorkflowRunFailure(event: EmitterWebhookEvent<'workflow_run.completed'>['payload']) {
    try {
      const { workflow_run, repository } = event;

      const checkSuiteTrigger = await this.github.getCheckSuiteTriggerCommit(
        repository.owner.login,
        repository.name,
        workflow_run.check_suite_node_id,
      );

      const latestRelease = await this.github.getLatestReleaseTag(repository.owner.login, repository.name);

      if (checkSuiteTrigger === latestRelease) {
        await this.notifications.notify('team.release-alerts', {
          kind: 'alert',
          accent: 'release.failed',
          title: 'Release Workflow Failed',
          body: `[${workflow_run.display_title}](${workflow_run.html_url})`,
        });
      }
    } catch (error) {
      this.logger.error('Failed to handle workflow run failure', error);
    }
  }

  private async handlePullRequestNotification({ action, sender, repository, pull_request }: PullRequestEvent) {
    if (
      action === 'opened' ||
      action === 'closed' ||
      action === 'converted_to_draft' ||
      action === 'ready_for_review'
    ) {
      const notification = getEventNotification({
        action: getActionName(action, pull_request),
        repositoryName: repository.full_name,
        title: 'Pull request',
        user: sender,
        event: pull_request,
        accent: getPullRequestAccent(
          { action, isDraft: pull_request.draft ?? false, isMerged: pull_request.merged },
          this.logger,
        ),
      });

      if (repository.owner.login === GithubOrg.ImmichApp) {
        if (!repository.private) {
          await this.notifications.notify('community.pull-requests', notification);
        }
        await this.notifications.notify('team.pull-requests', notification);
      } else if (repository.owner.login === GithubOrg.FUTO && repository.name === GithubRepo.FHSCore) {
        await this.notifications.notify('team.fhs-pull-requests', notification);
      }
    }
  }

  private async handleIssueNotification({
    action,
    repository,
    sender,
    issue,
  }: EmitterWebhookEvent<'issues' | 'issue_comment'>['payload']) {
    if (action === 'opened' || action === 'reopened' || action === 'closed') {
      const notification = getEventNotification({
        action,
        repositoryName: repository.full_name,
        title: 'Issue',
        user: sender,
        event: issue,
        accent: IssueAccents[action],
      });

      await this.notifications.notify('community.issues', notification);
      await this.notifications.notify('team.issues', notification);
    }
  }

  private async handleDiscussionNotification({
    action,
    repository,
    sender,
    discussion,
  }: EmitterWebhookEvent<'discussion' | 'discussion_comment'>['payload']) {
    if (action === 'created' || action === 'reopened' || action === 'deleted' || action === 'answered') {
      const notification = getEventNotification({
        action,
        repositoryName: repository.full_name,
        title: 'Discussion',
        user: sender,
        event: discussion,
        accent: DiscussionAccents[action],
      });

      await this.notifications.notify('community.discussions', notification);
      await this.notifications.notify('team.discussions', notification);
    }
  }

  private async handleReleaseNotification({
    action,
    repository,
    release,
    sender,
  }: EmitterWebhookEvent<'release'>['payload']) {
    if (action !== 'published' || !sender) {
      return;
    }

    const description = isMainRepo(repository.full_name) ? _.sample(ReleaseMessages) : undefined;
    const notification: Notification = {
      kind: 'release',
      author: toAuthor(sender),
      title: `[${repository.full_name}] New release: ${release.name ?? release.tag_name}`,
      url: release.html_url,
      body: description,
    };

    if (repository.owner.login === GithubOrg.FUTO && repository.name === GithubRepo.FHSCore) {
      await this.notifications.notify('team.fhs-releases', notification);
      return;
    }

    const messages: Promise<unknown>[] = [
      ...(repository.private ? [] : [this.notifications.notify('community.releases', notification)]),
      this.notifications.notify('team.releases', notification),
    ];

    if (isMainRepo(repository.full_name)) {
      if (semver.patch(release.tag_name) === 0 && semver.prerelease(release.tag_name) === null) {
        messages.push(this.notifications.notify('community.announcements', notification));
      }

      // A bespoke plain-text public announcement, not a `Notification`; routing it through the model would change it.
      messages.push(
        this.zulip.sendMessage({
          stream: Constants.Zulip.Streams.Immich,
          topic: Constants.Zulip.Topics.ImmichRelease,
          content: `${description!} ${release.html_url}`,
        }),
      );
    }

    await Promise.all(messages);
  }

  private async handleCreateReleaseNotes({ action, repository, release }: EmitterWebhookEvent<'release'>['payload']) {
    if (action !== 'created') {
      return;
    }

    if (repository.full_name !== `${GithubOrg.ImmichApp}/${GithubRepo.Immich}`) {
      return;
    }

    const version = semver.parse(release.tag_name);

    if (!version) {
      return;
    }

    // we only want this for minor bumps
    if (version.minor === 0 || version.patch !== 0) {
      return;
    }

    const releaseVersion = `v${version.format().split('-', 1)[0]}`;

    const existingDocuments = await this.outline.searchDocuments({ title: releaseVersion });
    // TODO remove filter once new version of outline gets released (>1.9.2) with search filters support
    if (existingDocuments.filter((document) => document.title === releaseVersion).length > 0) {
      return;
    }

    const response = await this.outline.createDocument({
      collectionId: Constants.Outline.Collections.SupportCrew,
      parentDocumentId: Constants.Outline.Documents.SupportCrewReleaseNotes,
      title: releaseVersion,
      icon: 'rocket',
      iconColor: '#00D084',
      text: `
---

description: Release notes for ${releaseVersion} – TODO

publishedAt: ${DateTime.now().toFormat('yyyy-LL-dd')}

slug: ${releaseVersion}-release

type: release

authors: [Immich Team]

---

Welcome to Immich \`${releaseVersion}\`!

This release ...

${release.body}
`,
    });

    const share = await this.outline.shareDocument(response.id);

    await this.discord.createThread(Constants.Discord.Channels.SupportCrewDraftAnnouncements, {
      name: releaseVersion,
      message: `
${roleMention(Constants.Discord.Roles.SupportCrew)} ${roleMention(Constants.Discord.Roles.Contributor)} ${roleMention(Constants.Discord.Roles.Immich)} Release time!

${Constants.Urls.Outline + response.url}



Read only for Nicholas: ${share.url}
`,
    });
  }

  private async handlePullRequestTeamPlatforms(payload: PullRequestEvent) {
    const [discord] = await Promise.allSettled([this.handlePullRequestTeamUpdate(payload)]);
    await this.handlePullRequestZulipTopic(payload);
    if (discord.status === 'rejected') {
      throw discord.reason;
    }
  }

  async handlePullRequestTeamUpdate(dto: PullRequestEvent) {
    const { pull_request } = dto;

    if (dto.repository.full_name !== 'immich-app/immich') {
      return;
    }

    const pullRequest = await this.database.getPullRequestById(pull_request.node_id);

    if (!pullRequest) {
      return;
    }

    const name = shorten(`#${pull_request.number}: ${pull_request.title}`, 100);
    const message = shorten(pull_request.body ?? '', 2000) || 'No content';

    if (!pullRequest.discordThreadId) {
      if (dto.action === 'opened' && dto.sender.type !== 'Bot') {
        const { threadId } = await this.discord.createThread(Constants.Discord.Channels.TeamPullRequests, {
          name,
          message,
        });

        if (!threadId) {
          return;
        }

        await this.discord.sendMessage({
          channelId: Constants.Discord.Channels.TeamPullRequests,
          threadId,
          message: { content: pull_request.html_url, flags: [MessageFlags.SuppressEmbeds] },
          pin: true,
        });
        await this.database.updatePullRequest({
          nodeId: pull_request.node_id,
          discordThreadId: threadId,
        });
      }
      return;
    }

    switch (dto.action) {
      case 'closed': {
        await this.discord.sendMessage({
          channelId: Constants.Discord.Channels.TeamPullRequests,
          threadId: pullRequest.discordThreadId,
          message: {
            content: `Pull request has been ${pull_request.merged_at ? 'merged' : 'closed'} by [@${dto.sender.login}](${dto.sender.html_url})`,
            flags: [MessageFlags.SuppressEmbeds],
          },
        });

        await this.discord.setThreadArchived(
          {
            channelId: Constants.Discord.Channels.TeamPullRequests,
            threadId: pullRequest.discordThreadId,
          },
          true,
        );
        await this.database.updatePullRequest({ nodeId: pullRequest.nodeId, closedAt: new Date() });
        return;
      }

      case 'converted_to_draft': {
        await this.discord.sendMessage({
          channelId: Constants.Discord.Channels.TeamPullRequests,
          threadId: pullRequest.discordThreadId,
          message: 'Pull request has been converted to draft',
        });

        break;
      }

      case 'reopened': {
        await this.discord.sendMessage({
          channelId: Constants.Discord.Channels.TeamPullRequests,
          threadId: pullRequest.discordThreadId,
          message: {
            content: `Pull request has been reopened by [@${dto.sender.login}](${dto.sender.html_url})`,
            flags: [MessageFlags.SuppressEmbeds],
          },
        });

        await this.discord.setThreadArchived(
          {
            channelId: Constants.Discord.Channels.TeamPullRequests,
            threadId: pullRequest.discordThreadId,
          },
          false,
        );
        await this.database.updatePullRequest({ nodeId: pullRequest.nodeId, closedAt: null });
        break;
      }
    }

    await this.discord.updateThread(
      { channelId: Constants.Discord.Channels.TeamPullRequests, threadId: pullRequest.discordThreadId },
      { name, message },
    );
  }

  async handlePullRequestZulipTopic(dto: PullRequestEvent) {
    if (dto.repository.full_name !== 'immich-app/immich' || !this.zulip.isInitialised()) {
      return;
    }

    try {
      await this.updatePullRequestZulipTopic(dto);
    } catch (error) {
      const { number } = dto.pull_request;
      if (isZulipFailure(error)) {
        this.logger.error(`Zulip failed while updating the topic of pull request #${number}`, error);
      } else {
        this.logger.error(`Unexpected error while updating the Zulip topic of pull request #${number}`, error);
      }
    }
  }

  private async updatePullRequestZulipTopic(dto: PullRequestEvent) {
    const { pull_request } = dto;
    const stream = Constants.Zulip.Streams.ImmichPullRequests;

    const pullRequest = await this.database.getPullRequestById(pull_request.node_id);
    if (!pullRequest) {
      return;
    }

    if (!pullRequest.zulipMessageId) {
      if (dto.action === 'opened' && dto.sender.type !== 'Bot') {
        const { id } = await this.zulip.sendMessage({
          stream,
          topic: toZulipTopicName(pull_request),
          content: toZulipPullRequestMessage(pull_request),
        });
        await this.database.updatePullRequest({ nodeId: pull_request.node_id, zulipMessageId: id });
      }
      return;
    }

    if (!touchesZulipTopic(dto)) {
      return;
    }

    // A human may have renamed or resolved the topic, and a post to a stale name would open a new, empty topic.
    const { id: messageId, topic } = await this.readOrRebuildZulipTopic(dto, pullRequest.zulipMessageId);
    const post = (content: string) => this.zulip.sendMessage({ stream, topic, content });
    const rename = (to: string, fallback: (error: ZulipApiError) => string) =>
      this.renameZulipTopic({ messageId, from: topic, to, fallback }, post);

    switch (dto.action) {
      case 'closed': {
        await post(
          `Pull request has been ${pull_request.merged_at ? 'merged' : 'closed'} by [@${dto.sender.login}](${dto.sender.html_url})`,
        );
        await rename(resolveTopic(topic), ({ msg }) => `The topic could not be resolved automatically: ${msg}`);
        return;
      }

      case 'converted_to_draft': {
        await post('Pull request has been converted to draft');
        return;
      }

      case 'reopened': {
        await post(`Pull request has been reopened by [@${dto.sender.login}](${dto.sender.html_url})`);
        await rename(unresolveTopic(topic), ({ msg }) => `The topic could not be unresolved automatically: ${msg}`);
        return;
      }

      case 'edited': {
        if (!isPullRequestEdited(dto)) {
          return;
        }
        if (dto.changes.title) {
          const name = toZulipTopicName(pull_request);
          // Unlike a topic name, message content can mention, so the title is neutralised here.
          await rename(
            isResolvedTopic(topic) ? resolveTopic(name) : name,
            () => `Pull request has been renamed to: ${neutraliseZulipMentions(name)}`,
          );
        }
        if (dto.changes.body) {
          await this.editZulipMessage(messageId, toZulipPullRequestMessage(pull_request));
        }
        return;
      }
    }
  }

  private async readOrRebuildZulipTopic(dto: PullRequestEvent, messageId: number) {
    try {
      return await this.zulip.getMessage(messageId);
    } catch (error) {
      if (!isZulipMessageGone(error)) {
        throw error;
      }
      const { pull_request } = dto;
      this.logger.warn(
        `Zulip message ${messageId} of pull request #${pull_request.number} is gone (${error.msg}), recreating the topic`,
      );
      const topic = toZulipTopicName(pull_request);
      const { id } = await this.zulip.sendMessage({
        stream: Constants.Zulip.Streams.ImmichPullRequests,
        topic,
        content: toZulipPullRequestMessage(pull_request),
      });
      await this.database.updatePullRequest({ nodeId: pull_request.node_id, zulipMessageId: id });
      return { id, topic };
    }
  }

  private async renameZulipTopic(
    {
      messageId,
      from,
      to,
      fallback,
    }: { messageId: number; from: string; to: string; fallback: (error: ZulipApiError) => string },
    post: (content: string) => Promise<unknown>,
  ) {
    if (from === to) {
      return;
    }

    try {
      await this.zulip.updateMessage(messageId, { topic: to, propagateMode: 'change_all' });
    } catch (error) {
      if (!isZulipRefusal(error)) {
        this.logger.error(`Could not rename Zulip topic "${from}" to "${to}"`, error);
        return;
      }
      this.logger.warn(`Zulip refused to rename topic "${from}" to "${to}": ${error.message}`);
      try {
        await post(fallback(error));
      } catch (postError) {
        this.logger.error(
          `Could not post the fallback message in Zulip topic "${from}" after the refused rename`,
          postError,
        );
      }
    }
  }

  private async editZulipMessage(messageId: number, content: string) {
    try {
      await this.zulip.updateMessage(messageId, { content });
    } catch (error) {
      if (!isZulipRefusal(error)) {
        this.logger.error(`Could not edit Zulip message ${messageId}`, error);
        return;
      }
      this.logger.warn(`Zulip refused to edit message ${messageId}: ${error.message}`);
    }
  }

  async upsertPullRequest({ pull_request, repository }: PullRequestEvent) {
    await this.database.upsertPullRequest({
      nodeId: pull_request.node_id,
      number: pull_request.number,
      organization: repository.owner.login,
      repository: repository.name,
      updatedAt: pull_request.updated_at,
    });
  }
}
