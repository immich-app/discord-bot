import { Inject, Injectable, Logger } from '@nestjs/common';
import { Constants } from 'src/constants';
import {
  ZULIP_MAX_MESSAGE_LENGTH,
  neutraliseZulipLabel,
  neutraliseZulipMentions,
  shorten,
  shortenCodePoints,
} from 'src/format';
import { IZulipInterface, ZulipReceivedMessage } from 'src/interfaces/zulip.interface';
import { ChatService, formatEmoteSyncReport } from 'src/services/chat.service';
import { GithubService } from 'src/services/github.service';
import { MirrorActor, MirrorLinkReply, MirrorLinkService } from 'src/services/mirror-link.service';
import { RSSService } from 'src/services/rss.service';
import { ScheduledMessageService } from 'src/services/scheduled-message.service';
import { BackfillPlatforms, WebhookService, formatBackfillReport } from 'src/services/webhook.service';
import { ZulipService, describeZulipStream, isBotSender } from 'src/services/zulip.service';
import { Arguments, ParseResult, parseCommand, splitArguments, tokenize } from 'src/zulip-command-parser';

const SIMILAR_LOOKBACK = 10;
const ECHO_LENGTH = 80;
const ERROR_LENGTH = 300;
const SCHEDULE_ECHO_LENGTH = 80;

const BOTH_PLATFORMS: BackfillPlatforms = { discord: true, zulip: true };

const SUPPRESS_EMBEDS_IGNORED =
  '`suppress-embeds` is accepted and ignored: Zulip cannot turn off link previews for one message';

/** Zulip's roles are ordered: 100 is an owner, 200 an administrator. */
const ZULIP_ADMINISTRATOR_ROLE = 200;

const NOT_AN_ADMINISTRATOR =
  'Only Zulip organization administrators and owners can change or list the Discord-Zulip mirror.';

const EMOTE_SYNC_SERVER = `the ${Constants.Discord.EmoteSyncServer.name} Discord server (${Constants.Discord.EmoteSyncServer.id})`;

/** Whitespace is collapsed because a newline in typed text would let it add Markdown structure in the bot's own voice. */
const code = (text: string) => `\`${neutraliseZulipMentions(text.replaceAll('`', '').replaceAll(/\s+/g, ' '))}\``;

const describeError = (error: unknown) =>
  code(shorten(error instanceof Error ? error.message : String(error), ERROR_LENGTH));

/** Zulip's empty topic is the one it shows as "general chat". */
const describeTopic = (topic: string | null) => (topic ? `topic ${code(topic)}` : 'the general chat topic');

const notScheduled = (name: string) =>
  `There is no scheduled message ${code(name)} on Zulip; ${code('schedule-list')} lists them.`;

const isBoolean = (value: string | undefined) => value === undefined || /^(true|false)$/i.test(value);

const ignoredSuppressEmbeds = (options: Record<string, string>) =>
  options['suppress-embeds'] === undefined ? '' : ` ${SUPPRESS_EMBEDS_IGNORED}.`;

const countBackticks = (text: string) => (text.match(/`/g) ?? []).length;

/** The bot's own code spans hold no backtick, so a cut leaving an odd number of them was cut inside one and must close it. */
const fit = (content: string) => {
  const cut = shortenCodePoints(content, ZULIP_MAX_MESSAGE_LENGTH);
  if (cut === content || countBackticks(cut) % 2 === 0) {
    return cut;
  }
  const shorter = shortenCodePoints(content, ZULIP_MAX_MESSAGE_LENGTH - 1);
  return countBackticks(shorter) % 2 === 0 ? shorter : `${shorter}\``;
};

type StreamMessage = ZulipReceivedMessage & { streamId: number };

type CommandContext = Arguments & { message: StreamMessage };

type Command = {
  usage: string;
  description: string;
  positionals: number;
  options: string[];
  /** Taken in any stream, from organization administrators and owners only. */
  administrators?: true;
  run: (context: CommandContext) => Promise<string | undefined>;
};

type BackgroundJob = { ack: string; work: () => Promise<string> };

@Injectable()
export class ZulipCommandService {
  private logger = new Logger(ZulipCommandService.name);
  private running = new Set<string>();
  private warnedNoName = false;

  private commands: Record<string, Command> = {
    help: {
      usage: 'help',
      description: 'this list',
      positionals: 0,
      options: [],
      run: () => Promise.resolve(this.help()),
    },
    'emote-sync': {
      usage: 'emote-sync',
      description: `upload every emote of ${EMOTE_SYNC_SERVER} to Zulip and Mattermost, skipping a name the platform already has`,
      positionals: 0,
      options: [],
      run: (context) =>
        this.inBackground('emote-sync', context, {
          ack: `Syncing the emotes of ${EMOTE_SYNC_SERVER} to Zulip and Mattermost, this can take a few minutes…`,
          work: async () => {
            const report = await this.chatService.syncEmotes(Constants.Discord.EmoteSyncServer.id);
            return neutraliseZulipMentions(formatEmoteSyncReport(report, `the emotes of ${EMOTE_SYNC_SERVER}`));
          },
        }),
    },
    'backfill-pull-requests': {
      usage: 'backfill-pull-requests <number|all>',
      description:
        'create the Discord team thread and the Zulip topic that open pull request lacks, or with `all` for every open one; one that has both, was opened by a bot, or is not in the database is skipped, and nothing that exists is touched',
      positionals: 1,
      options: ['number'],
      run: (context) => this.backfillPullRequests(context),
    },
    fourthwall: {
      usage: 'fourthwall update <id|all>',
      description: 'fetch that Fourthwall order again and update its row in the database, or with `all` every order',
      positionals: 2,
      options: ['id'],
      run: (context) => this.fourthwall(context),
    },
    'schedule-add': {
      usage: 'schedule-add <name> cron=<expression> message=<text> [topic=<topic>] [suppress-embeds=<true|false>]',
      description: `post the message in this stream on that cron schedule, in the topic given or this one; ${SUPPRESS_EMBEDS_IGNORED}`,
      positionals: 1,
      options: ['name', 'cron', 'message', 'topic', 'suppress-embeds'],
      run: (context) => this.scheduleAdd(context),
    },
    'schedule-list': {
      usage: 'schedule-list',
      description: 'list every scheduled message on Zulip, with its schedule, stream, topic and the start of its text',
      positionals: 0,
      options: [],
      run: () => this.scheduleList(),
    },
    'schedule-edit': {
      usage: 'schedule-edit <name> [cron=<expression>] [message=<text>] [topic=<topic>] [suppress-embeds=<true|false>]',
      description: `change the schedule, text or topic of a scheduled message on Zulip, from its next post on; ${SUPPRESS_EMBEDS_IGNORED}`,
      positionals: 1,
      options: ['name', 'cron', 'message', 'topic', 'suppress-embeds'],
      run: (context) => this.scheduleEdit(context),
    },
    'schedule-remove': {
      usage: 'schedule-remove <name>',
      description: 'delete a scheduled message on Zulip, which stops it',
      positionals: 1,
      options: ['name'],
      run: (context) => this.scheduleRemove(context),
    },
    'rss-subscribe': {
      usage: 'rss-subscribe <url> [topic=<topic>]',
      description:
        'post the newest post of that RSS feed now, and every new one after it (checked every 15 minutes), in this stream, in the topic given or this one',
      positionals: 1,
      options: ['url', 'topic'],
      run: (context) => this.rssSubscribe(context),
    },
    'rss-unsubscribe': {
      usage: 'rss-unsubscribe <url>',
      description: 'stop posting that RSS feed in this stream',
      positionals: 1,
      options: ['url'],
      run: (context) => this.rssUnsubscribe(context),
    },
    'rss-list': {
      usage: 'rss-list',
      description: 'list the RSS feeds this stream is subscribed to, with their topics',
      positionals: 0,
      options: [],
      run: ({ message }) => this.rssList(message),
    },
    'mirror-link': {
      usage: 'mirror-link [topic=<main topic>]',
      description:
        "start mirroring this stream with a Discord text channel or forum, both ways: this answers with the `/mirror-link` command a Discord administrator then runs in that channel; the main topic (text channels only, `#channel-name` by default) holds the channel's own messages",
      positionals: 0,
      options: ['topic'],
      administrators: true,
      run: (context) => this.mirrorLink(context),
    },
    'mirror-unlink': {
      usage: 'mirror-unlink',
      description: 'stop mirroring this stream with its Discord channel, and announce it on both sides',
      positionals: 0,
      options: [],
      administrators: true,
      run: ({ message }) => this.mirrorUnlink(message),
    },
    'mirror-list': {
      usage: 'mirror-list',
      description: 'list the mirrored channels and streams, and the linked accounts',
      positionals: 0,
      options: [],
      administrators: true,
      run: () => this.mirrorLinks.list('zulip'),
    },
    'discord-unlink': {
      usage: 'discord-unlink',
      description:
        'unlink your Zulip account from your Discord account, so that your messages appear on Discord as "Name (Zulip)"',
      positionals: 0,
      options: [],
      run: ({ message }) => this.mirrorLinks.unlinkIdentity({ zulipUserId: message.senderId }, 'zulip'),
    },
    similar: {
      usage: 'similar [text]',
      description:
        'list the immich-app/immich issues and discussions like the text, or without text like the last message a human wrote in this topic, looked for among its ten newest',
      positionals: Number.POSITIVE_INFINITY,
      options: ['text'],
      run: (context) => this.similar(context),
    },
  };

  constructor(
    @Inject(IZulipInterface) private zulip: IZulipInterface,
    private zulipService: ZulipService,
    private chatService: ChatService,
    private githubService: GithubService,
    private webhookService: WebhookService,
    private scheduledMessageService: ScheduledMessageService,
    private rssService: RSSService,
    private mirrorLinks: MirrorLinkService,
  ) {}

  async init() {
    this.zulipService.onMessage((message) => this.onZulipMessage(message));
  }

  /**
   * Stream membership is the authorisation, so a command outside the team streams is not run; the mirror commands,
   * whose stream is usually not a team one, check the sender's role instead.
   */
  async onZulipMessage(message: ZulipReceivedMessage) {
    const { streamId } = message;
    if (message.type === 'private') {
      await this.onDirectMessage(message);
      return;
    }
    if (streamId === undefined) {
      return;
    }
    const botName = this.zulipService.ownUser?.fullName;
    if (!botName) {
      if (!this.warnedNoName) {
        this.warnedNoName = true;
        this.logger.warn('Zulip reported no name for the bot, so no message can mention it: commands are off');
      }
      return;
    }
    const parsed = parseCommand(message.content, botName);
    if (parsed.status === 'ignored') {
      return;
    }
    const anyStream = parsed.status === 'ok' && this.commands[parsed.command.name]?.administrators;
    if (!anyStream && !Constants.Zulip.Commands.includes(streamId)) {
      return;
    }
    const reply = await this.answer({ ...message, streamId }, parsed);
    if (reply === undefined) {
      return;
    }
    try {
      await this.reply(message, reply);
    } catch (error) {
      this.logger.error(`Could not reply to the Zulip command in message ${message.id}`, error);
    }
  }

  private async answer(message: StreamMessage, parsed: Exclude<ParseResult, { status: 'ignored' }>) {
    if (parsed.status === 'malformed') {
      return `Could not read that: ${parsed.reason}. Mention me with ${code('help')} for the commands.`;
    }
    const { name, tokens } = parsed.command;
    if (name === '') {
      return this.help();
    }
    const command = this.commands[name];
    if (!command) {
      return `Unknown command ${code(shorten(name, ECHO_LENGTH))}. Mention me with ${code('help')} for the list.`;
    }
    // With no autocomplete, an argument the command does not take must be answered, never dropped: a typo in `number=` would otherwise backfill every PR.
    const { args, options } = splitArguments(tokens, command.options);
    if (args.length > command.positionals) {
      return this.usage(name);
    }
    try {
      if (command.administrators && !(await this.isAdministrator(message.senderId))) {
        return NOT_AN_ADMINISTRATOR;
      }
      return await command.run({ message, args, options });
    } catch (error) {
      this.logger.error(`The Zulip command ${name} failed on message ${message.id}`, error);
      return `${code(name)} failed: ${describeError(error)}`;
    }
  }

  /**
   * Only `link <code>` and `unlink` are taken in a direct message, exactly as typed, so that nothing else said to the
   * bot, in a group conversation too, gets an answer. The answer goes to the sender alone.
   */
  private async onDirectMessage(message: ZulipReceivedMessage) {
    const parsed = parseCommand(message.content, this.zulipService.ownUser?.fullName ?? '');
    const tokens = parsed.status === 'ok' ? [parsed.command.name, ...parsed.command.tokens] : tokenize(message.content);
    if (parsed.status === 'malformed' || !tokens) {
      return;
    }
    const [name = '', ...args] = tokens;
    const command = name.toLowerCase();
    let run: (() => Promise<string>) | undefined;
    if ((command === 'link' || command === 'discord-link') && args.length === 1) {
      run = () =>
        this.mirrorLinks.redeemIdentityCode({ id: message.senderId, fullName: message.senderFullName }, args[0]);
    } else if ((command === 'unlink' || command === 'discord-unlink') && args.length === 0) {
      run = () => this.mirrorLinks.unlinkIdentity({ zulipUserId: message.senderId }, 'zulip');
    }
    if (!run) {
      return;
    }

    let reply: string;
    try {
      reply = await run();
    } catch (error) {
      this.logger.error(`The Zulip direct message command ${command} failed on message ${message.id}`, error);
      reply = `${code(command)} failed: ${describeError(error)}`;
    }
    try {
      await this.zulip.sendDirectMessage([message.senderId], fit(reply));
    } catch (error) {
      this.logger.error(`Could not answer the Zulip direct message ${message.id}`, error);
    }
  }

  private async isAdministrator(userId: number) {
    const { role } = await this.zulip.getUser(userId);
    return role <= ZULIP_ADMINISTRATOR_ROLE;
  }

  private actorOf(message: StreamMessage): MirrorActor {
    return { platform: 'zulip', id: String(message.senderId), name: message.senderFullName };
  }

  /** The announcement says it all in its own topic, so a command given there is answered with the rest only. */
  private linkReply(message: StreamMessage, { summary, details, zulipAnnouncement }: MirrorLinkReply) {
    const announcedHere = zulipAnnouncement?.streamId === message.streamId && zulipAnnouncement.topic === message.topic;
    const lines = announcedHere ? details : [summary, ...details];
    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  private mirrorLink({ message, options }: CommandContext) {
    return this.mirrorLinks.requestLink({
      zulipStreamId: message.streamId,
      mainTopic: options.topic,
      actor: this.actorOf(message),
    });
  }

  private async mirrorUnlink(message: StreamMessage) {
    const reply = await this.mirrorLinks.unlink({ zulipStreamId: message.streamId, actor: this.actorOf(message) });
    return this.linkReply(message, reply);
  }

  private reply({ streamId, topic }: ZulipReceivedMessage, content: string) {
    return this.zulip.sendMessage({ stream: streamId!, topic, content: fit(content) });
  }

  private help() {
    const lines = Object.values(this.commands).map(({ usage, description }) => `- ${code(usage)}: ${description}`);
    return [
      'Mention me at the start of a message in a team stream, then one of:',
      ...lines,
      // The blank line ends the list: without it, Markdown reads the next line as the last item's continuation.
      '',
      `Arguments are positional or ${code('key=value')}; quote a value with spaces (${code('text="two words"')}). Every reply is posted here, in the topic.`,
      `The ${code('mirror-*')} commands are taken in any stream, from organization administrators and owners only. To link your Zulip account with your Discord account, run ${code('/zulip-link')} on Discord and send me the code it gives you in a direct message.`,
    ].join('\n');
  }

  private usage(name: string) {
    return `Usage: ${code(this.commands[name].usage)}`;
  }

  private alreadyRunning(name: string) {
    return `${code(name)} is already running; wait for it to finish.`;
  }

  /** Shares `inBackground`'s lock, so a single-PR backfill cannot run while the all-PR one is on it and create a thread or topic twice. */
  private async underLock(name: string, run: () => Promise<string>) {
    if (this.running.has(name)) {
      return this.alreadyRunning(name);
    }
    this.running.add(name);
    try {
      return await run();
    } finally {
      this.running.delete(name);
    }
  }

  /** The loop waits at most 30s on a handler and polls nothing meanwhile, so a slow command is acknowledged before any of its work starts and its outcome posted when done. */
  private async inBackground(name: string, { message }: CommandContext, { ack, work }: BackgroundJob) {
    if (this.running.has(name)) {
      return this.alreadyRunning(name);
    }
    this.running.add(name);
    try {
      await this.reply(message, ack);
    } catch (error) {
      this.running.delete(name);
      throw error;
    }
    void work()
      .then(
        (outcome) => this.reply(message, outcome),
        (error) => {
          this.logger.error(`The Zulip command ${name} failed on message ${message.id}`, error);
          return this.reply(message, `${code(name)} failed: ${describeError(error)}`);
        },
      )
      .catch((error) => this.logger.error(`Could not post the outcome of the Zulip command ${name}`, error))
      .finally(() => this.running.delete(name));
    return undefined;
  }

  /** The wide form must be asked for by name (`all`): the bare command gets the usage, so the expensive form is never the shortest thing to type. */
  private async backfillPullRequests(context: CommandContext) {
    const given = this.oneArgument(context, 'number');
    if (!given) {
      return this.usage('backfill-pull-requests');
    }
    if (given.toLowerCase() !== 'all') {
      if (!/^#?\d+$/.test(given)) {
        return this.usage('backfill-pull-requests');
      }
      const number = Number(given.replace('#', ''));
      return this.underLock('backfill-pull-requests', async () => {
        const pullRequest = await this.githubService.getOpenPullRequest(number);
        if (!pullRequest) {
          return `Pull request #${number} is not open in immich-app/immich, so there is nothing to backfill.`;
        }
        const report = await this.webhookService.backfillPullRequests([pullRequest], BOTH_PLATFORMS);
        return formatBackfillReport(report, `pull request #${number}`);
      });
    }
    // Listing the pull requests is part of the work: a rate-limited GitHub client can wait an hour before it answers.
    return this.inBackground('backfill-pull-requests', context, {
      ack: 'Going through every open pull request, creating the Discord thread and the Zulip topic each one lacks; this can take a while…',
      work: async () => {
        const pullRequests = await this.githubService.getOpenPullRequests();
        return formatBackfillReport(await this.webhookService.backfillPullRequests(pullRequests, BOTH_PLATFORMS));
      },
    });
  }

  private oneArgument({ args, options }: CommandContext, key: string, position = 0) {
    const positional = args[position];
    const named = options[key];
    if (positional !== undefined && named !== undefined) {
      return undefined;
    }
    return positional ?? named ?? null;
  }

  private async fourthwall(context: CommandContext) {
    const [action] = context.args;
    const id = this.oneArgument(context, 'id', 1);
    if (action?.toLowerCase() !== 'update' || !id) {
      return this.usage('fourthwall');
    }
    if (id.toLowerCase() !== 'all') {
      return this.underLock('fourthwall', async () => {
        await this.chatService.updateFourthwallOrders(id);
        return `Updated Fourthwall order ${code(id)}.`;
      });
    }
    return this.inBackground('fourthwall', context, {
      ack: 'Updating every Fourthwall order, this can take a while…',
      work: async () => {
        await this.chatService.updateFourthwallOrders();
        return 'Updated every Fourthwall order.';
      },
    });
  }

  private async scheduleAdd(context: CommandContext) {
    const { message, options } = context;
    const name = this.oneArgument(context, 'name');
    const { cron, message: text, topic = message.topic } = options;
    if (!name || !cron || !text || !isBoolean(options['suppress-embeds'])) {
      return this.usage('schedule-add');
    }
    await this.scheduledMessageService.createScheduledMessage({
      name,
      cronExpression: cron,
      message: text,
      channelId: String(message.streamId),
      topic,
      createdBy: String(message.senderId),
      service: 'zulip',
    });
    return `Scheduled message ${code(name)} created with cron ${code(cron)}, posting in ${describeTopic(topic)} of this stream.${ignoredSuppressEmbeds(options)}`;
  }

  private async scheduleList() {
    const messages = await this.scheduledMessageService.listScheduledMessages('zulip');
    if (messages.length === 0) {
      return 'There are no scheduled messages on Zulip.';
    }
    return [
      'Scheduled messages on Zulip:',
      ...messages.map(
        ({ name, cronExpression, channelId, topic, message }) =>
          `- ${code(name)}: ${code(cronExpression)} in stream ${describeZulipStream(Number(channelId))}, ${describeTopic(topic)}: ${code(shorten(message.replaceAll(/\s+/g, ' ').trim(), SCHEDULE_ECHO_LENGTH))}`,
      ),
    ].join('\n');
  }

  private async scheduleEdit(context: CommandContext) {
    const { options } = context;
    const name = this.oneArgument(context, 'name');
    const { cron, message: text, topic } = options;
    const changed = cron !== undefined || text !== undefined || topic !== undefined;
    if (!name || !changed || cron === '' || text === '' || !isBoolean(options['suppress-embeds'])) {
      return this.usage('schedule-edit');
    }
    const updated = await this.scheduledMessageService.updateScheduledMessage(name, 'zulip', {
      cronExpression: cron,
      message: text,
      topic,
    });
    if (!updated) {
      return notScheduled(name);
    }
    return `Updated scheduled message ${code(name)}: it posts with cron ${code(updated.cronExpression)} in ${describeTopic(updated.topic)} of stream ${describeZulipStream(Number(updated.channelId))}.${ignoredSuppressEmbeds(options)}`;
  }

  private async scheduleRemove(context: CommandContext) {
    const name = this.oneArgument(context, 'name');
    if (!name) {
      return this.usage('schedule-remove');
    }
    const removed = await this.scheduledMessageService.deleteScheduledMessage(name, 'zulip');
    return removed ? `Removed scheduled message ${code(name)}.` : notScheduled(name);
  }

  private async rssSubscribe(context: CommandContext) {
    const { message, options } = context;
    const url = this.oneArgument(context, 'url');
    if (!url) {
      return this.usage('rss-subscribe');
    }
    const topic = options.topic ?? message.topic;
    const existing = (await this.rssService.getZulipRSSFeeds(message.streamId)).find((feed) => feed.url === url);
    if (existing) {
      return `This stream is already subscribed to ${code(url)}, in ${describeTopic(existing.topic)}.`;
    }
    return this.inBackground('rss-subscribe', context, {
      ack: `Subscribing this stream to ${code(url)}: fetching the feed to post its newest post in ${describeTopic(topic)}…`,
      work: async () => {
        await this.rssService.createZulipRSSFeed(url, message.streamId, topic);
        return `Subscribed this stream to ${code(url)}: its new posts go to ${describeTopic(topic)}.`;
      },
    });
  }

  private async rssUnsubscribe(context: CommandContext) {
    const url = this.oneArgument(context, 'url');
    if (!url) {
      return this.usage('rss-unsubscribe');
    }
    const removed = await this.rssService.removeZulipRSSFeed(url, context.message.streamId);
    return removed
      ? `Unsubscribed this stream from ${code(url)}.`
      : `This stream is not subscribed to ${code(url)}; ${code('rss-list')} lists the feeds it is.`;
  }

  private async rssList(message: StreamMessage) {
    const feeds = await this.rssService.getZulipRSSFeeds(message.streamId);
    if (feeds.length === 0) {
      return 'This stream is not subscribed to any RSS feed.';
    }
    return [
      'RSS feeds of this stream:',
      ...feeds.map(({ url, topic }) => `- ${code(url)} in ${describeTopic(topic)}`),
    ].join('\n');
  }

  private async similar({ message, args, options }: CommandContext) {
    if (options.text !== undefined && args.length > 0) {
      return this.usage('similar');
    }
    const given = options.text ?? args.join(' ');
    const subject = given ? { content: given } : await this.lastHumanMessage(message);
    if (!subject) {
      return `There is no message in this topic to compare; pass the text instead: ${code('similar text="…"')}.`;
    }
    const result = await this.chatService.handleFindSimilarIssuesOrDiscussions(subject.content, neutraliseZulipLabel);
    const echo = code(shorten(subject.content.replaceAll(/\s+/g, ' ').trim(), ECHO_LENGTH));
    return result ? `Similar to ${echo}:\n${neutraliseZulipMentions(result)}` : `Nothing similar to ${echo} was found.`;
  }

  private async lastHumanMessage(message: StreamMessage) {
    const botName = this.zulipService.ownUser?.fullName ?? '';
    const ownUserId = this.zulipService.ownUser?.userId;
    const messages = await this.zulip.getMessages({
      stream: message.streamId,
      topic: message.topic,
      numBefore: SIMILAR_LOOKBACK,
    });
    return messages
      .filter(
        (candidate) =>
          candidate.id !== message.id &&
          candidate.senderId !== ownUserId &&
          !isBotSender(candidate) &&
          parseCommand(candidate.content, botName).status === 'ignored',
      )
      .sort((a, b) => a.id - b.id)
      .at(-1);
  }
}
