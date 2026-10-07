import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import { DateTime } from 'luxon';
import { Constants } from 'src/constants';
import { scanZulipFences, ZULIP_MAX_MESSAGE_LENGTH } from 'src/format';
import { IDatabaseRepository, PullRequestExpansionWithCount } from 'src/interfaces/database.interface';
import { IZulipInterface, ZulipEmoji } from 'src/interfaces/zulip.interface';
import { SerialQueue } from 'src/mirror/queue';
import { isZulipMessageGone, isZulipRefusal, ZulipApiError } from 'src/repositories/zulip.client';
import { NewPullRequestExpansion, PullRequestReference } from 'src/schema';
import { isPullRequestLine } from 'src/util';

export type PullRequestReviewEvent = EmitterWebhookEvent<'pull_request_review'>['payload'];

type ExpansionReply = Pick<NewPullRequestExpansion, 'service' | 'messageId' | 'channelId'>;

const toPullRequestUrl = ({ organization, repository, number }: PullRequestReference) =>
  `https://github.com/${organization}/${repository}/pull/${number}`;

const toPullRequestName = ({ organization, repository, number }: PullRequestReference) =>
  `${organization}/${repository}#${number}`;

/** Every line of the pull request at `url` starts with `mark`; `undefined` when no line is left to mark. */
export const markPullRequestLines = (content: string, url: string, mark: string) => {
  const lines = content.split('\n');
  // A code snippet in the reply can hold a line shaped like a pull request's, and must stay as written.
  const { lineFences } = scanZulipFences(lines);
  const marked = lines.map((line, index) => lineFences[index] === null && isPullRequestLine(line, url));
  if (!marked.includes(true)) {
    return;
  }

  return lines.map((line, index) => (marked[index] ? `${mark} ${line}` : line)).join('\n');
};

@Injectable()
export class ApprovalService {
  private logger = new Logger(ApprovalService.name);
  // A mark reads a reply and writes it back, so two approvals of pull requests in one reply must not interleave.
  private queue = new SerialQueue('approvals', this.logger);

  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    @Inject(IZulipInterface) private zulip: IZulipInterface,
  ) {}

  async track(reply: ExpansionReply, pullRequests: PullRequestReference[]) {
    if (pullRequests.length === 0) {
      return;
    }

    await this.database.createPullRequestExpansions(
      pullRequests.map(({ organization, repository, number }) => ({
        ...reply,
        organization: organization.toLowerCase(),
        repository: repository.toLowerCase(),
        number,
      })),
    );
  }

  /** Only a person's approval marks the replies; a bot's never does. */
  handleReview(payload: PullRequestReviewEvent) {
    if (payload.action !== 'submitted') {
      return;
    }

    const { review, repository, pull_request } = payload;
    if (review.state.toLowerCase() !== 'approved' || review.user?.type !== 'User' || !review.submitted_at) {
      return;
    }

    const pullRequest = {
      organization: repository.owner.login.toLowerCase(),
      repository: repository.name.toLowerCase(),
      number: pull_request.number,
    };
    const submittedAt = new Date(review.submitted_at);
    this.queue.push(`approval of ${repository.full_name}#${pull_request.number}`, () =>
      this.markApproved(pullRequest, submittedAt),
    );
  }

  whenIdle() {
    return this.queue.whenIdle();
  }

  @Cron(Constants.Cron.PruneExpansions)
  async prune() {
    try {
      await this.database.removePullRequestExpansions(
        DateTime.now().minus({ days: Constants.Approvals.MaxAgeDays }).toJSDate(),
      );
    } catch (error) {
      this.logger.error('Could not prune the pull request expansions', error);
    }
  }

  private async markApproved(pullRequest: PullRequestReference, submittedAt: Date) {
    const expansions = await this.database.getPullRequestExpansions(pullRequest, submittedAt);
    await this.markOnZulip(
      expansions.filter(({ service }) => service === 'zulip'),
      pullRequest,
    );
  }

  private async markOnZulip(expansions: PullRequestExpansionWithCount[], pullRequest: PullRequestReference) {
    if (expansions.length === 0 || !this.zulip.isInitialised()) {
      return;
    }

    const emoji = await this.getZulipEmoji();
    if (!emoji) {
      return;
    }

    const approval = { name: toPullRequestName(pullRequest), url: toPullRequestUrl(pullRequest), emoji };
    for (const expansion of expansions) {
      try {
        await this.markZulipReply(expansion, approval);
      } catch (error) {
        if (isZulipMessageGone(error)) {
          this.logger.debug(`Zulip message ${expansion.messageId} is gone, so ${approval.name} is not marked there`);
          continue;
        }

        this.logger.error(`Could not mark ${approval.name} as approved in Zulip message ${expansion.messageId}`, error);
      }
    }
  }

  private async getZulipEmoji() {
    try {
      const emoji = (await this.zulip.listEmoji()).find(
        ({ name, deactivated }) => name === Constants.Approvals.Emoji && !deactivated,
      );
      if (!emoji) {
        this.logger.warn(`Zulip has no realm emoji ${Constants.Approvals.Emoji}, so approvals are not marked there`);
      }
      return emoji;
    } catch (error) {
      this.logger.error('Could not list the Zulip realm emoji, so the approval is not marked there', error);
    }
  }

  private async markZulipReply(
    expansion: PullRequestExpansionWithCount,
    { name, url, emoji }: { name: string; url: string; emoji: ZulipEmoji },
  ) {
    const messageId = Number(expansion.messageId);
    const [message] = await this.zulip.getMessagesByIds([messageId]);
    if (!message) {
      this.logger.debug(`Zulip message ${messageId} is gone, so ${name} is not marked there`);
      return;
    }

    const content = markPullRequestLines(message.content, url, `:${emoji.name}:`);
    if (content === undefined) {
      this.logger.debug(`Zulip message ${messageId} has no line of ${name} left to mark`);
      return;
    }

    // Zulip cuts an over-long message itself rather than refuse it, which would lose the end of the reply.
    if ([...content].length > ZULIP_MAX_MESSAGE_LENGTH) {
      await this.reactOnZulip(expansion, emoji, `Marking ${name} would make Zulip message ${messageId} too long`);
      return;
    }

    try {
      await this.zulip.updateMessage(messageId, { content });
    } catch (error) {
      if (!isZulipRefusal(error)) {
        throw error;
      }

      await this.reactOnZulip(expansion, emoji, `Zulip refused to mark ${name} in message ${messageId}: ${error.msg}`);
    }
  }

  /** A reaction cannot say which line it is about, so only a reply naming one pull request gets one. */
  private async reactOnZulip(
    { messageId, pullRequestCount }: PullRequestExpansionWithCount,
    emoji: ZulipEmoji,
    reason: string,
  ) {
    if (pullRequestCount !== 1) {
      this.logger.debug(`${reason}; it names ${pullRequestCount} pull requests, so it gets no reaction either`);
      return;
    }

    this.logger.debug(`${reason}; it gets the ${emoji.name} reaction instead`);
    try {
      await this.zulip.addReaction(Number(messageId), { name: emoji.name, code: emoji.id, type: 'realm_emoji' });
    } catch (error) {
      if (!(error instanceof ZulipApiError && error.code === 'REACTION_ALREADY_EXISTS')) {
        throw error;
      }
    }
  }
}
