export type GithubStatusBase = {
  meta: { unsubscribe: string; documentation: string };
  page: { id: string; status_indicator: string; status_description: string };
};

export type GithubStatusComponent = GithubStatusBase & {
  component_update: { createdAt: string; new_status: string; old_status: string; id: string; component_id: string };
  component: { created_at: string; id: string; name: string; status: string };
};

export type GithubStatusIncident = GithubStatusBase & {
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

export type StripeBase<T = unknown> = {
  id: string;
  object: string;
  type: string;
  data: {
    object: {
      id: string;
      object: string;
    } & T;
  };
};

export type PaymentIntent = {
  amount: number;
  currency: string;
  created: number;
  description: string;
  status: string;
  receipt_email: string;
  livemode: boolean;
};
