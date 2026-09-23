import { Inject, Injectable, Logger } from '@nestjs/common';
import { Constants } from 'src/constants';
import { neutraliseZulipLabel, neutraliseZulipMentions, shorten, shortenCodePoints } from 'src/format';
import { IZulipInterface, ZulipReceivedMessage } from 'src/interfaces/zulip.interface';
import { ChatService, formatEmoteSyncReport } from 'src/services/chat.service';
import { GithubService } from 'src/services/github.service';
import { RSSService } from 'src/services/rss.service';
import { ScheduledMessageService } from 'src/services/scheduled-message.service';
import { BackfillPlatforms, WebhookService, formatBackfillReport } from 'src/services/webhook.service';
import { ZulipService, describeZulipStream, isBotSender } from 'src/services/zulip.service';

/** Zulip's default `max_message_length`, in code points: the server refuses a longer message. */
const MAX_MESSAGE_LENGTH = 10_000;
const SIMILAR_LOOKBACK = 10;
const ECHO_LENGTH = 80;
const ERROR_LENGTH = 300;
const SCHEDULE_ECHO_LENGTH = 80;

/** Straight and curly double quotes: a phone keyboard curls the quotes around `text="two words"`. */
const QUOTES = new Set(['"', '“', '”']);

const BOTH_PLATFORMS: BackfillPlatforms = { discord: true, zulip: true };

const SUPPRESS_EMBEDS_IGNORED =
  '`suppress-embeds` is accepted and ignored: Zulip cannot turn off link previews for one message';

const EMOTE_SYNC_SERVER = `the ${Constants.Discord.EmoteSyncServer.name} Discord server (${Constants.Discord.EmoteSyncServer.id})`;

export type ParsedCommand = { name: string; tokens: string[] };

export type Arguments = { args: string[]; options: Record<string, string> };

export type ParseResult =
  { status: 'ignored' } | { status: 'malformed'; reason: string } | { status: 'ok'; command: ParsedCommand };

export const tokenize = (text: string): string[] | undefined => {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (const char of text) {
    if (QUOTES.has(char)) {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (quoted) {
    return undefined;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
};

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** Only newlines may precede the mention: a line indented by four spaces or a tab is a Markdown code block, which must not run a command. */
const mentionOf = (botName: string) => new RegExp(String.raw`^[\r\n]*@_?\*\*${escapeRegExp(botName)}(\|\d+)?\*\*`, 'i');

/** Zulip's "Quote and reply" starts with a silent mention of the quoted author, so a reply quoting the bot is not a command. */
const QUOTE_AND_REPLY = /^\s*\[said\]\(/;

const OPTION = /^([A-Za-z][\w-]*)=(.*)$/s;

export const parseCommand = (content: string, botName: string): ParseResult => {
  // Without a name there is nothing to mention: `@****` must not read as one.
  const mention = botName && content.match(mentionOf(botName));
  if (!mention) {
    return { status: 'ignored' };
  }
  const after = content.slice(mention[0].length);
  if (QUOTE_AND_REPLY.test(after)) {
    return { status: 'ignored' };
  }
  const tokens = tokenize(after);
  if (!tokens) {
    return { status: 'malformed', reason: 'a quote is opened and never closed' };
  }
  const [name = '', ...rest] = tokens;
  return { status: 'ok', command: { name: name.toLowerCase(), tokens: rest } };
};

export const splitArguments = (tokens: string[], keys: string[]): Arguments => {
  const args: string[] = [];
  const options: Record<string, string> = {};
  for (const token of tokens) {
    const option = token.match(OPTION);
    const key = option?.[1].toLowerCase();
    if (option && key !== undefined && keys.includes(key)) {
      options[key] = option[2];
    } else {
      args.push(token);
    }
  }
  return { args, options };
};

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
  const cut = shortenCodePoints(content, MAX_MESSAGE_LENGTH);
  if (cut === content || countBackticks(cut) % 2 === 0) {
    return cut;
  }
  const shorter = shortenCodePoints(content, MAX_MESSAGE_LENGTH - 1);
  return countBackticks(shorter) % 2 === 0 ? shorter : `${shorter}\``;
};

type StreamMessage = ZulipReceivedMessage & { streamId: number };

type CommandContext = Arguments & { message: StreamMessage };

type Command = {
  usage: string;
  description: string;
  positionals: number;
  options: string[];
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
  ) {}

  async init() {
    this.zulipService.onMessage((message) => this.onZulipMessage(message));
  }

  /** Stream membership is the only authorisation, so a command in a stream the server does not report as private is not run. */
  async onZulipMessage(message: ZulipReceivedMessage) {
    const { streamId } = message;
    if (message.type !== 'stream' || streamId === undefined || !Constants.Zulip.Commands.includes(streamId)) {
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
      return await command.run({ message, args, options });
    } catch (error) {
      this.logger.error(`The Zulip command ${name} failed on message ${message.id}`, error);
      return `${code(name)} failed: ${describeError(error)}`;
    }
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
