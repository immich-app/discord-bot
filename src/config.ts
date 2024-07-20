import dotenv from 'dotenv';
dotenv.config();

const clientId = process.env.IMMICH_GITHUB_CLIENT_ID;
const clientSecret = process.env.IMMICH_GITHUB_CLIENT_SECRET;
const databaseUri = process.env.uri;
const botToken = process.env.BOT_TOKEN;
const githubWebhookSlug = process.env.GITHUB_STATUS_SLUG;
const stripeWebhookSlug = process.env.STRIPE_PAYMENT_SLUG;
const commitSha = process.env.COMMIT_SHA;

if (!clientId || !clientSecret || !databaseUri || !botToken || !githubWebhookSlug || !commitSha) {
  console.log({ clientId, clientSecret, databaseUri, botToken, githubWebhookSlug, commitSha });
  throw new Error('Missing required environment variables');
}

export const config = {
  commitSha,
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
  slugs: {
    githubWebhook: githubWebhookSlug,
    stripeWebhook: stripeWebhookSlug,
  },
};
