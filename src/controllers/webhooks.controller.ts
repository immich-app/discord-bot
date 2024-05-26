import express from 'express';
import { bot } from '../main.js';
import { Constants } from '../constants.js';
import { TextChannel } from 'discord.js';

const app = express.Router();

type GithubStatusBase = {
  meta: { unsubscribe: string; documentation: string };
  page: { id: string; status_indicator: string; status_description: string };
};

type GithubStatusComponent = GithubStatusBase & {
  component_update: { createdAt: string; new_status: string; old_status: string; id: string; component_id: string };
  component: { created_at: string; id: string; name: string; status: string };
};

type GithubStatusIncident = GithubStatusBase & {
  incident: {
    name: string;
    backfilled: boolean;
    created_at: string;
    impact: string;
    impact_override: unknown;
    monitoring_at: string;
    postmortem_body: unknown;
    postmortem_body_last_updated_at: string;
    postmortem_ignored: boolean;
    postmortem_notified_subscribers: boolean;
    postmortem_notified_twitter: boolean;
    postmortem_published_at: string;
    resolved_at: string;
    scheduled_auto_transition: boolean;
    scheduled_for: string;
    scheduled_remind_prior: boolean;
    scheduled_reminded_at: string;
    scheduled_until: string;
    shortlink: string;
    status: string;
    updated_at: string;
    id: string;
    organization_id: string;
    incident_updates: [
      {
        body: string;
        created_at: string;
        display_at: string;
        status: string;
        twitter_updated_at: string;
        updated_at: string;
        wants_twitter_update: boolean;
        id: string;
        incident_id: string;
      },
    ];
  };
};

// const isGithubComponentUpdate = (
//   payload: GithubStatusComponent | GithubStatusIncident,
// ): payload is GithubStatusComponent => {
//   if ((payload as GithubStatusComponent).component) {
//     return true;
//   }
//   return false;
// };

const isGithubIncidentUpdate = (
  payload: GithubStatusComponent | GithubStatusIncident,
): payload is GithubStatusIncident => {
  if ((payload as GithubStatusIncident).incident) {
    return true;
  }
  return false;
};

app.post('/github-status/:slug', async (req, res) => {
  if (req.params.slug !== process.env.GITHUB_STATUS_SLUG) {
    res.status(401).send();
    return;
  }

  const body = req.body;
  console.log(body);
  if (isGithubIncidentUpdate(body)) {
    const channel = (await bot.channels.fetch(Constants.Channels.GithubStatus)) as TextChannel;
    await channel.send(
      `# ${body.page.status_description}: ${body.incident.name}\n${body.incident.incident_updates[0].body}`,
    );
  }

  res.status(200).send();
});

export const webhooks = app;
