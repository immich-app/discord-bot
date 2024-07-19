import express from 'express';
import { generators, Issuer } from 'openid-client';
import { config } from '../../config.js';
import { getSponsorLicenses } from '../../repositories/sponsor.repository.js';

type GithubProfile = {
  login: string;
  id: string;
  avatar_url: string;
  url: string;
  type: 'User';
  name: string;
  created_at: string;
  updated_at: string;
};

const issuer = new Issuer({
  issuer: 'https://github.com',
  authorization_endpoint: 'https://github.com/login/oauth/authorize',
  token_endpoint: 'https://github.com/login/oauth/access_token',
  userinfo_endpoint: 'https://api.github.com/user',
});

const client = new issuer.Client({
  client_id: config.github.clientId,
  client_secret: config.github.clientSecret,
});

type StateItem = { value: string; expiresAt: number };
const stateMap = new Map<string, StateItem>();

const app = express.Router();

app.get('/authorize', (req, res) => {
  const state = generators.state();
  stateMap.set(state, { value: state, expiresAt: Date.now() + 5 * 60 * 1000 });
  res.status(200).send({ url: client.authorizationUrl({ state, scope: 'openid profile email' }) });
});

app.post('/callback', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    res.status(400).send({ error: 'Missing required parameter: url' });
    return;
  }

  try {
    const redirectUri = new URL(url).origin + '/claim/callback';
    const params = client.callbackParams(url);

    if (!params.state || !stateMap.has(params.state)) {
      res.status(400).send({ error: 'Invalid state parameter' });
      return;
    }

    const stateItem = stateMap.get(params.state);
    if (!stateItem || stateItem.expiresAt < Date.now()) {
      res.status(400).send({ error: 'Invalid state parameter' });
      return;
    }

    const tokens = await client.oauthCallback(redirectUri, params, { state: stateItem.value });
    const profile = await client.userinfo<GithubProfile>(tokens);

    const licenses = await getSponsorLicenses(profile.login);

    return res.status(200).send({
      username: profile.login,
      imageUrl: profile.avatar_url,
      licenses,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({ error: 'An error occurred while processing the request' });
  }
});

export const oauth = app;
