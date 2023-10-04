import { dirname, importx } from '@discordx/importer';
import type { Interaction, Message, TextChannel } from 'discord.js';
import { IntentsBitField } from 'discord.js';
import { Client } from 'discordx';
import { version } from '../package.json'

export const bot = new Client({
  // Discord intents
  intents: [IntentsBitField.Flags.GuildMessages],

  // Debug logs are disabled in silent mode
  silent: false,

  // Configuration for @SimpleCommand
  simpleCommand: {
    prefix: '/',
  },
});

bot.once('ready', async () => {
  const sha = process.env.COMMIT_SHA.substring(0, 8)
  const full_version = `${version}@${sha}`
  // Synchronize applications commands with Discord
  await bot.initApplicationCommands();

  console.log(`Bot ${full_version} started`);

  const channel = bot.channels.cache.get('1159083520027787307') as TextChannel
  
  if (channel) {
    channel.send(`I'm alive, running ${full_version}!`)
  }
});

bot.on('interactionCreate', (interaction: Interaction) => {
  bot.executeInteraction(interaction);
});

bot.on('messageCreate', (message: Message) => {
  bot.executeCommand(message);
});

async function run() {
  // The following syntax should be used in the commonjs environment
  //
  // await importx(__dirname + "/{events,commands}/**/*.{ts,js}");

  // The following syntax should be used in the ECMAScript environment
  await importx(`${dirname(import.meta.url)}/{events,commands}/**/*.{ts,js}`);

  // Let's start the bot
  if (!process.env.BOT_TOKEN) {
    throw Error('Could not find BOT_TOKEN in your environment');
  }

  // Log in with your bot token
  await bot.login(process.env.BOT_TOKEN);
}

run();
