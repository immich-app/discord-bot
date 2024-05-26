import { dirname, importx } from '@discordx/importer';
import { CronJob } from 'cron';
import type { Interaction, Message, TextChannel } from 'discord.js';
import { IntentsBitField, Partials } from 'discord.js';
import { Client } from 'discordx';
import { Constants } from './constants.js';
import express from 'express';
import { webhooks } from './controllers/webhooks.controller.js';

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

const birthdayJob = new CronJob(Constants.Misc.ImmichBirthdayCron, async () => {
  const channel = (await bot.channels.fetch(Constants.Channels.General)) as TextChannel;
  if (channel) {
    await channel.send(`"Happy birthday my other child" - Alex`);
  }
});

const app = express();

bot.once('ready', async () => {
  const sha = process.env.COMMIT_SHA;
  const commit = sha && `[${sha.substring(0, 8)}](https://github.com/immich-app/discord-bot/commit/${sha})`;
  const fullVersion = commit && `${process.env.npm_package_version}@${commit}`;
  // Synchronize applications commands with Discord
  await bot.initApplicationCommands();

  console.log(`Bot ${fullVersion} started`);

  const channel = (await bot.channels.fetch(Constants.Channels.BotSpam)) as TextChannel;

  if (channel && fullVersion) {
    await channel.send(`I'm alive, running ${fullVersion}!`);
  }

  birthdayJob.start();
});

bot.on('interactionCreate', async (interaction: Interaction) => {
  await bot.executeInteraction(interaction);
});

bot.on('messageCreate', async (message: Message) => {
  await bot.executeCommand(message);
});

bot.on('error', async (error) => {
  console.log(`Error handling bot interaction: ${error}`);
  const botSpamChannel = (await bot.channels.fetch(Constants.Channels.BotSpam)) as TextChannel;
  await botSpamChannel.send(`Error handling bot interaction: ${error}`);
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
  app.use(express.json());
  app.use('/webhooks', webhooks);
  app.listen(8080, () => {
    console.log('Bot listening on port 8080');
  });
  await bot.login(process.env.BOT_TOKEN);
}

await run();
