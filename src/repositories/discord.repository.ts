import { Logger } from '@nestjs/common';
import { IntentsBitField, MessageCreateOptions, Partials } from 'discord.js';
import { Client } from 'discordx';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';

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
});

export class DiscordRepository implements IDiscordInterface {
  private logger = new Logger(DiscordRepository.name);

  constructor() {
    bot
      .once('ready', async () => {
        // await bot.clearApplicationCommands();
        await bot.initApplicationCommands();
      })
      .on('interactionCreate', (interaction) => bot.executeInteraction(interaction) as Promise<void>)
      .on('messageCreate', (message) => bot.executeCommand(message) as Promise<void>);
  }

  async login(token: string) {
    await bot.login(token);
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
    const emotes = await bot.guilds.cache.get(guildId)?.emojis.fetch();
    const result = [];

    for (const emote of emotes?.values() ?? []) {
      result.push({ identifier: emote.identifier, name: emote.name, url: emote.imageURL(), animated: emote.animated });
    }
    return result;
  }

  async createThread(
    channelId: string,
    { name, message, appliedTags }: { name: string; message: string; appliedTags?: string[] },
  ) {
    const channel = await bot.channels.fetch(channelId);
    if (!channel?.isThreadOnly()) {
      return {};
    }

    const { id } = await channel.threads.create({ name, message: { content: message }, appliedTags });
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

  async closeThread({ channelId, threadId }: { channelId: string; threadId: string }) {
    const channel = await bot.channels.fetch(channelId);
    if (!channel?.isThreadOnly()) {
      return;
    }

    const thread = await channel.threads.fetch(threadId);
    await thread?.setArchived(true);
  }
}
