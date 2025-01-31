import dotenv from 'dotenv';

export const getConfig = () => {
  dotenv.config();

  const clientId = process.env.IMMICH_GITHUB_CLIENT_ID;
  const clientSecret = process.env.IMMICH_GITHUB_CLIENT_SECRET;
  const databaseUri = process.env.uri;
  const botToken = process.env.BOT_TOKEN;
  const zulipUsername = process.env.ZULIP_USERNAME;
  const zulipApiKey = process.env.ZULIP_API_KEY;
  const zulipDomain = process.env.ZULIP_DOMAIN;
  const githubWebhookSlug = process.env.GITHUB_SLUG;
  const githubStatusWebhookSlug = process.env.GITHUB_STATUS_SLUG;
  const stripeWebhookSlug = process.env.STRIPE_PAYMENT_SLUG;
  const commitSha = process.env.COMMIT_SHA;
  const fourthwallUser = process.env.FOURTHWALL_USER;
  const fourthwallPassword = process.env.FOURTHWALL_PASSWORD;
  const fourthwallWebhookSlug = process.env.FOURTHWALL_SLUG;

  if (
    !clientId ||
    !clientSecret ||
    !databaseUri ||
    !botToken ||
    !zulipUsername ||
    !zulipApiKey ||
    !zulipDomain ||
    !fourthwallUser ||
    !fourthwallPassword
  ) {
    console.log({
      clientId,
      clientSecret,
      databaseUri,
      botToken,
      zulipUsername,
      zulipApiKey,
      zulipDomain,
      fourthwallUser,
      fourthwallPassword,
    });
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
      githubStatusWebhook: githubStatusWebhookSlug,
      stripeWebhook: stripeWebhookSlug,
      fourthwallWebhook: fourthwallWebhookSlug,
    },
    zulip: {
      username: zulipUsername,
      apiKey: zulipApiKey,
      realm: zulipDomain,
    },
    fourthwall: {
      user: fourthwallUser,
      password: fourthwallPassword,
    },
  };
};
