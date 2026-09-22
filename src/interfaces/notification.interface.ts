/**
 * What kind of notification this is. Renderers derive every layout decision (title size, whether a
 * body slot exists, body truncation, fields layout, ...) from the kind, so services never describe
 * how a notification should look on any one platform.
 */
export type NotificationKind =
  /** A pull request, issue or discussion event. */
  | 'feed'
  /** A published GitHub release. */
  | 'release'
  /** A GitHub status incident update. */
  | 'incident'
  /** A Stripe, Polar or Fourthwall purchase. */
  | 'purchase'
  /** A daily, weekly or monthly licences or orders report. */
  | 'report'
  /** A release workflow failure. */
  | 'alert';

/**
 * Semantic outcome of the event, namespaced by domain. A token names the event at its call site and
 * nothing else: several tokens may render identically (see `src/renderers/palette.ts`), but no call
 * site may borrow a token because its colour happens to match. Each renderer maps a token to its own
 * affordance: Discord picks an embed colour, Mattermost an accent hex, Zulip (later) a leading emoji.
 */
export type NotificationAccent =
  | 'pr.opened'
  | 'pr.draft'
  | 'pr.merged'
  | 'pr.closed'
  | 'issue.opened'
  | 'issue.reopened'
  | 'issue.closed'
  | 'discussion.created'
  | 'discussion.reopened'
  | 'discussion.deleted'
  | 'discussion.answered'
  | 'incident.resolved'
  | 'incident.minor'
  | 'incident.major'
  | 'incident.unknown'
  | 'purchase.live'
  | 'purchase.test'
  | 'order.placed'
  | 'order.cancelled'
  | 'order.test'
  | 'report.licenses'
  | 'report.orders'
  | 'release.failed';

export type NotificationField = { name: string; value: string; inline?: boolean };
/**
 * Who the notification is attributed to. Always rendered as a link to `url`. Whether the avatar is
 * shown is a function of `kind` (feed and release show it, the rest do not), never of `iconUrl`.
 */
export type NotificationAuthor = { name: string; url: string; iconUrl?: string };

export type Notification = {
  kind: NotificationKind;
  accent?: NotificationAccent;
  author?: NotificationAuthor;
  /**
   * Headline. Whether it is rendered as a link to `url` is a function of `kind` (feed, release,
   * incident and purchase titles link; report and alert titles do not), never of this value.
   */
  title: string;
  url?: string;
  /**
   * Free-form markdown body. Whether a body slot is rendered at all is a function of `kind`, not of
   * this value: a `feed` or `release` notification always has a slot (possibly empty), an `incident`
   * never does. Truncation that applies on every platform is content and happens in the service;
   * truncation that applies on one platform is presentation and happens in that platform's renderer.
   */
  body?: string;
  fields?: NotificationField[];
};
