import dotenv from 'dotenv';

export const getConfig = () => {
  dotenv.config();

  const clientId = process.env.IMMICH_GITHUB_CLIENT_ID;
  const clientSecret = process.env.IMMICH_GITHUB_CLIENT_SECRET;
  const databaseUri = process.env.uri;
  const botToken = process.env.BOT_TOKEN;
  const githubWebhookSlug = process.env.GITHUB_STATUS_SLUG;
  const stripeWebhookSlug = process.env.STRIPE_PAYMENT_SLUG;
  const commitSha = process.env.COMMIT_SHA;

  if (!clientId || !clientSecret || !databaseUri || !botToken) {
    console.log({ clientId, clientSecret, databaseUri, botToken });
    throw new Error('Missing required environment variables');
  }

  return {
    commitSha: commitSha || 'dev',
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
};
