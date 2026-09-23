import { Logger } from '@nestjs/common';
import {
  ChannelType,
  DiscordAPIError,
  HTTPError,
  IntentsBitField,
  MessageCreateOptions,
  MessageFlags,
  Partials,
  PermissionsString,
  RESTJSONErrorCodes,
  ThreadAutoArchiveDuration,
  Webhook,
} from 'discord.js';
import { Client } from 'discordx';
import { Constants } from 'src/constants';
import { DiscordErrorHandler, reportErrors } from 'src/discord/guards';
import {
  DiscordMirrorChannel,
  DiscordMirrorError,
  DiscordMirrorErrorKind,
  DiscordMirrorSend,
  DiscordMirrorSent,
  DiscordMirrorTarget,
  DiscordSourceMessage,
  DiscordTeamMember,
  IDiscordMirrorInterface,
} from 'src/interfaces/discord-mirror.interface';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';
import { isMirrorCandidate, toDiscordSourceMessage } from 'src/mirror/discord-message';

class DiscordLogger extends Logger {
  constructor() {
    super('DiscordBot');
  }

  info(...messages: string[]) {
    super.debug(messages.join('\n'));
  }

  log(...messages: string[]) {
    super.log(messages.join('\n'));
  }

  warn(...messages: string[]) {
    super.warn(messages.join('\n'));
  }

  error(...messages: string[]) {
    super.error(messages.join('\n'));
  }
}

const logger = new Logger('DiscordBot');
let reportHandlerError: DiscordErrorHandler = async (error) => logger.error('Discord handler error', error);

const bot = new Client({
  // Discord intents
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.MessageContent,
    IntentsBitField.Flags.GuildMessageReactions,
  ],

  // Debug logs are disabled in silent mode
  silent: false,

  logger: new DiscordLogger(),

  // Configuration for @SimpleCommand
  simpleCommand: {
    prefix: '/',
  },

  partials: [Partials.Message, Partials.Reaction],

  guards: [reportErrors((error) => reportHandlerError(error))],
});

const mirrorErrorKinds: Partial<Record<number, DiscordMirrorErrorKind>> = {
  [RESTJSONErrorCodes.UnknownChannel]: 'unknown-channel',
  [RESTJSONErrorCodes.UnknownMessage]: 'unknown-message',
  [RESTJSONErrorCodes.UnknownWebhook]: 'unknown-webhook',
  [RESTJSONErrorCodes.MaximumNumberOfWebhooksReached]: 'max-webhooks',
  [RESTJSONErrorCodes.RequestEntityTooLarge]: 'too-large',
  [RESTJSONErrorCodes.TagRequiredToCreateAForumPostInThisChannel]: 'forum',
  [RESTJSONErrorCodes.MissingAccess]: 'forbidden',
  [RESTJSONErrorCodes.MissingPermissions]: 'forbidden',
  [RESTJSONErrorCodes.InvalidActionOnArchivedThread]: 'archived',
  [RESTJSONErrorCodes.ThreadLocked]: 'locked',
  [RESTJSONErrorCodes.WebhooksPostedToForumChannelsMustHaveAThreadNameOrThreadId]: 'forum',
  [RESTJSONErrorCodes.WebhooksPostedToForumChannelsCannotHaveBothAThreadNameAndThreadId]: 'forum',
  [RESTJSONErrorCodes.WebhooksCanOnlyCreateThreadsInForumChannels]: 'forum',
};

const WEBHOOK_FAILURE_MS = 10 * 60 * 1000;

const mirrorPermissions: PermissionsString[] = [
  'ViewChannel',
  'ReadMessageHistory',
  'SendMessages',
  'SendMessagesInThreads',
  'ManageThreads',
  'ManageWebhooks',
  'ManageMessages',
  'AttachFiles',
  'EmbedLinks',
];

/**
 * discord.js errors carry the request URL, which holds the webhook token, and the request body, so they are
 * replaced rather than wrapped.
 */
const toMirrorError = (error: unknown): DiscordMirrorError => {
  if (error instanceof DiscordMirrorError) {
    return error;
  }

  if (error instanceof DiscordAPIError) {
    const code = typeof error.code === 'number' ? error.code : undefined;
    return new DiscordMirrorError(
      (code === undefined ? undefined : mirrorErrorKinds[code]) ?? 'other',
      code,
      error.message.replaceAll('\n', '; '),
    );
  }

  if (error instanceof HTTPError) {
    return new DiscordMirrorError(error.status === 413 ? 'too-large' : 'other', undefined, `HTTP ${error.status}`);
  }

  return new DiscordMirrorError('other', undefined, error instanceof Error ? error.message : String(error));
};

const hasCode = (error: unknown, ...codes: number[]) =>
  error instanceof DiscordAPIError && typeof error.code === 'number' && codes.includes(error.code);

const bySnowflake = (a: { id: string }, b: { id: string }) => {
  const [x, y] = [BigInt(a.id), BigInt(b.id)];
  return x < y ? -1 : x > y ? 1 : 0;
};

export class DiscordRepository implements IDiscordInterface, IDiscordMirrorInterface {
  private mirrorWebhooks = new Map<string, Webhook>();
  private mirrorWebhookFailures = new Map<string, { error: DiscordMirrorError; until: number }>();

  constructor() {
    bot
      .once('clientReady', async () => {
        // await bot.clearApplicationCommands();
        await bot.initApplicationCommands();
      })
      .on(
        'interactionCreate',
        (interaction) =>
          Constants.Discord.Servers.includes(interaction.guildId ?? '') && bot.executeInteraction(interaction),
      )
      .on(
        'messageCreate',
        (message) => Constants.Discord.Servers.includes(message.guildId ?? '') && bot.executeCommand(message),
      );
  }

  async login(token: string) {
    // bot.login resolves at the gateway's READY, before the guilds arrive: until then no guild channel can be fetched.
    const ready = new Promise<void>((resolve) => bot.once('clientReady', () => resolve()));
    await bot.login(token);
    await ready;
  }

  isReady() {
    return bot.isReady();
  }

  onHandlerError(handler: DiscordErrorHandler) {
    reportHandlerError = handler;
  }

  async sendMessage({
    channelId,
    threadId,
    message,
    crosspost = false,
    pin = false,
  }: {
    channelId: DiscordChannel | string;
    threadId?: string;
    message: MessageCreateOptions;
    crosspost?: boolean;
    pin?: boolean;
  }): Promise<void> {
    let channel = await bot.channels.fetch(channelId);

    if (threadId && channel?.isThreadOnly()) {
      channel = await channel.threads.fetch(threadId);
    }

    if (channel?.isSendable()) {
      const sentMessage = await channel.send(message);

      if (crosspost) {
        await sentMessage.crosspost();
      }

      if (pin) {
        await sentMessage.pin();
      }
    }
  }

  async createEmote(name: string, emote: string | Buffer, guildId: string) {
    return bot.guilds.cache.get(guildId)?.emojis.create({ name, attachment: emote });
  }

  async getEmotes(guildId: string) {
    const guild = bot.guilds.cache.get(guildId);
    if (!guild) {
      return undefined;
    }

    const emotes = await guild.emojis.fetch();
    return emotes.map((emote) => ({
      identifier: emote.identifier,
      name: emote.name,
      url: emote.imageURL(),
      animated: emote.animated,
    }));
  }

  async createThread(
    channelId: string,
    { name, message, appliedTags }: { name: string; message: string; appliedTags?: string[] },
  ) {
    const channel = await bot.channels.fetch(channelId);
    if (!channel?.isThreadOnly()) {
      return {};
    }

    const { id } = await channel.threads.create({
      name,
      message: { content: message, flags: [MessageFlags.SuppressEmbeds] },
      appliedTags,
    });
    return { threadId: id };
  }

  async updateThread(
    { channelId, threadId }: { channelId: string; threadId: string },
    { name, message, appliedTags }: { name: string; message: string; appliedTags?: string[] },
  ) {
    const channel = await bot.channels.fetch(channelId);
    if (!channel?.isThreadOnly()) {
      return;
    }

    const thread = await channel.threads.fetch(threadId);
    if (!thread) {
      return;
    }

    const initialMessage = await thread.fetchStarterMessage();

    await thread.setName(name);
    await thread.setAppliedTags(appliedTags ?? []);
    await initialMessage?.edit(message);
  }

  async setThreadArchived({ channelId, threadId }: { channelId: string; threadId: string }, archived: boolean) {
    const channel = await bot.channels.fetch(channelId);
    if (!channel?.isThreadOnly()) {
      return;
    }

    const thread = await channel.threads.fetch(threadId);
    await thread?.setArchived(archived);
  }

  isReady() {
    return bot.isReady();
  }

  async getMirrorChannel(channelId: string): Promise<DiscordMirrorChannel | undefined> {
    try {
      const channel = await bot.channels.fetch(channelId);
      if (!channel || channel.isDMBased()) {
        return undefined;
      }

      const { guild } = channel;
      const me = guild.members.me ?? (await guild.members.fetchMe());
      const kind =
        channel.type === ChannelType.GuildText ? 'text' : channel.type === ChannelType.GuildForum ? 'forum' : 'other';
      const required: PermissionsString[] =
        kind === 'text' ? [...mirrorPermissions, 'CreatePublicThreads'] : mirrorPermissions;

      return {
        id: channel.id,
        guildId: channel.guildId,
        name: channel.name,
        kind,
        categoryId: channel.parentId,
        everyoneCanView: channel.permissionsFor(guild.roles.everyone).has('ViewChannel'),
        missingPermissions: channel.permissionsFor(me).missing(required),
      };
    } catch (error) {
      if (hasCode(error, RESTJSONErrorCodes.UnknownChannel)) {
        return undefined;
      }
      throw toMirrorError(error);
    }
  }

  async ensureMirrorWebhook(channelId: string): Promise<void> {
    if (this.mirrorWebhooks.has(channelId)) {
      return;
    }

    this.throwWebhookFailure(channelId);

    try {
      this.mirrorWebhooks.set(channelId, await this.findOrCreateMirrorWebhook(channelId));
      this.mirrorWebhookFailures.delete(channelId);
    } catch (error) {
      const mirrorError = toMirrorError(error);
      if (mirrorError.kind === 'forbidden' || mirrorError.kind === 'max-webhooks') {
        this.mirrorWebhookFailures.set(channelId, { error: mirrorError, until: Date.now() + WEBHOOK_FAILURE_MS });
      }
      throw mirrorError;
    }
  }

  async sendMirrorMessage(message: DiscordMirrorSend): Promise<DiscordMirrorSent> {
    const webhook = this.getMirrorWebhook(message.channelId);
    const files = await Promise.all(
      (message.files ?? []).map(async (file) => ({
        attachment: Buffer.from(await file.arrayBuffer()),
        name: file.name,
      })),
    );

    try {
      const sent = await webhook.send({
        content: message.content,
        username: message.username,
        ...(message.avatarUrl === undefined ? {} : { avatarURL: message.avatarUrl }),
        ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
        ...(message.threadName === undefined ? {} : { threadName: message.threadName }),
        files,
        allowedMentions: { parse: [], roles: [], users: message.pingUserIds, repliedUser: false },
        flags: message.suppressEmbeds ? [MessageFlags.SuppressEmbeds] : [],
      });
      return { messageId: sent.id, channelId: sent.channelId, webhookId: webhook.id };
    } catch (error) {
      throw this.toWebhookError(message.channelId, webhook, error);
    }
  }

  async editMirrorMessage(target: DiscordMirrorTarget, edit: { content: string; suppressEmbeds: boolean }) {
    const webhook = this.getMirrorWebhook(target.channelId);
    if (target.webhookId !== webhook.id) {
      throw new DiscordMirrorError('replaced-webhook');
    }

    try {
      await webhook.editMessage(target.messageId, {
        content: edit.content,
        allowedMentions: { parse: [], users: [] },
        flags: edit.suppressEmbeds ? [MessageFlags.SuppressEmbeds] : [],
        ...(target.threadId === null ? {} : { threadId: target.threadId }),
      });
    } catch (error) {
      throw this.toWebhookError(target.channelId, webhook, error);
    }
  }

  async deleteMirrorMessage(target: DiscordMirrorTarget) {
    const webhook = this.mirrorWebhooks.get(target.channelId);
    if (webhook && target.webhookId === webhook.id) {
      try {
        await webhook.deleteMessage(target.messageId, target.threadId ?? undefined);
        return;
      } catch (error) {
        const mirrorError = this.toWebhookError(target.channelId, webhook, error);
        if (mirrorError.kind !== 'unknown-webhook') {
          throw mirrorError;
        }
      }
    }

    try {
      const channel = await bot.channels.fetch(target.threadId ?? target.channelId);
      if (!channel?.isTextBased()) {
        throw new DiscordMirrorError('unknown-channel');
      }
      await channel.messages.delete(target.messageId);
    } catch (error) {
      throw toMirrorError(error);
    }
  }

  async startMirrorThread(channelId: string, messageId: string, name: string) {
    try {
      const channel = await bot.channels.fetch(channelId);
      if (channel?.type !== ChannelType.GuildText) {
        throw new DiscordMirrorError('unknown-channel');
      }

      const thread = await channel.threads.create({
        startMessage: messageId,
        name,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      });
      return thread.id;
    } catch (error) {
      throw toMirrorError(error);
    }
  }

  async renameMirrorThread(threadId: string, name: string) {
    try {
      const thread = await this.fetchThread(threadId);
      await thread.setName(name);
    } catch (error) {
      throw toMirrorError(error);
    }
  }

  async unarchiveMirrorThread(threadId: string) {
    try {
      const thread = await this.fetchThread(threadId);
      await thread.setArchived(false);
    } catch (error) {
      throw toMirrorError(error);
    }
  }

  async getTeamMember(guildId: string, userId: string): Promise<DiscordTeamMember | undefined> {
    const guild = bot.guilds.cache.get(guildId);
    if (!guild) {
      return undefined;
    }

    try {
      const member = await guild.members.fetch(userId);
      return {
        displayName: member.displayName,
        avatarUrl: member.displayAvatarURL({ extension: 'png', size: 256 }),
        roleIds: [...member.roles.cache.keys()],
      };
    } catch (error) {
      if (hasCode(error, RESTJSONErrorCodes.UnknownMember, RESTJSONErrorCodes.UnknownUser)) {
        return undefined;
      }
      throw toMirrorError(error);
    }
  }

  async fetchMirrorMessagesAfter(channelId: string, afterId: string, limit: number): Promise<DiscordSourceMessage[]> {
    try {
      const channel = await bot.channels.fetch(channelId);
      if (!channel?.isTextBased() || channel.isDMBased()) {
        throw new DiscordMirrorError('unknown-channel');
      }

      const messages = await channel.messages.fetch({ after: afterId, limit });
      return [...messages.values()].filter(isMirrorCandidate).sort(bySnowflake).map(toDiscordSourceMessage);
    } catch (error) {
      throw toMirrorError(error);
    }
  }

  private async findOrCreateMirrorWebhook(channelId: string): Promise<Webhook> {
    const channel = await bot.channels.fetch(channelId);
    if (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildForum) {
      throw new DiscordMirrorError('unknown-channel');
    }

    const user = bot.user;
    if (!user) {
      throw new DiscordMirrorError('other', undefined, 'Discord is not ready');
    }

    const [existing] = [...(await channel.fetchWebhooks()).values()]
      .filter((webhook) => webhook.owner?.id === user.id && webhook.token)
      .sort(bySnowflake);

    return (
      existing ??
      (await channel.createWebhook({
        name: 'Zulip mirror',
        avatar: user.displayAvatarURL({ extension: 'png', size: 256 }),
        reason: 'Discord-Zulip mirror',
      }))
    );
  }

  private getMirrorWebhook(channelId: string): Webhook {
    const webhook = this.mirrorWebhooks.get(channelId);
    if (webhook) {
      return webhook;
    }

    this.throwWebhookFailure(channelId);
    throw new DiscordMirrorError('unknown-webhook', undefined, 'The mirror webhook is not resolved');
  }

  private throwWebhookFailure(channelId: string) {
    const failure = this.mirrorWebhookFailures.get(channelId);
    if (!failure) {
      return;
    }

    if (Date.now() < failure.until) {
      throw failure.error;
    }
    this.mirrorWebhookFailures.delete(channelId);
  }

  private toWebhookError(channelId: string, webhook: Webhook, error: unknown) {
    const mirrorError = toMirrorError(error);
    if (mirrorError.kind === 'unknown-webhook' && this.mirrorWebhooks.get(channelId) === webhook) {
      this.mirrorWebhooks.delete(channelId);
    }
    return mirrorError;
  }

  private async fetchThread(threadId: string) {
    const thread = await bot.channels.fetch(threadId);
    if (!thread?.isThread()) {
      throw new DiscordMirrorError('unknown-channel');
    }
    return thread;
  }
}
