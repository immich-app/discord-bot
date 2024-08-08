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
        // await bot.initApplicationCommands();
      })
      .on('interactionCreate', (interaction) => bot.executeInteraction(interaction) as Promise<void>)
      .on('messageCreate', (message) => bot.executeCommand(message) as Promise<void>);
  }

  async login(token: string) {
    await bot.login(token);
  }

  async sendMessage(channel: DiscordChannel, message: MessageCreateOptions): Promise<void> {
    const textChannel = await bot.channels.fetch(channel);
    if (textChannel && textChannel.isTextBased()) {
      await textChannel.send(message);
    }
  }
}
