import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DateTime } from 'luxon';
import { getConfig } from 'src/config';
import { Constants } from 'src/constants';
import { HolidayDto, IHolidaysInterface } from 'src/interfaces/holidays.interface';
import {
  IZulipInterface,
  ZulipEvent,
  ZulipEventQueue,
  ZulipMessagesDeleted,
  ZulipMessageUpdated,
  ZulipReactionChanged,
  ZulipReceivedMessage,
  ZulipUser,
} from 'src/interfaces/zulip.interface';
import { ZulipApiError } from 'src/repositories/zulip.client';

export type ZulipMessageHandler = (message: ZulipReceivedMessage) => Promise<void> | void;
export type ZulipUpdateHandler = (update: ZulipMessageUpdated) => Promise<void> | void;
export type ZulipDeletionHandler = (deletion: ZulipMessagesDeleted) => Promise<void> | void;
export type ZulipReactionHandler = (reaction: ZulipReactionChanged) => Promise<void> | void;
export type ZulipRegistrationHandler = (registration: { subscribedStreamIds: number[] }) => void;

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/** Bounds the loop against a server that answers polls at once, e.g. long polling disabled or a non-holding proxy. */
const MIN_POLL_INTERVAL_MS = 1_000;
const SHUTDOWN_GRACE_MS = 5_000;
/** No poll goes out while a handler runs, so one that never settles would leave every stream unheard. */
const HANDLER_TIMEOUT_MS = 30_000;
const UNHEALTHY_STREAK = 10;

const isBadEventQueueId = (error: unknown) => error instanceof ZulipApiError && error.code === 'BAD_EVENT_QUEUE_ID';

const isTimeout = (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

const backoffMs = (failures: number) => Math.min(INITIAL_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);

/** Message events carry no `is_bot` flag, but Zulip creates every bot as `{short_name}-bot@{realm host}`. */
export const isBotSender = (message: ZulipReceivedMessage) => /-bot@[^@]+$/i.test(message.senderEmail);

export const describeZulipStream = (streamId: number) => {
  const named = [...Object.entries(Constants.Zulip.TeamStreams), ...Object.entries(Constants.Zulip.Streams)];
  const name = named.find(([, id]) => id === streamId)?.[0];
  return name ? `${streamId} (${name})` : `${streamId}`;
};

const listeningStreams = () =>
  new Set([...Object.values(Constants.Zulip.Expanders).flat(), ...Constants.Zulip.Commands]);

@Injectable()
export class ZulipService implements OnModuleDestroy {
  private logger = new Logger(ZulipService.name);
  private handlers: ZulipMessageHandler[] = [];
  private updateHandlers: ZulipUpdateHandler[] = [];
  private deletionHandlers: ZulipDeletionHandler[] = [];
  private reactionHandlers: ZulipReactionHandler[] = [];
  private registrationHandlers: ZulipRegistrationHandler[] = [];
  private queue?: ZulipEventQueue;
  private registration?: Promise<unknown>;
  private self?: ZulipUser;
  private emptyTopic?: string;
  private loop?: { promise: Promise<void>; controller: AbortController };

  constructor(
    @Inject(IHolidaysInterface) private holidays: IHolidaysInterface,
    @Inject(IZulipInterface) private zulip: IZulipInterface,
  ) {}

  async init() {
    const { zulip } = getConfig();
    if (zulip.bot.apiKey !== 'dev' && zulip.user.apiKey !== 'dev') {
      await this.zulip.init(zulip);
      await this.checkSubscriptions();
      this.startEventLoop();
    }
  }

  onMessage(handler: ZulipMessageHandler) {
    this.handlers.push(handler);
  }

  onMessageUpdate(handler: ZulipUpdateHandler) {
    this.updateHandlers.push(handler);
  }

  onMessagesDeleted(handler: ZulipDeletionHandler) {
    this.deletionHandlers.push(handler);
  }

  onReaction(handler: ZulipReactionHandler) {
    this.reactionHandlers.push(handler);
  }

  onQueueRegistered(handler: ZulipRegistrationHandler) {
    this.registrationHandlers.push(handler);
  }

  get ownUser(): ZulipUser | undefined {
    return this.self;
  }

  /** The realm's name for the empty topic in the messages handlers receive, known once a queue is registered. */
  get emptyTopicName(): string | undefined {
    return this.emptyTopic;
  }

  /** An in-flight registration is awaited: the server creates its queue even if the client never reads the answer. */
  async onModuleDestroy() {
    const loop = this.loop;
    if (!loop) {
      return;
    }
    this.loop = undefined;
    loop.controller.abort();
    await this.registration;
    await this.releaseQueue();

    const grace = new AbortController();
    await Promise.race([loop.promise, sleep(SHUTDOWN_GRACE_MS, grace.signal)]);
    grace.abort();
  }

  private startEventLoop() {
    const controller = new AbortController();
    const promise = this.runEventLoop(controller.signal).catch((error) =>
      this.logger.error('The Zulip event loop stopped on an error it should have caught', error),
    );
    this.loop = { promise, controller };
  }

  private async runEventLoop(signal: AbortSignal) {
    let failures = 0;
    let pace = Promise.resolve();
    const unhealthy = { deadQueues: 0, instantEmptyPolls: 0 };
    const noteUnhealthy = (round: keyof typeof unhealthy) => {
      unhealthy[round]++;
      const streak = unhealthy.deadQueues + unhealthy.instantEmptyPolls;
      if (streak % UNHEALTHY_STREAK === 0) {
        this.logger.warn(
          `The Zulip event loop is not healthy: the server has not held a poll open for the last ${streak} rounds (${unhealthy.deadQueues} dead queues re-registered, ${unhealthy.instantEmptyPolls} polls answered at once with nothing); it keeps trying, at most once a second, but receives nothing in the meantime`,
        );
      }
    };
    while (!signal.aborted) {
      try {
        this.self ??= await this.zulip.getOwnUser();
        this.queue ??= await this.registerQueue();
        const queue = this.queue;

        await pace;
        if (signal.aborted) {
          break;
        }
        let floorElapsed = false;
        pace = sleep(MIN_POLL_INTERVAL_MS, signal).then(() => {
          floorElapsed = true;
        });
        const events = await this.zulip.getEvents(queue, signal);
        if (signal.aborted) {
          break;
        }
        failures = 0;
        if (floorElapsed) {
          unhealthy.deadQueues = 0;
          unhealthy.instantEmptyPolls = 0;
        } else if (events.length === 0) {
          noteUnhealthy('instantEmptyPolls');
        }
        for (const event of events) {
          queue.lastEventId = Math.max(queue.lastEventId, event.id);
          await this.dispatch(event);
        }
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        if (isTimeout(error)) {
          this.logger.debug('The Zulip long poll timed out without a heartbeat, polling again');
          continue;
        }

        failures++;
        if (isBadEventQueueId(error)) {
          this.queue = undefined;
          this.logger.log(
            'The Zulip event queue is gone (garbage-collected or the server restarted), registering a new one',
          );
          noteUnhealthy('deadQueues');
          if (failures === 1) {
            continue;
          }
        } else {
          this.logger.error(`The Zulip event loop failed, retrying in ${backoffMs(failures)}ms`, error);
        }
        await sleep(backoffMs(failures), signal);
      }
    }
    await this.releaseQueue();
  }

  private registerQueue() {
    const registration = this.registerQueueNow();
    this.registration = registration.then(
      () => {},
      () => {},
    );
    return registration;
  }

  private async registerQueueNow() {
    const { queue, subscribedStreamIds, emptyTopicName } = await this.zulip.registerQueue();
    // Set here, not only by the loop's own assignment, so that a shutdown waiting on this registration finds it.
    this.queue = queue;
    this.emptyTopic = emptyTopicName ?? this.emptyTopic;
    this.logger.log(`Registered Zulip event queue ${queue.queueId}`);
    const subscribed = new Set(subscribedStreamIds);
    for (const streamId of listeningStreams()) {
      if (!subscribed.has(streamId)) {
        this.logger.warn(
          `The Zulip bot is not subscribed to stream ${describeZulipStream(streamId)}: its event queue carries no messages from it, so nothing is expanded there until an admin subscribes it`,
        );
      }
    }
    for (const handler of this.registrationHandlers) {
      try {
        handler({ subscribedStreamIds });
      } catch (error) {
        this.logger.error(`A Zulip queue registration handler failed on queue ${queue.queueId}`, error);
      }
    }
    return queue;
  }

  private async releaseQueue() {
    const queue = this.queue;
    this.queue = undefined;
    if (!queue) {
      return;
    }
    try {
      await this.zulip.deleteQueue(queue.queueId);
      this.logger.log(`Deleted Zulip event queue ${queue.queueId}`);
    } catch (error) {
      this.logger.warn(
        `Could not delete Zulip event queue ${queue.queueId}; the server will garbage-collect it`,
        error,
      );
    }
  }

  private async dispatch(event: ZulipEvent) {
    if (event.message) {
      const { message } = event;
      if (message.senderId === this.self?.userId || isBotSender(message)) {
        return;
      }
      for (const handler of this.handlers) {
        await this.runHandler(`message ${message.id}`, () => handler(message));
      }
    } else if (event.update) {
      const { update } = event;
      if (update.renderingOnly || update.userId === null || update.userId === this.self?.userId) {
        return;
      }
      for (const handler of this.updateHandlers) {
        await this.runHandler(`the update of message ${update.messageId}`, () => handler(update));
      }
    } else if (event.deletion) {
      const { deletion } = event;
      for (const handler of this.deletionHandlers) {
        await this.runHandler(`the deletion of messages ${deletion.messageIds.join(', ')}`, () => handler(deletion));
      }
    } else if (event.reaction) {
      const { reaction } = event;
      if (reaction.userId === this.self?.userId) {
        return;
      }
      for (const handler of this.reactionHandlers) {
        await this.runHandler(`a reaction to message ${reaction.messageId}`, () => handler(reaction));
      }
    }
  }

  private async runHandler(describe: string, run: () => Promise<void> | void) {
    let settled = false;
    let abandoned = false;
    const wait = new AbortController();
    void (async () => {
      try {
        await run();
        if (abandoned) {
          this.logger.warn(
            `The Zulip message handler that stalled on ${describe} finished after the loop had stopped waiting for it`,
          );
        }
      } catch (error) {
        this.logger.error(
          `A Zulip message handler failed on ${describe}${abandoned ? ' after the loop had stopped waiting for it' : ''}`,
          error,
        );
      } finally {
        settled = true;
        wait.abort();
      }
    })();
    await sleep(HANDLER_TIMEOUT_MS, wait.signal);
    if (!settled) {
      abandoned = true;
      this.logger.error(
        `A Zulip message handler has not finished ${describe} after ${HANDLER_TIMEOUT_MS}ms; the loop is moving on without it`,
      );
    }
  }

  private async checkSubscriptions() {
    try {
      const subscriptions = await this.zulip.getSubscriptions();
      const subscribed = new Set(subscriptions.map(({ streamId }) => streamId));
      for (const streamId of Constants.Zulip.RequiredSubscriptions) {
        if (!subscribed.has(streamId)) {
          const name = Object.entries(Constants.Zulip.Streams).find(([, id]) => id === streamId)?.[0];
          this.logger.warn(
            `The Zulip bot is not subscribed to stream ${streamId} (${name}): posts to it will fail until an admin subscribes it`,
          );
        }
      }
    } catch (error) {
      this.logger.error('Could not check the Zulip subscriptions of the bot', error);
    }
  }

  @Cron(Constants.Cron.HolidayInfo)
  async notifyHoliday() {
    const tomorrow = DateTime.now().plus({ days: 1 });
    const holidays = await this.holidays.getHolidays('US', tomorrow.year);

    const isRelevantHoliday = (holiday: HolidayDto) =>
      holiday.types?.includes('Public') && (holiday.global || holiday.counties?.includes('US-TX'));
    const holiday = holidays.find((holiday) => holiday.date === tomorrow.toISODate() && isRelevantHoliday(holiday));

    if (!holiday) {
      return;
    }

    await this.zulip.sendMessage({
      stream: Constants.Zulip.Streams.FUTOStaff,
      topic: 'Holidays',
      content: `Tomorrow is a federal holiday: ${holiday.name}. There won't be any meetings tomorrow.`,
    });
  }
}
