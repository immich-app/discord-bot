import { dirname, importx } from '@discordx/importer';
import { CronJob } from 'cron';
import type { Interaction, Message, TextChannel } from 'discord.js';
import { IntentsBitField, Partials } from 'discord.js';
import { Client } from 'discordx';

export const bot = new Client({
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

const birthdayJob = new CronJob('36 4 3 2 *', async () => {
  const channel = (await bot.channels.fetch('994044917355663450')) as TextChannel;

  if (channel) {
    channel.send(`"Happy birthday my other child" - Alex`);
  }
});

bot.once('ready', async () => {
  const sha = process.env.COMMIT_SHA;
  const commit = sha && `[${sha.substring(0, 8)}](https://github.com/immich-app/discord-bot/commit/${sha})`;
  const fullVersion = commit && `${process.env.npm_package_version}@${commit}`;
  // Synchronize applications commands with Discord
  await bot.initApplicationCommands();

  console.log(`Bot ${fullVersion} started`);

  const channel = (await bot.channels.fetch('1159083520027787307')) as TextChannel;

  if (channel && fullVersion) {
    channel.send(`I'm alive, running ${fullVersion}!`);
  }

  birthdayJob.start();
});

bot.on('interactionCreate', (interaction: Interaction) => {
  bot.executeInteraction(interaction);
});

bot.on('messageCreate', async (message: Message) => {
  // execute simple commands
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
