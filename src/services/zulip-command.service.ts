import { Inject, Injectable, Logger } from '@nestjs/common';
import { Constants, ZulipHelpSection } from 'src/constants';
import {
  ZULIP_MAX_MESSAGE_LENGTH,
  neutraliseZulipLabel,
  neutraliseZulipMentions,
  plural,
  shorten,
  shortenCodePoints,
} from 'src/format';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { IGitlabInterface } from 'src/interfaces/gitlab.interface';
import { IZulipInterface, ZulipAccount, ZulipReceivedMessage, ZulipUser } from 'src/interfaces/zulip.interface';
import { topicKey } from 'src/mirror/names';
import { ZulipCommandBot } from 'src/schema';
import { ChatService, formatEmoteSyncReport } from 'src/services/chat.service';
import { GithubService } from 'src/services/github.service';
import { MirrorActor, MirrorLinkReply, MirrorLinkService } from 'src/services/mirror-link.service';
import { RSSService } from 'src/services/rss.service';
import { ScheduledMessageService } from 'src/services/scheduled-message.service';
import { BackfillPlatforms, WebhookService, formatBackfillReport } from 'src/services/webhook.service';
import {
  ExpanderGroupEmptyError,
  ExpanderPlace,
  ZulipExpanderService,
  gitlabPath,
  isGitlabRepository,
  isPattern,
  sameRepository,
  toConversationKey,
} from 'src/services/zulip-expander.service';
import { ZulipService, isBotSender, isZulipBot } from 'src/services/zulip.service';
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

const REPOSITORY_NAME = /^[\w.-]+\/[\w.-]+$/;

const GITLAB_PROJECT_NAME = /^[\w.-]+(\/[\w.-]+)+$/;

const GITHUB_OWNER_NAME = /^[\w.-]+$/;

const GITLAB_GROUP_NAME = /^[\w.-]+(\/[\w.-]+)*$/;

/** `info` names this many repositories of a pattern, and counts the rest. */
const MAX_LISTED_REPOSITORIES = 30;

const EXPANDER_GROUP = 'expander-group';

const COMMAND_BOTS = 'command-bots';

const STICKERS = 'sticker-*';

/** An emoji name, which is what a sticker answers to. */
const STICKER_NAME = /^[\w+-]+$/;

/**
 * The whole image argument as a file attached to the message, which Zulip links as `![file](/user_uploads/…)` for an
 * image or audio file and as `[file](/user_uploads/…)` for any other, or a bare `/user_uploads/…` path; nothing before
 * or after it, and nothing in the path that `isStickerUrl` refuses.
 */
const STICKER_UPLOAD = /^(?:(!?)\[[^\]]*\]\((\/user_uploads\/[^\s()*[\]`<>]+)\)|(\/user_uploads\/[^\s()*[\]`<>]+))$/;

/** The uploads `![…](…)` shows full size; for a video or a document, Zulip posts it as text. */
const IMAGE_UPLOAD = /\.(?:avif|gif|jpe?g|png|webp)$/i;

/**
 * An absolute http(s) URL (`new URL` refuses one without a host). It is posted as given, so it may hold no `*`, which
 * mentions, nor whitespace, `[`, `]`, `` ` ``, `<` or `>`: no URL holds them unencoded outside an IPv6 host, and Zulip
 * renders them.
 */
const isStickerUrl = (value: string) => {
  if (/[\s*[\]`<>]/.test(value)) {
    return false;
  }
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

const STICKER_SUMMARY = 'answer an emoji with an image, in every stream';

const CHANGE_STICKERS = 'change the stickers';

/** `@**Name**` or the silent `@_**Name**`, with Zulip's `|user_id` suffix when the name is not enough. */
const USER_MENTION = /^@_?\*\*(.+?)(?:\|(\d+))?\*\*$/;

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
const describeZulipSender = (message: ZulipReceivedMessage) =>
  `${message.senderFullName} on Zulip (user ${message.senderId})`;

/** The user a mention with its ID, or a bare ID, names; anything else is a name or an email to look up. */
const toUserId = (given: string) => {
  const id = USER_MENTION.exec(given)?.[2] ?? (/^\d+$/.test(given) ? given : undefined);
  return id === undefined ? undefined : Number(id);
};

const findUsers = (users: ZulipAccount[], given: string) => {
  const userId = toUserId(given);
  if (userId !== undefined) {
    return users.filter((user) => user.userId === userId);
  }
  const name = (USER_MENTION.exec(given)?.[1] ?? given).toLowerCase();
  return users.filter((user) => user.email.toLowerCase() === name || user.fullName.toLowerCase() === name);
};

const describeUser = ({ userId, fullName }: ZulipUser) => `${code(fullName)} (user ${userId})`;

const countRepositories = (count: number) => `${count} ${count === 1 ? 'repository' : 'repositories'}`;

const listRepositories = (repositories: string[]) => repositories.map((repository) => code(repository)).join(', ');

const INSTALLATION_OWNERS = [...Constants.Github.InstallationOwners].map((owner) => `\`${owner}\``).join(' or ');

const bareNumbers = (kind: ExpanderTarget['kind']) =>
  `A bare \`#1234\` goes to the repository of the ${kind}'s groups whose pull request, issue or discussion of that number I have seen activity on last, which only a GitHub repository of ${INSTALLATION_OWNERS} can be; a GitLab project or another repository needs \`name#1234\` or a link.`;

const PREFIXES = `\`!1234\` asks for a pull request (a merge request on GitLab) and \`^1234\` for an issue, bare or after a name (\`immich!1234\`), where \`#1234\` takes any kind; \`owner/name!1234\` and \`owner/name^1234\` outside the groups work for ${INSTALLATION_OWNERS} only.`;

const NOT_SUBSCRIBED =
  '⚠ I am not subscribed to this stream, so none of its messages reach me and nothing is expanded here until an administrator subscribes me.';

const EMOTE_SYNC_SERVER = `the ${Constants.Discord.EmoteSyncServer.name} Discord server (${Constants.Discord.EmoteSyncServer.id})`;

/** Whitespace is collapsed because a newline in typed text would let it add Markdown structure in the bot's own voice. */
const code = (text: string) => `\`${neutraliseZulipMentions(text.replaceAll('`', '').replaceAll(/\s+/g, ' '))}\``;

const helpLine = (names: string[], summary: string) => `- ${names.map((name) => code(name)).join(', ')}: ${summary}`;

const helpSection = (heading: string, lines: string[]) => [`**${heading}**`, ...lines].join('\n');

const spoiler = (heading: string, lines: string[]) => [`\`\`\`spoiler ${heading}`, ...lines, '```'].join('\n');

const toHelpLines = (entries: { name: string; summary: string }[]) => {
  const groups: { names: string[]; summary: string }[] = [];
  for (const { name, summary } of entries) {
    const last = groups.at(-1);
    if (last?.summary === summary) {
      last.names.push(name);
      continue;
    }
    groups.push({ names: [name], summary });
  }
  return groups.map(({ names, summary }) => helpLine(names, summary));
};

const SCHEDULE_SUMMARY = 'post messages in this stream on a cron schedule';

const RSS_SUMMARY = 'post RSS feeds in this stream';

const MIRROR_LINK_SUMMARY = 'mirror this stream with a Discord channel, both ways, or stop';

const LEFT_OUT_TEAM = 'the commands taken in the Immich team streams only';

const LEFT_OUT_ADMINISTRATORS = 'the commands for organization administrators and owners';

const HELP_FINE_PRINT = spoiler('How it works', [
  '- Mention me at the very start of a message; a mention anywhere else is not a command.',
  '- Arguments are positional or `key=value`; quote a value with spaces: `text="two words"`.',
  '- Every reply is posted here, in this topic, for everyone in the stream to see.',
  '- Scheduled messages, RSS feeds and `expanders` act on this stream alone; expander groups are shared by every stream.',
  '- The team tools are taken in the Immich team streams only, the `mirror-*` and `command-bots` commands from organization administrators and owners only.',
]);

const DIRECT_MESSAGE_HELP = [
  '**In a direct message**, send me one of these; in a group conversation, mention me first.',
  helpSection(ZulipHelpSection.Links, [
    helpLine(['expanders'], 'choose the groups of repositories a bare `#1234` looks in, in this conversation'),
  ]),
  helpSection(ZulipHelpSection.Mirror, [
    helpLine(['link <code>'], 'link your Zulip account with the Discord account `/zulip-link` gave you the code on'),
    helpLine(['unlink'], 'unlink your Zulip account from your Discord account'),
  ]),
  helpSection(ZulipHelpSection.Stickers, [
    helpLine(['sticker-add <name> <image>', 'sticker-remove <name>', 'sticker-list'], STICKER_SUMMARY),
  ]),
  spoiler('How it works', [
    '- `expanders on <group>`, `expanders off [group]` and `expanders list` work as in a stream; `expander-group list`, in a stream, lists the groups.',
    '- `sticker-add` takes an image URL or a file attached to the message, as in a stream.',
    `- ${bareNumbers('conversation')}`,
    `- ${PREFIXES}`,
    '- Links expand here without a group, unless a guest is in the conversation.',
    '- Everyone in the conversation sees what `expanders` changes; anything else is answered to you alone.',
  ]),
].join('\n\n');

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

type CommandContext<Message = StreamMessage> = Arguments & { message: Message };

/** Where `expanders` turns groups on and off, and what its answers call that place. */
type ExpanderTarget = { place: ExpanderPlace; kind: 'stream' | 'conversation' };

type Command = {
  usage: string;
  description: string;
  /** Each form of the command and what it does, one line each in `help <command>`. */
  subcommands?: Record<string, string>;
  example?: string;
  /** Where `help` lists it; consecutive commands of a section with the same summary share a line. */
  listing: { section: ZulipHelpSection; summary: string } | null;
  positionals: number;
  options: string[];
  /** Taken from organization administrators and owners only; what they alone can do, for the refusal. */
  administrators?: string;
  /** Refused to guests, since it acts in streams they may not see; what they cannot do, for the refusal. */
  guestsCannot?: string;
  /** Taken in the team streams only: it acts on more than the stream it is given in. */
  teamStreams?: boolean;
} & (
  | { directMessages?: false; run: (context: CommandContext) => Promise<string | undefined> }
  | {
      /** Taken in a direct message too, with the same arguments, and answered to the sender alone. */
      directMessages: true;
      run: (context: CommandContext<ZulipReceivedMessage>) => Promise<string>;
    }
);

type BackgroundJob = { ack: string; work: () => Promise<string> };

@Injectable()
export class ZulipCommandService {
  private logger = new Logger(ZulipCommandService.name);
  private running = new Set<string>();
  private warnedNoName = false;
  private listedBots = new Map<number, ZulipCommandBot>();

  private commands: Record<string, Command> = {
    help: {
      usage: 'help [command]',
      description: 'List the commands taken here, or explain the one named.',
      example: 'help schedule-add',
      listing: null,
      positionals: 1,
      options: [],
      run: (context) => this.help(context),
    },
    'emote-sync': {
      usage: 'emote-sync',
      description: `Upload every emote of ${EMOTE_SYNC_SERVER} to Zulip, skipping a name Zulip already has.`,
      listing: {
        section: ZulipHelpSection.Team,
        summary: `upload the emotes of the ${Constants.Discord.EmoteSyncServer.name} Discord server to Zulip`,
      },
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
        'Create the Discord team thread and the Zulip topic that open pull request lacks, or with `all` for every open one; one that has both, was opened by a bot, or is not in the database is skipped, and nothing that exists is touched.',
      example: 'backfill-pull-requests 1234',
      listing: {
        section: ZulipHelpSection.Team,
        summary: 'create the Discord thread and the Zulip topic a pull request lacks',
      },
      positionals: 1,
      options: ['number'],
      teamStreams: true,
      run: (context) => this.backfillPullRequests(context),
    },
    fourthwall: {
      usage: 'fourthwall update <id|all>',
      description: 'Fetch that Fourthwall order again and update its row in the database, or with `all` every order.',
      example: 'fourthwall update ORD-1',
      listing: { section: ZulipHelpSection.Team, summary: 'fetch a Fourthwall order again, or every order' },
      positionals: 2,
      options: ['id'],
      teamStreams: true,
      run: (context) => this.fourthwall(context),
    },
    'schedule-add': {
      usage: 'schedule-add <name> cron=<expression> message=<text> [topic=<topic>] [suppress-embeds=<true|false>]',
      description: `Post the message in this stream on that cron schedule, in the topic given or this one; ${SUPPRESS_EMBEDS_IGNORED}.`,
      example: 'schedule-add standup cron="0 9 * * 1-5" message="Standup in five minutes" topic=standup',
      listing: { section: ZulipHelpSection.Schedule, summary: SCHEDULE_SUMMARY },
      positionals: 1,
      options: ['name', 'cron', 'message', 'topic', 'suppress-embeds'],
      run: (context) => this.scheduleAdd(context),
    },
    'schedule-list': {
      usage: 'schedule-list',
      description:
        'List the scheduled messages of this stream, with their schedule, topic and the start of their text.',
      listing: { section: ZulipHelpSection.Schedule, summary: SCHEDULE_SUMMARY },
      positionals: 0,
      options: [],
      run: (context) => this.scheduleList(context),
    },
    'schedule-edit': {
      usage: 'schedule-edit <name> [cron=<expression>] [message=<text>] [topic=<topic>] [suppress-embeds=<true|false>]',
      description: `Change the schedule, text or topic of a scheduled message of this stream, from its next post on; ${SUPPRESS_EMBEDS_IGNORED}.`,
      example: 'schedule-edit standup cron="30 9 * * 1-5"',
      listing: { section: ZulipHelpSection.Schedule, summary: SCHEDULE_SUMMARY },
      positionals: 1,
      options: ['name', 'cron', 'message', 'topic', 'suppress-embeds'],
      run: (context) => this.scheduleEdit(context),
    },
    'schedule-remove': {
      usage: 'schedule-remove <name>',
      description: 'Delete a scheduled message of this stream, which stops it.',
      listing: { section: ZulipHelpSection.Schedule, summary: SCHEDULE_SUMMARY },
      positionals: 1,
      options: ['name'],
      run: (context) => this.scheduleRemove(context),
    },
    'rss-subscribe': {
      usage: 'rss-subscribe <url> [topic=<topic>]',
      description:
        'Post the newest post of that RSS feed now, and every new one after it (checked every 15 minutes), in this stream, in the topic given or this one.',
      example: 'rss-subscribe https://example.com/feed.xml topic=news',
      listing: { section: ZulipHelpSection.Rss, summary: RSS_SUMMARY },
      positionals: 1,
      options: ['url', 'topic'],
      run: (context) => this.rssSubscribe(context),
    },
    'rss-unsubscribe': {
      usage: 'rss-unsubscribe <url>',
      description: 'Stop posting that RSS feed in this stream.',
      listing: { section: ZulipHelpSection.Rss, summary: RSS_SUMMARY },
      positionals: 1,
      options: ['url'],
      run: (context) => this.rssUnsubscribe(context),
    },
    'rss-list': {
      usage: 'rss-list',
      description: 'List the RSS feeds this stream is subscribed to, with their topics.',
      listing: { section: ZulipHelpSection.Rss, summary: RSS_SUMMARY },
      positionals: 0,
      options: [],
      run: ({ message }) => this.rssList(message),
    },
    'mirror-link': {
      usage: 'mirror-link [topic=<main topic>]',
      description:
        "Start mirroring this stream with a Discord text channel or forum, both ways: this answers with the `/mirror-link` command a Discord administrator then runs in that channel; the main topic (text channels only, general chat by default) holds the channel's own messages.",
      example: 'mirror-link topic="dev chat"',
      listing: { section: ZulipHelpSection.Mirror, summary: MIRROR_LINK_SUMMARY },
      positionals: 0,
      options: ['topic'],
      administrators: MIRROR,
      run: (context) => this.mirrorLink(context),
    },
    'mirror-unlink': {
      usage: 'mirror-unlink',
      description: 'Stop mirroring this stream with its Discord channel, and announce it on both sides.',
      listing: { section: ZulipHelpSection.Mirror, summary: MIRROR_LINK_SUMMARY },
      positionals: 0,
      options: [],
      administrators: MIRROR,
      run: ({ message }) => this.mirrorUnlink(message),
    },
    'mirror-backfill': {
      usage: 'mirror-backfill',
      description:
        'Copy the messages of the Discord channel or thread this topic mirrors that are not here yet into this topic, oldest first, between two notices; new Discord messages there wait until it is done.',
      listing: {
        section: ZulipHelpSection.Mirror,
        summary: 'copy the Discord history of the channel or thread this topic mirrors',
      },
      positionals: 0,
      options: [],
      administrators: MIRROR,
      run: ({ message }) => this.mirrorBackfill(message),
    },
    'mirror-list': {
      usage: 'mirror-list',
      description: 'List the mirrored channels and streams, and the linked accounts.',
      listing: { section: ZulipHelpSection.Mirror, summary: 'list the mirrored channels and the linked accounts' },
      positionals: 0,
      options: [],
      administrators: MIRROR,
      run: () => this.mirrorLinks.list('zulip'),
    },
    expanders: {
      usage: 'expanders <on <group>|off [group]|list>',
      description: `Choose the groups of repositories a bare \`#1234\` and \`name#1234\` look among in this stream. ${bareNumbers('stream')} ${PREFIXES} GitHub and \`${Constants.Gitlab.Host}\` issue, pull request, merge request and discussion links, file permalinks and \`owner/name#1234\` expand in every subscribed stream, with or without a group, and \`x.com\` links are mirrored on \`nitter.net\`.`,
      subcommands: {
        'on <group>': 'turn that group on here',
        'off [group]': 'turn that group off here, or every group when none is named',
        list: 'list the streams with groups',
      },
      example: 'expanders on immich',
      listing: {
        section: ZulipHelpSection.Links,
        summary: 'choose the groups of repositories a bare `#1234` looks in, in this stream',
      },
      positionals: 2,
      options: [],
      run: (context) => this.expanders(context),
    },
    'expander-group': {
      usage: 'expander-group <create|add|remove> <group> <repository>… | delete <group> | info <group> | list',
      description: `Create and change the groups of repositories \`expanders on\` turns on. A repository is ${REPOSITORY_FORMS}; URLs work too. ${bareNumbers('stream')}`,
      subcommands: {
        'create <group> <repository>…': 'create a group of those repositories',
        'add <group> <repository>…': 'add those repositories to the group',
        'remove <group> <repository>…': 'remove those repositories from the group',
        'delete <group>': 'delete the group, which turns it off everywhere',
        'info <group>': "show the group's repositories and streams",
        list: 'list every group',
      },
      example: 'expander-group create fhs futo-org/fhs-core futo-org/fhs-web',
      listing: {
        section: ZulipHelpSection.Links,
        summary: 'create and change the groups of repositories `expanders` turns on',
      },
      positionals: Number.POSITIVE_INFINITY,
      options: [],
      run: (context) => this.expanderGroup(context),
    },
    'discord-unlink': {
      usage: 'discord-unlink',
      description:
        'Unlink your Zulip account from your Discord account, so that your messages appear on Discord as "Name (Zulip)".',
      listing: {
        section: ZulipHelpSection.Mirror,
        summary: 'unlink your Zulip and Discord accounts; `/zulip-link` on Discord links them',
      },
      positionals: 0,
      options: [],
      run: ({ message }) => this.mirrorLinks.unlinkIdentity({ zulipUserId: message.senderId }, 'zulip'),
    },
    similar: {
      usage: 'similar [text]',
      description:
        'List the immich-app/immich issues and discussions like the text, or without text like the last message a human wrote in this topic, looked for among its ten newest.',
      example: 'similar uploads fail behind nginx',
      listing: {
        section: ZulipHelpSection.Links,
        summary: 'find immich-app/immich issues and discussions like a message',
      },
      positionals: Number.POSITIVE_INFINITY,
      options: ['text'],
      run: (context) => this.similar(context),
    },
    'sticker-add': {
      usage: 'sticker-add <name> <image URL or attached upload>',
      description:
        'Answer every message that uses the emoji `:name:`, in any stream I can see, with that image, replacing the image of a sticker of that name. An attached image is shown full size, a URL as a link preview.',
      example: 'sticker-add this-is-fine https://media.giphy.com/media/QMHoU66sBXqqLqYvGO/giphy.gif',
      listing: { section: ZulipHelpSection.Stickers, summary: STICKER_SUMMARY },
      positionals: Number.POSITIVE_INFINITY,
      options: [],
      guestsCannot: CHANGE_STICKERS,
      directMessages: true,
      run: (context) => this.stickerAdd(context),
    },
    'sticker-remove': {
      usage: 'sticker-remove <name>',
      description: 'Stop answering the emoji `:name:` with an image.',
      listing: { section: ZulipHelpSection.Stickers, summary: STICKER_SUMMARY },
      positionals: 1,
      options: [],
      guestsCannot: CHANGE_STICKERS,
      directMessages: true,
      run: (context) => this.stickerRemove(context),
    },
    'sticker-list': {
      usage: 'sticker-list',
      description: 'List the stickers, with their images.',
      listing: { section: ZulipHelpSection.Stickers, summary: STICKER_SUMMARY },
      positionals: 0,
      options: [],
      directMessages: true,
      run: () => this.stickerList(),
    },
    'command-bots': {
      usage: 'command-bots <add|remove> <bot> | list',
      description:
        "Choose the other bots whose commands I take, in every stream, with their role checked as anyone's; every other bot's are ignored, and people's are always taken. A bot is named by its mention, its email, its name or its user ID.",
      subcommands: {
        'add <bot>': 'take the commands of that bot',
        'remove <bot>': 'stop taking the commands of that bot',
        list: 'list the bots whose commands I take',
      },
      example: 'command-bots add Claude',
      listing: { section: ZulipHelpSection.Bots, summary: 'choose the other bots whose commands I take' },
      positionals: Number.POSITIVE_INFINITY,
      options: [],
      administrators: 'choose the bots whose commands I take',
      run: (context) => this.commandBots(context),
    },
  };

  constructor(
    @Inject(IZulipInterface) private zulip: IZulipInterface,
    @Inject(IGitlabInterface) private gitlab: IGitlabInterface,
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
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
    await this.loadCommandBots();
    this.zulipService.onMessage((message) => this.onZulipMessage(message), { withBots: true });
  }

  private async loadCommandBots() {
    const bots = await this.database.getZulipCommandBots();
    this.listedBots = new Map(bots.map((bot) => [bot.userId, bot]));
  }

  /**
   * Stream membership is the authorisation, so a team command outside the team streams is not run; the mirror commands,
   * whose stream is usually not a team one, check the sender's role instead. Another bot's commands are taken only
   * once an administrator has listed it with `command-bots`, and never in a direct message.
   */
  async onZulipMessage(message: ZulipReceivedMessage) {
    const { streamId } = message;
    const bot = isZulipBot(message.senderEmail);
    if (message.type === 'private') {
      if (!bot) {
        await this.onDirectMessage(message);
      }
      return;
    }
    // Zulip's Notification Bot starts its notices with a mention of whoever acted, this bot included.
    if (streamId === undefined || (bot && !this.listedBots.has(message.senderId))) {
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
      return this.listCommands(message);
    }
    const command = this.commands[name];
    if (!command) {
      return `Unknown command ${code(shorten(name, ECHO_LENGTH))}. Mention me with ${code('help')} for the list.`;
    }
    return this.runCommand(name, message, tokens, (args) => command.run({ message, ...args }));
  }

  /** Checks the arguments and the sender, then runs the command; a failure is answered, never thrown. */
  private async runCommand<Reply extends string | undefined>(
    name: string,
    message: ZulipReceivedMessage,
    tokens: string[],
    run: (args: Arguments) => Promise<Reply>,
  ): Promise<Reply | string> {
    const command = this.commands[name];
    // With no autocomplete, an argument the command does not take must be answered, never dropped: a typo in `number=` would otherwise backfill every PR.
    const args = splitArguments(tokens, command.options);
    if (args.args.length > command.positionals) {
      return this.usage(name);
    }
    try {
      if (command.administrators && !(await this.isAdministrator(message.senderId))) {
        return `Only Zulip organization administrators and owners can ${command.administrators}.`;
      }
      const refusal = command.guestsCannot && (await this.refuseGuests(name, message.senderId, command.guestsCannot));
      if (refusal) {
        return refusal;
      }
      return await run(args);
    } catch (error) {
      this.logger.error(`The Zulip command ${name} failed on message ${message.id}`, error);
      return `${code(name)} failed: ${describeError(error)}`;
    }
  }

  /** Fails closed: a sender whose role cannot be read is refused too. */
  private async refuseGuests(name: string, userId: number, action: string) {
    try {
      return (await this.zulipService.isGuest(userId)) ? `Guests cannot ${action}.` : undefined;
    } catch (error) {
      this.logger.debug(`Could not read the role of Zulip user ${userId} for ${name}`, error);
      return `Could not read your Zulip role, and guests cannot ${action}; try again later.`;
    }
  }

  /**
   * Only `help`, `expanders`, `link <code>`, `unlink` and the `directMessages` commands are taken in a direct message, so
   * that nothing else said to the bot, in a group conversation too, gets an answer. The answer goes to the sender alone.
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
    const tableCommand = this.commands[command];
    const conversation = message.recipientIds ?? [message.senderId];
    let run: (() => Promise<string>) | undefined;
    let recipients = [message.senderId];
    // A mention alone is `help`, as in a stream.
    if (command === 'help' || (parsed.status === 'ok' && command === '')) {
      run = () => Promise.resolve(DIRECT_MESSAGE_HELP);
    } else if (command === 'expanders') {
      run = () => this.runExpanders(message, args, { place: toConversationKey(conversation), kind: 'conversation' });
      // Everyone in the conversation is told how its expansion changed.
      recipients = conversation.filter((userId) => userId !== this.zulipService.ownUser?.userId);
    } else if ((command === 'link' || command === 'discord-link') && args.length === 1) {
      run = () =>
        this.mirrorLinks.redeemIdentityCode({ id: message.senderId, fullName: message.senderFullName }, args[0]);
    } else if ((command === 'unlink' || command === 'discord-unlink') && args.length === 0) {
      run = () => this.mirrorLinks.unlinkIdentity({ zulipUserId: message.senderId }, 'zulip');
    } else if (tableCommand?.directMessages) {
      run = () => this.runCommand(command, message, args, (context) => tableCommand.run({ message, ...context }));
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
      await this.zulip.sendDirectMessage(recipients, fit(reply));
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

  private help({ message, args: [given] }: CommandContext) {
    return given ? Promise.resolve(this.describeCommand(given)) : this.listCommands(message);
  }

  /** What the sender can run here; a role that cannot be read hides the administrators' commands. */
  private async listCommands(message: StreamMessage) {
    const teamStream = Constants.Zulip.Commands.includes(message.streamId);
    const administrator = await this.isAdministrator(message.senderId).catch((error) => {
      this.logger.debug(`Could not read the role of Zulip user ${message.senderId} for help`, error);
      return false;
    });
    const shown = Object.entries(this.commands).filter(
      ([, { teamStreams, administrators }]) => (teamStream || !teamStreams) && (administrator || !administrators),
    );
    const sections = Object.values(ZulipHelpSection).flatMap((section) => {
      const entries = shown.flatMap(([name, { listing }]) =>
        listing?.section === section ? [{ name, summary: listing.summary }] : [],
      );
      return entries.length > 0 ? [helpSection(section, toHelpLines(entries))] : [];
    });
    const leftOut = [...(teamStream ? [] : [LEFT_OUT_TEAM]), ...(administrator ? [] : [LEFT_OUT_ADMINISTRATORS])];
    const botName = neutraliseZulipMentions(this.zulipService.ownUser?.fullName ?? '');
    return [
      `**${botName}**: mention me, then a command. ${code('help <command>')} explains one.`,
      ...sections,
      ...(leftOut.length > 0 ? [`*Left out here: ${leftOut.join(' and ')}.*`] : []),
      HELP_FINE_PRINT,
    ].join('\n\n');
  }

  private describeCommand(given: string) {
    const name = given.toLowerCase();
    if (!Object.hasOwn(this.commands, name)) {
      return `There is no command ${code(shorten(given, ECHO_LENGTH))}; ${code('help')} lists them.`;
    }

    const command = this.commands[name];
    const { usage, description, subcommands = {}, options, example } = command;
    const where = command.teamStreams
      ? 'in the Immich team streams only'
      : command.directMessages
        ? 'in any stream and in a direct message'
        : 'in any stream';
    const from = command.administrators
      ? ', from organization administrators and owners only'
      : command.guestsCannot
        ? ', from anyone but guests'
        : '';
    return [
      code(usage),
      description,
      ...Object.entries(subcommands).map(([form, summary]) => helpLine([form], summary)),
      `- Taken ${where}${from}.`,
      ...(options.length > 0 ? [`- Options: ${options.map((key) => code(`${key}=`)).join(', ')}`] : []),
      ...(example ? [`- Example: ${code(example)}`] : []),
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

  private expanders({ message, args }: CommandContext) {
    return this.runExpanders(message, args, { place: message.streamId, kind: 'stream' });
  }

  private async runExpanders(message: ZulipReceivedMessage, args: string[], target: ExpanderTarget) {
    // A direct message reaches here without the check `answer` makes for a stream.
    if (args.length > this.commands.expanders.positionals) {
      return this.usage('expanders');
    }
    const [action, argument] = [args[0]?.toLowerCase(), args[1]];
    if (action === 'list' && argument === undefined) {
      return this.expanderList();
    }
    if (action === 'off') {
      return this.expandersOff(target, argument?.toLowerCase());
    }
    if (action === 'on' && argument !== undefined) {
      return this.expandersOn(message, target, argument.toLowerCase());
    }
    return this.usage('expanders');
  }

  private async expandersOn(message: ZulipReceivedMessage, { place, kind }: ExpanderTarget, name: string) {
    const group = this.zulipExpanders.getGroup(name);
    if (!group) {
      return this.noGroup(name);
    }
    const subscriptions = typeof place === 'number' ? await this.zulip.getSubscriptions() : undefined;
    const added = await this.zulipExpanders.enable(place, name, describeZulipSender(message));
    const reply = added
      ? `Turned on the group ${code(name)} (${group.repositories.map((repository) => code(repository)).join(', ')}) in this ${kind}.`
      : `Nothing changed: the group ${code(name)} was already on in this ${kind}.`;
    const lines = [reply];
    if (subscriptions && !subscriptions.some((subscription) => subscription.streamId === place)) {
      lines.push(NOT_SUBSCRIBED);
    }
    return lines.join('\n');
  }

  private async expandersOff({ place, kind }: ExpanderTarget, name?: string) {
    const removed = await this.zulipExpanders.disable(place, name);
    if (removed.length === 0) {
      return name === undefined
        ? `Nothing changed: no group was on in this ${kind}.`
        : `Nothing changed: the group ${code(name)} was not on in this ${kind}.`;
    }
    const groups = removed.map((group) => code(group)).join(', ');
    return this.zulipExpanders.isEnabled(place)
      ? `Turned off the group ${groups} in this ${kind}.`
      : `Turned off every group in this ${kind} (${groups}): links still expand here, a bare ${code('#1234')} no longer does.`;
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
          .getPlaceGroups(streamId)
          .map((group) => code(group))
          .join(', ');
        return `- ${labels[index]}: ${groupNames}`;
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
        return `- ${code(group.name)}: ${countRepositories(this.zulipExpanders.getRepositories(group).length)}; on in ${plural(streams, 'stream')}`;
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
      `- Repositories: ${this.describeEntries(group.repositories)}`,
      ...patterns,
      streams.length === 0
        ? `- On in no stream; ${code(`expanders on ${name}`)} turns it on in the stream it is given in.`
        : `- On in: ${labels.join(', ')}`,
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
          return created
            ? `Created the expander group ${code(name)} with ${this.describeEntries(repositories)}. Turn it on in a stream with ${code(`expanders on ${name}`)}.`
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

  private async commandBots({ message, args }: CommandContext) {
    const [action, ...rest] = args;
    // The tokenizer splits a mention of a name with spaces, `@**Claude Code**`, in two.
    const given = rest.join(' ');
    switch (action?.toLowerCase()) {
      case 'list': {
        if (rest.length > 0) {
          break;
        }
        return this.listCommandBots();
      }
      case 'add': {
        if (!given) {
          break;
        }
        return this.underLock(COMMAND_BOTS, () => this.addCommandBot(message, given));
      }
      case 'remove': {
        if (!given) {
          break;
        }
        return this.underLock(COMMAND_BOTS, () => this.removeCommandBot(given));
      }
    }
    return this.usage(COMMAND_BOTS);
  }

  /** The one user `given` names, or the reply saying why there is none. */
  private async findUser(given: string): Promise<ZulipAccount | string> {
    const found = findUsers(await this.zulip.getUsers(), given);
    if (found.length === 0) {
      return `There is no user ${code(shorten(given, ECHO_LENGTH))} in this organization; Zulip's own bots, such as the Notification Bot, are not in it and cannot be added.`;
    }
    if (found.length > 1) {
      return [
        `${code(shorten(given, ECHO_LENGTH))} names several users; name the bot by its user ID:`,
        ...found.map((user) => `- ${describeUser(user)}`),
      ].join('\n');
    }
    return found[0];
  }

  private async addCommandBot(message: StreamMessage, given: string) {
    const user = await this.findUser(given);
    if (typeof user === 'string') {
      return user;
    }
    if (user.userId === this.zulipService.ownUser?.userId) {
      return `${describeUser(user)} is me: my own messages are never commands.`;
    }
    if (!isZulipBot(user.email)) {
      return `${describeUser(user)} is a person, not a bot: people's commands are always taken; only bots are added.`;
    }
    const added = await this.database.addZulipCommandBot(user.userId, describeZulipSender(message));
    if (!added) {
      // The row can predate the cache: an insert whose answer was lost, or one made by hand.
      await this.loadCommandBots();
      return `Nothing changed: I already take the commands of ${describeUser(user)}.`;
    }
    this.listedBots.set(added.userId, added);
    return `I now take the commands of ${describeUser(user)}, with its role checked as anyone's.`;
  }

  /** A bot named by its ID needs no lookup, so it can be removed while Zulip cannot list the users, or no longer lists it. */
  private async removeCommandBot(given: string) {
    const bot = toUserId(given) ?? (await this.findUser(given));
    if (typeof bot === 'string') {
      return bot;
    }
    const [userId, name] = typeof bot === 'number' ? [bot, `user ${bot}`] : [bot.userId, describeUser(bot)];
    const removed = await this.database.removeZulipCommandBot(userId);
    this.listedBots.delete(userId);
    return removed
      ? `I no longer take the commands of ${name}.`
      : `Nothing changed: I did not take the commands of ${name}; ${code('command-bots list')} lists the bots I do.`;
  }

  private async listCommandBots() {
    const bots = [...this.listedBots.values()];
    if (bots.length === 0) {
      return `I take the commands of no other bot; ${code('command-bots add <bot>')} adds one.`;
    }
    const users = await this.zulip.getUsers().catch(() => []);
    const named = new Map(users.map((user) => [user.userId, user]));
    return [
      'I take the commands of these bots:',
      ...bots.map(({ userId, createdBy, createdAt }) => {
        const user = named.get(userId);
        return `- ${user ? describeUser(user) : `user ${userId}`}, added by ${code(createdBy)} on ${createdAt.toISOString().slice(0, 10)}`;
      }),
    ].join('\n');
  }

  private async stickerAdd({ message, args }: CommandContext<ZulipReceivedMessage>) {
    const [given, ...rest] = args;
    // The tokenizer splits the label of an upload named with a space, `[my file.png](…)`, in two, and the command fails to
    // parse when that name holds an unmatched quote, which a bare path avoids.
    const upload = STICKER_UPLOAD.exec(rest.join(' '));
    const path = upload?.[2] ?? upload?.[3];
    const url = rest.length === 1 && isStickerUrl(rest[0]) ? rest[0] : undefined;
    if (!given || (!path && !url)) {
      return this.usage('sticker-add');
    }
    const name = given.toLowerCase();
    if (!STICKER_NAME.test(name)) {
      return `${code(given)} cannot name a sticker: an emoji name is letters, digits, ${code('_')}, ${code('-')} and ${code('+')}.`;
    }
    // Zulip shows `![…]` of an image upload full size, where a link gets a small preview, but posts it as text for a
    // video or a document, so the `!` goes where Zulip wrote one or the file is an image.
    const inline = upload?.[1] === '!' || (path !== undefined && IMAGE_UPLOAD.test(path));
    const image = path ? `${inline ? '!' : ''}[${name}](${path})` : url!;
    return this.underLock(STICKERS, async () => {
      const replaced = await this.chatService.setSticker(name, image, describeZulipSender(message));
      return replaced
        ? `Updated the sticker ${code(name)}: ${code(`:${name}:`)} is answered with the new image.`
        : `Added the sticker ${code(name)}: ${code(`:${name}:`)} is answered with the image, in any stream I can see.`;
    });
  }

  private async stickerRemove({ args: [given] }: CommandContext<ZulipReceivedMessage>) {
    if (!given) {
      return this.usage('sticker-remove');
    }
    const name = given.toLowerCase();
    return this.underLock(STICKERS, async () =>
      (await this.chatService.removeSticker(name))
        ? `Removed the sticker ${code(name)}.`
        : `There is no sticker ${code(name)}; ${code('sticker-list')} lists them.`,
    );
  }

  private stickerList() {
    const stickers = this.chatService.getStickers();
    if (stickers.length === 0) {
      return Promise.resolve(`There are no stickers; ${code('sticker-add <name> <image>')} adds one.`);
    }
    return Promise.resolve(
      ['Stickers:', ...stickers.map(({ name, image }) => `- ${code(`:${name}:`)}: ${code(image)}`)].join('\n'),
    );
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
