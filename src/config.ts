export const getConfig = () => {
  const databaseUri = process.env.uri;
  const botToken = process.env.BOT_TOKEN;
  const zulipBotUsername = process.env.ZULIP_BOT_USERNAME;
  const zulipBotApiKey = process.env.ZULIP_BOT_API_KEY;
  const zulipUserUsername = process.env.ZULIP_USER_USERNAME;
  const zulipUserApiKey = process.env.ZULIP_USER_API_KEY;
  const zulipDomain = process.env.ZULIP_DOMAIN;
  const githubWebhookSlug = process.env.GITHUB_SLUG;
  const githubStatusWebhookSlug = process.env.GITHUB_STATUS_SLUG;
  const githubAppId = process.env.GITHUB_APP_ID;
  const githubInstallationId = process.env.GITHUB_INSTALLATION_ID;
  const githubPrivateKey = process.env.GITHUB_PRIVATE_KEY;
  const stripeWebhookSlug = process.env.STRIPE_PAYMENT_SLUG;
  const polarWebhookSlug = process.env.POLAR_PAYMENT_SLUG;
  const polarWebhookImmichClientSecret = process.env.POLAR_PAYMENT_IMMICH_CLIENT_WEBHOOK_SECRET;
  const polarWebhookImmichServerSecret = process.env.POLAR_PAYMENT_IMMICH_SERVER_WEBHOOK_SECRET;
  const commitSha = process.env.COMMIT_SHA;
  const fourthwallUser = process.env.FOURTHWALL_USER;
  const fourthwallPassword = process.env.FOURTHWALL_PASSWORD;
  const fourthwallWebhookSlug = process.env.FOURTHWALL_SLUG;
  const outlineApiKey = process.env.OUTLINE_API_KEY;
  const loopDedupeApiKey = process.env.LOOPDEDUPE_SEARCH_API_KEY;
  const mattermostDomain = process.env.MATTERMOST_DOMAIN;
  const mattermostBotToken = process.env.MATTERMOST_BOT_TOKEN;

  if (
    !databaseUri ||
    !botToken ||
    !zulipBotUsername ||
    !zulipBotApiKey ||
    !zulipUserUsername ||
    !zulipUserApiKey ||
    !zulipDomain ||
    !fourthwallUser ||
    !fourthwallPassword ||
    !githubAppId ||
    !githubInstallationId ||
    !githubPrivateKey ||
    !outlineApiKey ||
    !loopDedupeApiKey ||
    !polarWebhookImmichClientSecret ||
    !polarWebhookImmichServerSecret ||
    !mattermostDomain ||
    !mattermostBotToken
  ) {
    console.log({
      databaseUri,
      botToken,
      zulipBotUsername,
      zulipBotApiKey,
      zulipUserUsername,
      zulipUserApiKey,
      zulipDomain,
      fourthwallUser,
      fourthwallPassword,
      githubAppId,
      githubInstallationId,
      githubPrivateKey,
      outlineApiKey,
      loopDedupeApiKey,
      polarWebhookImmichClientSecret,
      polarWebhookImmichServerSecret,
      mattermostDomain,
      mattermostBotToken,
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
      appId: githubAppId,
      installationId: githubInstallationId,
      privateKey: githubPrivateKey,
    },
    slugs: {
      githubWebhook: githubWebhookSlug,
      githubStatusWebhook: githubStatusWebhookSlug,
      stripeWebhook: stripeWebhookSlug,
      polarWebhook: polarWebhookSlug,
      fourthwallWebhook: fourthwallWebhookSlug,
    },
    polar: {
      immichClientSecret: polarWebhookImmichClientSecret,
      immichServerSecret: polarWebhookImmichServerSecret,
    },
    zulip: {
      bot: {
        username: zulipBotUsername,
        apiKey: zulipBotApiKey,
      },
      user: {
        username: zulipUserUsername,
        apiKey: zulipUserApiKey,
      },
      realm: zulipDomain,
    },
    mattermost: {
      domain: mattermostDomain,
      botToken: mattermostBotToken,
    },
    fourthwall: {
      user: fourthwallUser,
      password: fourthwallPassword,
    },
    outline: {
      apiKey: outlineApiKey,
    },
    loopDedupe: {
      apiKey: loopDedupeApiKey,
    },
  };
};
