import { Inject, Injectable, Logger, RawBodyRequest, UnauthorizedException } from '@nestjs/common';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import { WebhookOrderPaidPayload } from '@polar-sh/sdk/models/components/webhookorderpaidpayload.js';
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks.js';
import { Colors, EmbedBuilder, MessageFlags, roleMention } from 'discord.js';
import { Request, Response } from 'express';
import _ from 'lodash';
import { DateTime } from 'luxon';
import semver from 'semver';
import { getConfig } from 'src/config';
import { Constants, GithubOrg, GithubRepo, ReleaseMessages } from 'src/constants';
import { GithubStatusComponent, GithubStatusIncident, PaymentIntent, StripeBase } from 'src/dtos/webhook.dto';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';
import {
  FourthwallOrderCreateWebhook,
  FourthwallOrderUpdateWebhook,
  IFourthwallRepository,
} from 'src/interfaces/fourthwall.interface';
import { IGithubInterface } from 'src/interfaces/github.interface';
import { CommandWebhookRequest, IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { IOutlineInterface } from 'src/interfaces/outline.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';
import { FourthwallRepository } from 'src/repositories/fourthwall.repository';
import { makeLicenseFields, makeOrderFields, shorten, withErrorLogging } from 'src/util';

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

type BaseEvent = {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
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

        if (!payload.repository.private) {
          await Promise.all([this.handlePullRequestTeamUpdate(payload), this.handlePullRequestNotification(payload)]);
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
        if (!payload.repository.private) {
          await Promise.all([this.handleReleaseNotification(payload), this.handleCreateReleaseNotes(payload)]);
        }
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
      const embed = new EmbedBuilder({
        title: dto.page.status_description,
        author: { name: 'GitHub Status', url: 'https://githubstatus.com' },
        url: dto.incident.shortlink,
        fields: [{ name: dto.incident.name, value: dto.incident.incident_updates[0].body.replaceAll('<br />', '\n') }],
      });

      if (dto.incident.status === 'resolved') {
        embed.setColor('Green');
      } else {
        switch (dto.incident.impact) {
          case 'minor':
            embed.setColor('Orange');
            break;
          case 'major':
            embed.setColor('Red');
            break;
          default:
            embed.setColor('Grey');
        }
      }

      await this.discord.sendMessage({ channelId: DiscordChannel.GithubStatus, message: { embeds: [embed] } });
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

    await this.discord.sendMessage({
      channelId: DiscordChannel.Purchases,
      message: {
        embeds: [
          new EmbedBuilder()
            .setTitle(
              `${dto.testMode ? 'TEST ORDER - ' : ''}Immich merch ${dto.type === 'ORDER_PLACED' ? 'purchased' : 'order updated'}`,
            )
            .setURL(`https://immich-shop.fourthwall.com/admin/dashboard/contributions/orders/${dtoOrder.id}`)
            .setAuthor({ name: 'Fourthwall', url: 'https://fourthwall.com' })
            .setDescription(
              `Price: ${dtoOrder.amounts.subtotal.value.toLocaleString()} USD; Profit: ${order.profit.value.toLocaleString()} USD`,
            )
            .setColor(dto.testMode ? Colors.Yellow : dtoOrder.status === 'CANCELLED' ? Colors.Red : Colors.DarkGreen)
            .setFields(makeOrderFields({ revenue, profit, message: dtoOrder.message })),
        ],
        flags: [MessageFlags.SuppressNotifications],
      },
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
    await this.discord.sendMessage({
      channelId: DiscordChannel.Purchases,
      message: {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${livemode ? '' : 'TEST PAYMENT - '}Immich ${licenseType} license purchased`)
            .setURL(
              source === 'stripe'
                ? `https://dashboard.stripe.com/${livemode ? '' : 'test/'}payments/${id}`
                : `https://polar.sh/dashboard/${orgSlug}/sales/${id}`,
            )
            .setAuthor({
              name: source === 'stripe' ? 'Stripe Payments' : 'Polar payments',
              url: source === 'stripe' ? 'https://stripe.com' : 'https://polar.sh',
            })
            .setDescription(`Price: ${(amount / 100).toLocaleString()} ${currency.toUpperCase()}`)
            .setColor(livemode ? Colors.Green : Colors.Yellow)
            .setFields(makeLicenseFields({ server, client })),
        ],
        flags: [MessageFlags.SuppressNotifications],
      },
    });
    await this.mattermost.send({
      channelId: Constants.Mattermost.Channels.Purchases,
      message: `Immich ${licenseType} product key purchased! \nPrice: ${(amount / 100).toLocaleString()} ${currency.toUpperCase()}`,
      // TODO beautify
      // props: {
      //   mm_blocks: [
      //     {
      //       type: 'text',
      //       text: `[${source === 'stripe' ? 'Stripe Payments' : 'Polar payments'}](${source === 'stripe' ? 'https://stripe.com' : 'https://polar.sh'})`,
      //     },
      //   ],
      // },
    });
  }

  private getReleaseEmbed({
    repositoryName,
    name,
    user,
    url,
    description,
  }: {
    repositoryName: string;
    name: string;
    user: NonNullable<EmitterWebhookEvent<'release'>['payload']['sender']>;
    url: string;
    description?: string;
  }) {
    return new EmbedBuilder({
      title: `[${repositoryName}] New release: ${name}`,
      author: { name: user.login, url: user.html_url, iconURL: user.avatar_url },
      url,
      description,
    });
  }

  private getEmbed({
    action,
    repositoryName,
    title,
    user,
    event,
  }: {
    action: string;
    repositoryName: string;
    title: string;
    user: NonNullable<EmitterWebhookEvent<'pull_request'>['payload']['sender']>;
    event: BaseEvent;
  }) {
    return new EmbedBuilder({
      title: `[${repositoryName}] ${title} ${action}: #${event.number} ${event.title}`,
      author: {
        name: user.login,
        url: user.html_url,
        iconURL: user.avatar_url,
      },
      url: event.html_url,
      description:
        action === 'opened' || action === 'created' ? (event.body ? shorten(event.body, 500) : undefined) : undefined,
    });
  }

  private getPrEmbedColor(dto: {
    action: 'opened' | 'closed' | 'converted_to_draft' | 'ready_for_review';
    isDraft: boolean;
    isMerged: boolean | null;
  }) {
    switch (dto.action) {
      case 'opened': {
        return dto.isDraft ? 'Grey' : 'Green';
      }
      case 'closed': {
        if (dto.isMerged === null) {
          this.logger.error('Closed PR should have isMerged set.');
          return null;
        }
        return dto.isMerged ? 'Purple' : 'Red';
      }
      case 'converted_to_draft': {
        return 'Grey';
      }
      case 'ready_for_review': {
        return 'Green';
      }
    }
  }

  private getIssueEmbedColor(dto: { action: 'opened' | 'reopened' | 'closed' }) {
    switch (dto.action) {
      case 'opened': {
        return 'Green';
      }
      case 'reopened': {
        return 'DarkGreen';
      }
      case 'closed': {
        return 'NotQuiteBlack';
      }
    }
  }

  private getDiscussionEmbedColor(dto: { action: 'created' | 'reopened' | 'deleted' | 'answered' }) {
    switch (dto.action) {
      case 'created': {
        return 'Orange';
      }
      case 'reopened': {
        return 'DarkOrange';
      }
      case 'deleted': {
        return 'NotQuiteBlack';
      }
      case 'answered': {
        return 'Green';
      }
    }
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
        const embed = new EmbedBuilder({
          title: 'Release Workflow Failed <a:peepoAlert:1367804942638776423>',
          description: `[${workflow_run.display_title}](${workflow_run.html_url})`,
          color: Colors.Red,
        });

        await this.discord.sendMessage({
          channelId: Constants.Discord.Channels.TeamAlerts,
          message: { embeds: [embed] },
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
      const embed = this.getEmbed({
        action: getActionName(action, pull_request),
        repositoryName: repository.full_name,
        title: 'Pull request',
        user: sender,
        event: pull_request,
      });
      const color = this.getPrEmbedColor({
        action,
        isDraft: pull_request.draft ?? false,
        isMerged: pull_request.merged,
      });
      embed.setColor(color);

      await this.discord.sendMessage({ channelId: DiscordChannel.PullRequests, message: { embeds: [embed] } });
    }
  }

  private async handleIssueNotification({
    action,
    repository,
    sender,
    issue,
  }: EmitterWebhookEvent<'issues' | 'issue_comment'>['payload']) {
    if (action === 'opened' || action === 'reopened' || action === 'closed') {
      const embed = this.getEmbed({
        action,
        repositoryName: repository.full_name,
        title: 'Issue',
        user: sender,
        event: issue,
      });
      embed.setColor(this.getIssueEmbedColor({ action }));

      await this.discord.sendMessage({ channelId: DiscordChannel.IssuesAndDiscussions, message: { embeds: [embed] } });
    }
  }

  private async handleDiscussionNotification({
    action,
    repository,
    sender,
    discussion,
  }: EmitterWebhookEvent<'discussion' | 'discussion_comment'>['payload']) {
    if (action === 'created' || action === 'reopened' || action === 'deleted' || action === 'answered') {
      const embed = this.getEmbed({
        action,
        repositoryName: repository.full_name,
        title: 'Discussion',
        user: sender,
        event: discussion,
      });
      embed.setColor(this.getDiscussionEmbedColor({ action }));

      await this.discord.sendMessage({ channelId: DiscordChannel.IssuesAndDiscussions, message: { embeds: [embed] } });
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

    const embedProps = {
      repositoryName: repository.full_name,
      name: release.name ?? release.tag_name,
      url: release.html_url,
      user: sender,
      description: isMainRepo(repository.full_name) ? _.sample(ReleaseMessages) : undefined,
    };
    const messages = [
      this.discord.sendMessage({
        channelId: DiscordChannel.Releases,
        message: {
          embeds: [this.getReleaseEmbed(embedProps)],
        },
        crosspost: true,
      }),
    ];

    if (isMainRepo(repository.full_name)) {
      if (semver.patch(release.tag_name) === 0 && semver.prerelease(release.tag_name) === null) {
        messages.push(
          this.discord.sendMessage({
            channelId: DiscordChannel.Announcements,
            message: {
              embeds: [this.getReleaseEmbed(embedProps)],
            },
            crosspost: true,
          }),
        );
      }

      messages.push(
        this.zulip.sendMessage({
          stream: Constants.Zulip.Streams.Immich,
          topic: Constants.Zulip.Topics.ImmichRelease,
          content: `${embedProps.description!} ${release.html_url}`,
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

    const [releaseVersion] = version.format().split('-', 1);

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
