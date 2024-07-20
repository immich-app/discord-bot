import { importx } from '@discordx/importer';
import { IntentsBitField, MessageCreateOptions, Partials, TextChannel } from 'discord.js';
import { Client } from 'discordx';
import EventEmitter from 'node:events';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';

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

  // Configuration for @SimpleCommand
  simpleCommand: {
    prefix: '/',
  },

  partials: [Partials.Message, Partials.Reaction],
});

export class DiscordRepository extends EventEmitter implements IDiscordInterface {
  constructor() {
    super();

    bot.on('ready', () => void this.emit('ready'));
    bot.on('error', (error) => void this.emit('error', error));
    bot.on('interactionCreate', (interaction) => void bot.executeInteraction(interaction));
    bot.on('messageCreate', async (message) => void bot.executeCommand(message));
  }

  async login(token: string) {
    await importx(__dirname + '/{events,commands}/**/*.{ts,js}');
    await bot.login(token);
  }

  initApplicationCommands(): Promise<void> {
    return bot.initApplicationCommands();
  }

  async sendMessage(channel: DiscordChannel, message: MessageCreateOptions): Promise<void> {
    const textChannel = (await bot.channels.fetch(channel)) as TextChannel;
    await textChannel.send(message);
  }
}
