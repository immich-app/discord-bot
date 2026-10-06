import { Inject, Injectable, Logger } from '@nestjs/common';
import { Constants } from 'src/constants';
import {
  ZULIP_MAX_MESSAGE_LENGTH,
  neutraliseZulipLabel,
  neutraliseZulipMentions,
  plural,
  shorten,
  shortenCodePoints,
} from 'src/format';
import { IGitlabInterface } from 'src/interfaces/gitlab.interface';
import { IZulipInterface, ZulipReceivedMessage } from 'src/interfaces/zulip.interface';
import { topicKey } from 'src/mirror/names';
import { ChatService, formatEmoteSyncReport } from 'src/services/chat.service';
import { GithubService } from 'src/services/github.service';
import { MirrorActor, MirrorLinkReply, MirrorLinkService } from 'src/services/mirror-link.service';
import { RSSService } from 'src/services/rss.service';
import { ScheduledMessageService } from 'src/services/scheduled-message.service';
import { BackfillPlatforms, WebhookService, formatBackfillReport } from 'src/services/webhook.service';
import {
  ExpanderGroupEmptyError,
  ZulipExpanderService,
  findRepository,
  gitlabPath,
  isGitlabRepository,
  isPattern,
  sameRepository,
} from 'src/services/zulip-expander.service';
import { ZulipService, isBotSender } from 'src/services/zulip.service';
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

const MIRROR = 'change or list the Discord-Zulip mirror';

const EXPANDER_GROUP_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** `threshold` is a Postgres integer. */
const MAX_THRESHOLD = 2_147_483_647;

const REPOSITORY_NAME = /^[\w.-]+\/[\w.-]+$/;

const GITLAB_PROJECT_NAME = /^[\w.-]+(\/[\w.-]+)+$/;

const GITHUB_OWNER_NAME = /^[\w.-]+$/;

const GITLAB_GROUP_NAME = /^[\w.-]+(\/[\w.-]+)*$/;

/** `info` names this many repositories of a pattern, and counts the rest. */
const MAX_LISTED_REPOSITORIES = 30;

const EXPANDER_GROUP = 'expander-group';

const REPOSITORY_FORMS = `\`owner/repo\` on GitHub or \`${Constants.Gitlab.Host}/namespace/project\`, or \`owner/*\` or \`${Constants.Gitlab.Host}/namespace/*\` for every repository of that owner or group, kept up to date`;

const isWellFormed = (entry: string) => {
  const owner = isPattern(entry) ? entry.slice(0, -2) : entry;
  if (isGitlabRepository(entry)) {
    return (isPattern(entry) ? GITLAB_GROUP_NAME : GITLAB_PROJECT_NAME).test(gitlabPath(owner));
  }
  return isPattern(entry) ? GITHUB_OWNER_NAME.test(owner) : REPOSITORY_NAME.test(entry);
};

/** Takes `owner/repo`, a GitLab project with its host, or either's URL. */
const toRepositoryName = (given: string) =>
  given
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?github\.com\//i, '')
    .replace(/\/-\/.*$/, '')
    .replace(/(\.git)?\/*$/i, '');

/** Who made a row, for its `createdBy`. */
const describeZulipSender = (message: StreamMessage) => `${message.senderFullName} on Zulip (user ${message.senderId})`;

const countRepositories = (count: number) => `${count} ${count === 1 ? 'repository' : 'repositories'}`;

const listRepositories = (repositories: string[]) => repositories.map((repository) => code(repository)).join(', ');

const NO_DEFAULT =
  'No group here names a repository of its own, only patterns, so a bare `#1234` expands only for a pull request updated in the last two weeks; `expanders default <repository>` picks one.';

const NOT_SUBSCRIBED =
  '⚠ I am not subscribed to this stream, so none of its messages reach me and nothing is expanded here until an administrator subscribes me.';

const EMOTE_SYNC_SERVER = `the ${Constants.Discord.EmoteSyncServer.name} Discord server (${Constants.Discord.EmoteSyncServer.id})`;

/** Whitespace is collapsed because a newline in typed text would let it add Markdown structure in the bot's own voice. */
const code = (text: string) => `\`${neutraliseZulipMentions(text.replaceAll('`', '').replaceAll(/\s+/g, ' '))}\``;

const describeError = (error: unknown) =>
  code(shorten(error instanceof Error ? error.message : String(error), ERROR_LENGTH));

/** Zulip's empty topic is the one it shows as "general chat". */
const describeTopic = (topic: string | null) => (topic ? `topic ${code(topic)}` : 'the general chat topic');

/** Scheduled message names are unique across every stream and platform. */
const SCHEDULED_MESSAGE_NAME_UNIQUE = 'scheduled_message_name_uq';

const notScheduled = (name: string) =>
  `There is no scheduled message ${code(name)} in this stream; ${code('schedule-list')} lists them.`;

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
  /** Taken from organization administrators and owners only; what they alone can do, for the refusal. */
  administrators?: string;
  /** Taken in the team streams only: it acts on more than the stream it is given in. */
  teamStreams?: boolean;
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
      run: ({ message }) => Promise.resolve(this.help(message.streamId)),
    },
    'emote-sync': {
      usage: 'emote-sync',
      description: `upload every emote of ${EMOTE_SYNC_SERVER} to Zulip, skipping a name Zulip already has`,
      positionals: 0,
      options: [],
      teamStreams: true,
      run: (context) =>
        this.inBackground('emote-sync', context, {
          ack: `Syncing the emotes of ${EMOTE_SYNC_SERVER} to Zulip, this can take a few minutes…`,
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
      teamStreams: true,
      run: (context) => this.backfillPullRequests(context),
    },
    fourthwall: {
      usage: 'fourthwall update <id|all>',
      description: 'fetch that Fourthwall order again and update its row in the database, or with `all` every order',
      positionals: 2,
      options: ['id'],
      teamStreams: true,
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
      description: 'list the scheduled messages of this stream, with their schedule, topic and the start of their text',
      positionals: 0,
      options: [],
      run: (context) => this.scheduleList(context),
    },
    'schedule-edit': {
      usage: 'schedule-edit <name> [cron=<expression>] [message=<text>] [topic=<topic>] [suppress-embeds=<true|false>]',
      description: `change the schedule, text or topic of a scheduled message of this stream, from its next post on; ${SUPPRESS_EMBEDS_IGNORED}`,
      positionals: 1,
      options: ['name', 'cron', 'message', 'topic', 'suppress-embeds'],
      run: (context) => this.scheduleEdit(context),
    },
    'schedule-remove': {
      usage: 'schedule-remove <name>',
      description: 'delete a scheduled message of this stream, which stops it',
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
        "start mirroring this stream with a Discord text channel or forum, both ways: this answers with the `/mirror-link` command a Discord administrator then runs in that channel; the main topic (text channels only, general chat by default) holds the channel's own messages",
      positionals: 0,
      options: ['topic'],
      administrators: MIRROR,
      run: (context) => this.mirrorLink(context),
    },
    'mirror-unlink': {
      usage: 'mirror-unlink',
      description: 'stop mirroring this stream with its Discord channel, and announce it on both sides',
      positionals: 0,
      options: [],
      administrators: MIRROR,
      run: ({ message }) => this.mirrorUnlink(message),
    },
    'mirror-backfill': {
      usage: 'mirror-backfill',
      description:
        'copy the messages of the Discord channel or thread this topic mirrors that are not here yet into this topic, oldest first, between two notices; new Discord messages there wait until it is done',
      positionals: 0,
      options: [],
      administrators: MIRROR,
      run: ({ message }) => this.mirrorBackfill(message),
    },
    'mirror-list': {
      usage: 'mirror-list',
      description: 'list the mirrored channels and streams, and the linked accounts',
      positionals: 0,
      options: [],
      administrators: MIRROR,
      run: () => this.mirrorLinks.list('zulip'),
    },
    expanders: {
      usage: 'expanders <on <group>|off [group]|default <repository>|list>',
      description: `turn a group of repositories on or off in this stream for a bare \`#1234\` and \`name#1234\` to look among (\`off\` alone turns off every group), choose which of its repositories \`#1234\` goes to here, or \`list\` the streams with groups; GitHub and gitlab.futo.org issue, pull request, merge request and discussion links, file permalinks and \`owner/name#1234\` expand in every subscribed stream, with or without a group, and x.com links are mirrored on nitter.net`,
      positionals: 2,
      options: [],
      run: (context) => this.expanders(context),
    },
    'expander-group': {
      usage:
        'expander-group <create|add|remove> <group> <repository>… | threshold <group> <number> | delete <group> | info <group> | list',
      description: `create a group of repositories (${REPOSITORY_FORMS}, or their URLs) for \`expanders on\`, the first one it names itself, not a pattern's, its default for \`#1234\`; add or remove repositories; with \`threshold\`, have a bare \`#1234\` below the number expand only for a pull request updated in the last two weeks; or delete the group, which turns it off everywhere; \`info\` shows one group's repositories and streams, \`list\` every group`,
      positionals: Number.POSITIVE_INFINITY,
      options: [],
      run: (context) => this.expanderGroup(context),
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
    @Inject(IGitlabInterface) private gitlab: IGitlabInterface,
    private zulipService: ZulipService,
    private chatService: ChatService,
    private githubService: GithubService,
    private webhookService: WebhookService,
    private scheduledMessageService: ScheduledMessageService,
    private rssService: RSSService,
    private mirrorLinks: MirrorLinkService,
    private zulipExpanders: ZulipExpanderService,
  ) {}

  async init() {
    this.zulipService.onMessage((message) => this.onZulipMessage(message), { withBots: true });
  }

  /**
   * Stream membership is the authorisation, so a command outside the team streams is not run; the mirror commands,
   * whose stream is usually not a team one, check the sender's role instead. Other bots get the commands that mention
   * the bot, and nothing in a direct message.
   */
  async onZulipMessage(message: ZulipReceivedMessage) {
    const { streamId } = message;
    if (message.type === 'private') {
      if (!isBotSender(message)) {
        await this.onDirectMessage(message);
      }
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
    // A mention alone is `help`.
    const name = parsed.status === 'ok' ? parsed.command.name || 'help' : undefined;
    const reply =
      name && this.commands[name]?.teamStreams && !Constants.Zulip.Commands.includes(streamId)
        ? `${code(name)} is taken in the Immich team streams only.`
        : await this.answer({ ...message, streamId }, parsed);
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
      return this.help(message.streamId);
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
        return `Only Zulip organization administrators and owners can ${command.administrators}.`;
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
    // With others in the conversation, a command mentions the bot as in a stream, so that chat is never taken for one.
    const isGroup = (message.recipientIds?.length ?? 0) > 2;
    if (isGroup && parsed.status !== 'ok') {
      return;
    }
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
    const announcedHere =
      zulipAnnouncement?.streamId === message.streamId && topicKey(zulipAnnouncement.topic) === topicKey(message.topic);
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

  /** Acknowledged at once; the end notice in the topic is the report, and only a backfill with none is answered. */
  private async mirrorBackfill(message: StreamMessage) {
    const result = await this.mirrorLinks.backfill(
      { target: { zulipStreamId: message.streamId, topic: message.topic }, actor: this.actorOf(message) },
      async (ack) => {
        await this.reply(message, ack);
      },
    );
    if ('reply' in result) {
      return result.reply;
    }
    void result.done
      .then((report) => (report === undefined ? undefined : this.reply(message, report)))
      .catch((error) => this.logger.error('Could not post the outcome of the Zulip command mirror-backfill', error));
    return undefined;
  }

  private reply({ streamId, topic }: ZulipReceivedMessage, content: string) {
    return this.zulip.sendMessage({ stream: streamId!, topic, content: fit(content) });
  }

  /** Outside the team streams, only the commands taken there. */
  private help(streamId: number) {
    const teamStream = Constants.Zulip.Commands.includes(streamId);
    const lines = Object.values(this.commands)
      .filter(({ teamStreams }) => teamStream || !teamStreams)
      .map(
        ({ usage, description, administrators, teamStreams }) =>
          `- ${code(usage)}${administrators ? ' (administrators)' : teamStreams ? ' (team streams)' : ''}: ${description}`,
      );
    return [
      teamStream
        ? 'Mention me at the start of a message, then one of:'
        : `Mention me at the start of a message, then one of these (the commands the Immich team streams alone take are left out; ${code('help')} there lists every one):`,
      ...lines,
      // The blank line ends the list: without it, Markdown reads the next line as the last item's continuation.
      '',
      `Arguments are positional or ${code('key=value')}; quote a value with spaces (${code('text="two words"')}). Every reply is posted here, in the topic.`,
      `The commands marked (administrators) are taken from organization administrators and owners only, and the ones marked (team streams) in the Immich team streams only. Scheduled messages, RSS feeds and \`expanders\` act on this stream alone, while expander groups are shared by every stream. To link your Zulip account with your Discord account, run ${code('/zulip-link')} on Discord and send me the code it gives you in a direct message.`,
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
    try {
      await this.scheduledMessageService.createScheduledMessage({
        name,
        cronExpression: cron,
        message: text,
        channelId: String(message.streamId),
        topic,
        createdBy: String(message.senderId),
        service: 'zulip',
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(SCHEDULED_MESSAGE_NAME_UNIQUE)) {
        throw error;
      }
      const here = await this.scheduledMessageService.listScheduledMessages('zulip', {
        channelId: String(message.streamId),
      });
      return here.some((scheduled) => scheduled.name === name)
        ? `There is already a scheduled message named ${code(name)} in this stream; ${code(`schedule-edit ${name}`)} changes it.`
        : `There is already a scheduled message named ${code(name)}, in another stream or on Discord: every stream and Discord share the names, so pick another.`;
    }
    return `Scheduled message ${code(name)} created with cron ${code(cron)}, posting in ${describeTopic(topic)} of this stream.${ignoredSuppressEmbeds(options)}`;
  }

  private async scheduleList({ message }: CommandContext) {
    const messages = await this.scheduledMessageService.listScheduledMessages('zulip', {
      channelId: String(message.streamId),
    });
    if (messages.length === 0) {
      return 'There are no scheduled messages in this stream.';
    }
    return [
      'Scheduled messages of this stream:',
      ...messages.map(
        ({ name, cronExpression, topic, message: text }) =>
          `- ${code(name)}: ${code(cronExpression)} in ${describeTopic(topic)}: ${code(shorten(text.replaceAll(/\s+/g, ' ').trim(), SCHEDULE_ECHO_LENGTH))}`,
      ),
    ].join('\n');
  }

  private async scheduleEdit(context: CommandContext) {
    const { message, options } = context;
    const name = this.oneArgument(context, 'name');
    const { cron, message: text, topic } = options;
    const changed = cron !== undefined || text !== undefined || topic !== undefined;
    if (!name || !changed || cron === '' || text === '' || !isBoolean(options['suppress-embeds'])) {
      return this.usage('schedule-edit');
    }
    const updated = await this.scheduledMessageService.updateScheduledMessage(
      name,
      'zulip',
      { cronExpression: cron, message: text, topic },
      { channelId: String(message.streamId) },
    );
    if (!updated) {
      return notScheduled(name);
    }
    return `Updated scheduled message ${code(name)}: it posts with cron ${code(updated.cronExpression)} in ${describeTopic(updated.topic)} of this stream.${ignoredSuppressEmbeds(options)}`;
  }

  private async scheduleRemove(context: CommandContext) {
    const name = this.oneArgument(context, 'name');
    if (!name) {
      return this.usage('schedule-remove');
    }
    const removed = await this.scheduledMessageService.deleteScheduledMessage(name, 'zulip', {
      channelId: String(context.message.streamId),
    });
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

  private async expanders({ message, args }: CommandContext) {
    const [action, argument] = [args[0]?.toLowerCase(), args[1]];
    const { streamId } = message;
    if (action === 'list' && argument === undefined) {
      return this.expanderList();
    }
    if (action === 'off') {
      return this.expandersOff(streamId, argument?.toLowerCase());
    }
    if (action === 'on' && argument !== undefined) {
      return this.expandersOn(message, argument.toLowerCase());
    }
    if (action === 'default' && argument !== undefined) {
      return this.expandersDefault(message, argument);
    }
    return this.usage('expanders');
  }

  private async expandersOn(message: StreamMessage, name: string) {
    const group = this.zulipExpanders.getGroup(name);
    if (!group) {
      return this.noGroup(name);
    }
    const { streamId } = message;
    const subscriptions = await this.zulip.getSubscriptions();
    const added = await this.zulipExpanders.enable(streamId, name, describeZulipSender(message));
    const scope = this.zulipExpanders.getScope(streamId);
    const reply = added
      ? `Turned on the group ${code(name)} (${group.repositories.map((repository) => code(repository)).join(', ')}) in this stream.`
      : `Nothing changed: the group ${code(name)} was already on in this stream.`;
    const lines = [reply];
    if (scope?.defaultRepository) {
      lines.push(`A bare ${code('#1234')} goes to ${code(scope.defaultRepository)} here.`);
    } else if (scope) {
      lines.push(NO_DEFAULT);
    }
    if (!subscriptions.some((subscription) => subscription.streamId === streamId)) {
      lines.push(NOT_SUBSCRIBED);
    }
    return lines.join('\n');
  }

  private async expandersOff(streamId: number, name?: string) {
    const removed = await this.zulipExpanders.disable(streamId, name);
    if (removed.length === 0) {
      return name === undefined
        ? 'Nothing changed: no group was on in this stream.'
        : `Nothing changed: the group ${code(name)} was not on in this stream.`;
    }
    const groups = removed.map((group) => code(group)).join(', ');
    return this.zulipExpanders.isEnabled(streamId)
      ? `Turned off the group ${groups} in this stream.`
      : `Turned off every group in this stream (${groups}): links still expand here, a bare ${code('#1234')} no longer does.`;
  }

  private async expandersDefault(message: StreamMessage, given: string) {
    const scope = this.zulipExpanders.getScope(message.streamId);
    if (!scope) {
      return `No group is on in this stream; turn one on with ${code('expanders on <group>')} first.`;
    }
    const repository = findRepository(scope.repositories, toRepositoryName(given));
    if (!repository) {
      return `${code(given)} is in none of this stream's groups; the default must be one of ${scope.repositories.map((candidate) => code(candidate)).join(', ')}.`;
    }
    await this.zulipExpanders.setDefault(message.streamId, repository, describeZulipSender(message));
    return `A bare ${code('#1234')} now goes to ${code(repository)} in this stream.`;
  }

  private async expanderList() {
    const streams = this.zulipExpanders.list();
    if (streams.length === 0) {
      return `No group is on in any stream; ${code('expander-group list')} lists the groups.`;
    }
    const labels = await this.describeStreams(streams);
    return [
      'Groups are on in:',
      ...streams.map((streamId, index) => {
        const groupNames = this.zulipExpanders
          .getStreamGroups(streamId)
          .map((group) => code(group))
          .join(', ');
        const scope = this.zulipExpanders.getScope(streamId);
        const target = scope?.defaultRepository
          ? `; ${code('#1234')} goes to ${code(scope.defaultRepository)}`
          : `; a bare ${code('#1234')} goes to no repository`;
        return `- ${labels[index]}: ${groupNames}${target}`;
      }),
    ].join('\n');
  }

  private expanderGroupList() {
    const groups = this.zulipExpanders.getGroups();
    if (groups.length === 0) {
      return `There is no expander group yet; ${code('expander-group create <group> <repository>…')} creates one.`;
    }
    return [
      'Expander groups:',
      ...groups.map((group) => {
        const streams = this.zulipExpanders.getStreams(group.name).length;
        const groupDefault = this.zulipExpanders.getGroupDefault(group);
        const target = groupDefault ? `default ${code(groupDefault)}` : `no default for ${code('#1234')}`;
        return `- ${code(group.name)}: ${countRepositories(this.zulipExpanders.getRepositories(group).length)}, ${target}; on in ${plural(streams, 'stream')}`;
      }),
      '',
      `${code('expander-group info <group>')} shows one in full.`,
    ].join('\n');
  }

  private async expanderGroupInfo(name: string) {
    const group = this.zulipExpanders.getGroup(name);
    if (!group) {
      return this.noGroup(name);
    }
    const streams = this.zulipExpanders.getStreams(name);
    const labels = await this.describeStreams(streams);
    const groupDefault = this.zulipExpanders.getGroupDefault(group);
    const entries = group.repositories.map((entry) =>
      entry === groupDefault
        ? `${code(entry)} (the group's default for ${code('#1234')})`
        : this.describeEntries([entry]),
    );
    const patterns = group.repositories.filter(isPattern).map((entry) => {
      const repositories = this.zulipExpanders.getPatternRepositories(entry);
      if (repositories === undefined) {
        return `- ${code(entry)}: not read yet, so none of its repositories count until the hourly read finds them`;
      }
      const listed = repositories.slice(0, MAX_LISTED_REPOSITORIES).map((repository) => code(repository));
      const more = repositories.length - listed.length;
      return `- ${code(entry)}: ${listed.join(', ') || 'no repository'}${more > 0 ? ` and ${more} more` : ''}`;
    });
    return [
      `Expander group ${code(name)}:`,
      `- Repositories: ${entries.join(', ')}`,
      ...patterns,
      group.threshold > 0
        ? `- A bare ${code('#N')} below ${group.threshold} expands only for a pull request updated in the last two weeks.`
        : `- Every bare ${code('#N')} expands.`,
      streams.length === 0
        ? `- On in no stream; ${code(`expanders on ${name}`)} turns it on in the stream it is given in.`
        : `- On in: ${labels.join(', ')}`,
      `A stream can send a bare ${code('#1234')} elsewhere with ${code('expanders default <repository>')}; ${code('expanders list')} shows where each one goes.`,
    ].join('\n');
  }

  /** A stream by name when it can be read, marked when the bot is not subscribed to it. */
  private async describeStreams(streams: number[]) {
    const [subscriptions, names] = await Promise.all([
      this.zulip.getSubscriptions().catch(() => undefined),
      Promise.all(streams.map((streamId) => this.zulip.getStream(streamId).catch(() => undefined))),
    ]);
    const subscribed = subscriptions && new Set(subscriptions.map(({ streamId }) => streamId));
    return streams.map((streamId, index) => {
      const stream = names[index];
      const name = stream ? `**#${neutraliseZulipMentions(stream.name)}** (${streamId})` : `stream ${streamId}`;
      const warning =
        subscribed && !subscribed.has(streamId) ? ' (⚠ I am not subscribed, so nothing reaches me there)' : '';
      return `${name}${warning}`;
    });
  }

  private async expanderGroup(context: CommandContext) {
    const { message, args } = context;
    const [action, given, ...rest] = args;
    const name = given?.toLowerCase();
    if (action?.toLowerCase() === 'list' && given === undefined) {
      return this.expanderGroupList();
    }
    switch (name === undefined ? undefined : action?.toLowerCase()) {
      case 'info': {
        if (rest.length > 0) {
          break;
        }
        return this.expanderGroupInfo(name);
      }
      case 'create': {
        if (rest.length === 0) {
          break;
        }
        if (!EXPANDER_GROUP_NAME.test(name)) {
          return `${code(given)} cannot name a group: use up to 32 lowercase letters, digits, ${code('-')} and ${code('_')}, starting with a letter or digit.`;
        }
        return this.changeExpanderGroups(context, rest, async () => {
          const repositories = await this.findRepositories(rest);
          if (typeof repositories === 'string') {
            return repositories;
          }
          const created = await this.zulipExpanders.createGroup(name, repositories, describeZulipSender(message));
          const groupDefault = repositories.find((entry) => !isPattern(entry));
          const defaultNote = groupDefault
            ? `${code(groupDefault)} is the default for a bare ${code('#1234')}`
            : `with only patterns it has no default for a bare ${code('#1234')}, which ${code('expanders default <repository>')} picks for a stream`;
          return created
            ? `Created the expander group ${code(name)} with ${this.describeEntries(repositories)}; ${defaultNote}. Turn it on in a stream with ${code(`expanders on ${name}`)}.`
            : `There is already an expander group ${code(name)}; ${code(`expander-group add ${name} <repository>…`)} adds repositories to it.`;
        });
      }
      case 'add': {
        if (rest.length === 0) {
          break;
        }
        if (!this.zulipExpanders.getGroup(name)) {
          return this.noGroup(name);
        }
        return this.changeExpanderGroups(context, rest, async () => {
          const repositories = await this.findRepositories(rest);
          if (typeof repositories === 'string') {
            return repositories;
          }
          const added = await this.zulipExpanders.addRepositories(name, repositories);
          if (added === undefined) {
            return this.noGroup(name);
          }
          return added.length > 0
            ? `Added ${this.describeEntries(added)} to the expander group ${code(name)}.`
            : `Nothing changed: the expander group ${code(name)} already has ${listRepositories(repositories)}.`;
        });
      }
      case 'remove': {
        if (rest.length === 0) {
          break;
        }
        return this.underLock(EXPANDER_GROUP, async () => {
          const repositories = rest.map(toRepositoryName);
          let removed: string[] | undefined;
          try {
            removed = await this.zulipExpanders.removeRepositories(name, repositories);
          } catch (error) {
            if (error instanceof ExpanderGroupEmptyError) {
              return `That would leave the expander group ${code(name)} with no repository; ${code(`expander-group delete ${name}`)} deletes it.`;
            }
            throw error;
          }
          if (removed === undefined) {
            return this.noGroup(name);
          }
          return removed.length > 0
            ? `Removed ${listRepositories(removed)} from the expander group ${code(name)}.`
            : `Nothing changed: the expander group ${code(name)} has none of ${listRepositories(repositories)}.`;
        });
      }
      case 'threshold': {
        const threshold = Number(rest[0]);
        if (rest.length !== 1 || !/^\d+$/.test(rest[0]) || threshold > MAX_THRESHOLD) {
          break;
        }
        return this.underLock(EXPANDER_GROUP, async () => {
          if (!(await this.zulipExpanders.setThreshold(name, threshold))) {
            return this.noGroup(name);
          }
          return threshold === 0
            ? `In the expander group ${code(name)}, every bare ${code('#N')} now expands.`
            : `In the expander group ${code(name)}, a bare ${code('#N')} below ${threshold} now expands only for a pull request updated in the last two weeks.`;
        });
      }
      case 'delete': {
        if (rest.length > 0) {
          break;
        }
        return this.underLock(EXPANDER_GROUP, async () => {
          const streams = this.zulipExpanders.getStreams(name);
          if (!(await this.zulipExpanders.deleteGroup(name))) {
            return this.noGroup(name);
          }
          return streams.length === 0
            ? `Deleted the expander group ${code(name)}.`
            : `Deleted the expander group ${code(name)} and turned it off in ${plural(streams.length, 'stream')}.`;
        });
      }
    }
    return this.usage('expander-group');
  }

  /**
   * Reading a pattern pages through every repository of its owner, which can outlast the loop's wait, so a change that
   * adds one runs in the background; every change of the groups takes the same lock, so none runs while one is.
   */
  private changeExpanderGroups(context: CommandContext, given: string[], change: () => Promise<string>) {
    const patterns = given.map(toRepositoryName).filter(isPattern);
    return patterns.length === 0
      ? this.underLock(EXPANDER_GROUP, change)
      : this.inBackground(EXPANDER_GROUP, context, {
          ack: `Reading the repositories of ${listRepositories(patterns)}, this can take a while…`,
          work: change,
        });
  }

  /** The names as GitHub and GitLab spell them, or the reply naming the ones they do not know. */
  private async findRepositories(given: string[]): Promise<string[] | string> {
    const wanted = given.map(toRepositoryName);
    const malformed = wanted.filter((repository) => !isWellFormed(repository));
    if (malformed.length > 0) {
      return `${listRepositories(malformed)} ${malformed.length === 1 ? 'is' : 'are'} not ${REPOSITORY_FORMS}.`;
    }
    const found = await Promise.all(
      wanted.map(async (repository) => {
        if (isPattern(repository)) {
          return (await this.zulipExpanders.readPattern(repository))?.entry;
        }
        if (!isGitlabRepository(repository)) {
          return this.githubService.getRepositoryName(repository);
        }
        const path = await this.gitlab.getProjectPath(gitlabPath(repository));
        return path && `${Constants.Gitlab.Host}/${path}`;
      }),
    );
    const unknown = wanted.filter((_, index) => found[index] === undefined);
    if (unknown.length > 0) {
      return `There is no repository ${listRepositories(unknown)}, or I cannot see it.`;
    }
    const repositories: string[] = [];
    for (const repository of found as string[]) {
      if (!repositories.some((candidate) => sameRepository(candidate, repository))) {
        repositories.push(repository);
      }
    }
    return repositories;
  }

  /** A pattern with how many repositories it stands for. */
  private describeEntries(entries: string[]) {
    return entries
      .map((entry) => {
        const repositories = isPattern(entry) ? this.zulipExpanders.getPatternRepositories(entry) : undefined;
        return repositories === undefined ? code(entry) : `${code(entry)} (${countRepositories(repositories.length)})`;
      })
      .join(', ');
  }

  private noGroup(name: string) {
    const groups = this.zulipExpanders.getGroups();
    return groups.length === 0
      ? `There is no expander group ${code(name)}; ${code('expander-group create <group> <repository>…')} creates one.`
      : `There is no expander group ${code(name)}; the groups are ${groups.map((group) => code(group.name)).join(', ')}.`;
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
