import dotenv from 'dotenv';
dotenv.config();

const clientId = process.env.IMMICH_GITHUB_CLIENT_ID;
const clientSecret = process.env.IMMICH_GITHUB_CLIENT_SECRET;
const databaseUri = process.env.uri;
const botToken = process.env.BOT_TOKEN;

if (!clientId || !clientSecret || !databaseUri || !botToken) {
  console.log({ clientId, clientSecret, databaseUri, botToken });
  throw new Error('Missing required environment variables');
}

export const config = {
  bot: {
    token: botToken,
  },
  database: {
    uri: databaseUri,
  },
  github: {
    clientId,
    clientSecret,
  },
};
