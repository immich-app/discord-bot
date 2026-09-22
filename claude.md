# Discord Bot

Immich Discord bot built with NestJS, discordx, and PostgreSQL (Kysely ORM).

## Tech Stack

- **Runtime**: Node.js (24.x), TypeScript, CommonJS
- **Framework**: NestJS with `@nestjs/schedule` for cron jobs
- **Discord**: discord.js + discordx (decorator-based slash commands, events, modals, buttons)
- **Database**: PostgreSQL via Kysely (type-safe query builder), file-based migrations
- **Testing**: Vitest with manual mocks (no test database)
- **Build**: `nest build` (SWC compiler), `eslint`, `prettier`

## Architecture

### Layers

1. **Discord layer** (`src/discord/`) - Slash commands, events, help-desk, context menus. These are `@Discord()` + `@Injectable()` NestJS classes that use discordx decorators (`@Slash`, `@On`, `@ModalComponent`, `@ButtonComponent`).
2. **Service layer** (`src/services/`) - Business logic. Injected into discord layer. Services use `@Inject(ITokenName)` for repository dependencies.
3. **Repository layer** (`src/repositories/`) - External integrations (database, Discord API, GitHub, Zulip, RSS, etc). Each has an interface in `src/interfaces/` with a string token (`export const IFoo = 'IFoo'`).
4. **Interface layer** (`src/interfaces/`) - Defines repository contracts and Kysely table types. The `Database` type in `database.interface.ts` maps table names to their column types.
5. **Renderer layer** (`src/renderers/`) - Pure functions, no DI, one module per chat platform. Each turns a platform-neutral `Notification` into that platform's wire shape (`toDiscordEmbed`, `toMattermostBlock`, `toZulipMessage`). Consumed only by `NotificationService`; services never import a renderer, and no renderer imports another.

### Dependency Injection

Repositories are provided via NestJS DI tokens in `src/repositories/index.ts`:
```ts
{ provide: IDatabaseRepository, useClass: DatabaseRepository }
```
Services inject them with `@Inject(IDatabaseRepository)`.

### Registration

- **Services**: Listed in `src/services/index.ts` → imported into `AppModule`
- **Repositories/Providers**: Listed in `src/repositories/index.ts` → imported into `AppModule`
- **Discord classes**: Listed directly in `AppModule` (`DiscordCommands`, `DiscordEvents`, `DiscordHelpDesk`, `DiscordContextMenus`)

### Database Migrations

Located in `src/schema/migrations/` with naming pattern `{timestamp}-{description}.ts`. Each exports `up()` and `down()` functions running raw SQL through Kysely. Migrations run automatically on module init via `DatabaseService.runMigrations()`, so every migration must be safe on a populated table.

Tables are declared with `@immich/sql-tools` decorators in `src/schema/tables/`, and a migration is generated from the difference between those declarations and a database that is at the current schema: `npm run build`, then `DB_URL=postgres://... npm run migrations:generate`. The generator writes `src/{timestamp}-Migration.ts`; move it into `src/schema/migrations/` under a descriptive name. To verify one, boot the compiled app once against a scratch database (`uri` in the environment) and check the schema.

### Adding a New Database Table

1. Declare the table in `src/schema/tables/{name}.table.ts` and generate the migration (see above)
2. Add Selectable/Insertable/Updateable types in `src/schema/index.ts`
3. Add table to the `Database` interface there
4. Add repository methods to `IDatabaseRepository` interface
5. Implement methods in `src/repositories/database.repository.ts`

### Adding a New Slash Command

Commands live in `src/discord/commands.ts`. Use discordx decorators:
- `@Slash({ name, description })` on method
- `@SlashOption({...})` for parameters
- `@SlashChoice(...)` for enum choices
- Autocomplete: set `autocomplete: true` on option, check `interaction.isAutocomplete()` in handler

### Auth Guard

Legacy commands use `authGuard()` to restrict to allowed channels (BotSpam, SupportCrew, QQ). **New commands should NOT use `authGuard`** — permissions will be configured via Discord's built-in command permissions UI instead.

### Cron Jobs

Use `@Cron(expression)` decorator from `@nestjs/schedule`. Cron expressions stored in `Constants.Cron`.

### Notifications

Anything posted to a chat channel as a card (GitHub events, GitHub status incidents, purchases, reports, release alerts) goes through one seam. A service never names a platform in a notification path.

1. The service builds a `Notification` (`src/interfaces/notification.interface.ts`): a required `kind` (`feed`, `release`, `incident`, `purchase`, `report`, `alert`), an optional domain-namespaced `accent` (`pr.merged`, `issue.closed`, `order.cancelled`, ...), plus `author`, `title`, `url`, `body` and `fields`.
2. The service calls `NotificationService.notify(destination, notification)` with a logical destination such as `community.releases` or `team.purchases`. Destinations are audience-scoped: `community.*` is public, `team.*` is internal. Business rules like "a private repo skips the community" are expressed by choosing destinations, not platforms.
3. `NotificationRoutes` in `src/constants.ts` maps every destination to the platforms and channels it reaches, including per-route `silent` (Mattermost), `crosspost` (Discord) and `topic` (Zulip). A destination with no route for a platform simply does not post there. The whole matrix is reviewable in that one table. Today every `team.*` destination except the FHS ones reaches Zulip (stream `ImmichThirdParties`, one topic per subject; `team.release-alerts` goes to `ImmichAlerts`); `community.*` destinations are Discord only.
4. `NotificationService` (`src/services/notification.service.ts`) renders the notification once per routed platform with that platform's renderer and sends it, Discord first, then Mattermost, then Zulip, one platform at a time.

Delivery policy, covered by `notification.service.spec.ts`:

- **Unconfigured platforms are skipped.** A Zulip route is attempted only when `zulip.isInitialised()` (the same notion `ZulipRepository` throws on: `init` never ran because the `dev` sentinel keys skipped it). Local dev therefore never throws on team notifications. Discord and Mattermost are always configured.
- **A platform outage never rejects.** A platform that fails does not stop the ones after it, and `notify` resolves even when every attempted platform failed. Each failure is logged as an `error` with the destination and platform; when no platform took the notification, one `fatal` line (`Could not notify <destination> on any platform: notification dropped`) says so. `src/main.ts` enables the `fatal` level for that reason.
  - The trade-off: a webhook now answers success even if every chat post failed, and the log is the only place a dropped notification shows.
  - The alternative, rejecting on a total failure, silences Zulip whenever Discord is down. The handlers post one event to several destinations in sequence (`await notify('community.pull-requests')`, then `await notify('team.pull-requests')`), and `community.*` destinations route to Discord alone, so the first call's rejection would skip the team post and Zulip with it. That is worse now that Zulip is the team's primary platform, and it cannot be fixed in the services, which this seam keeps unchanged.
- **Rendering is not a platform failure.** Each platform's payload is rendered immediately before that platform's own send, in platform order and outside the isolation above. A renderer bug propagates to the caller as the programming error it is instead of being logged as an outage, and a bug in a later platform's renderer cannot undo the posts already made before it. Nothing is rendered for a skipped platform.

Rules that keep the seam clean:

- Renderers derive every layout decision (title size, whether a body slot exists, truncation, fields layout, author style, whether the title links) from `kind`, never from which keys a notification has or what its values are: a feed title links even when its `url` is `''`. Services never pass render options. Only whether an existing slot is *filled* depends on the data: a `feed` always has a body slot, which renders empty when there is no body.
- Truncation that applies on every platform is content and belongs in the service (feed bodies are shortened to 500 before rendering). Truncation that applies on one platform is presentation and belongs in that renderer (release descriptions are shortened to 500 on Mattermost only).
- An accent token names the event at its call site, never a colour. `src/renderers/palette.ts` maps tokens to RGB numbers; the Discord and Mattermost renderers read it. Zulip has no colours, so `src/renderers/zulip.renderer.ts` keeps its own token-to-emoji table (`Emoji`) chosen by what the token means, not by the colour it shares. Several tokens sharing a colour or an emoji is expected.
- `webhook.service.ts` and `schedule.service.ts` never call `discord.sendMessage` or `mattermost.send` for a notification. The Zulip release announcement in `handleReleaseNotification` and the pull request topic messages in `handlePullRequestZulipTopic` are bespoke plain-text messages, not `Notification`s, and stay direct calls, exactly as the Discord forum-thread messages in `handlePullRequestTeamUpdate` do.

### Adding a New Notification Platform

1. Add `src/renderers/{platform}.renderer.ts`: a pure `to{Platform}Message(notification: Notification)` that switches on `kind` for layout and maps `accent` to the platform's affordance (read `Palette` for a colour, or keep a token-to-emoji table for a platform without colours). Do not import another renderer or `discord.js`, directly or through `src/util` (which depends on it); string helpers such as `shorten` and `asHexColor` come from `src/format.ts`, as do the Zulip markdown guards (`neutraliseZulipMentions`, `toZulipQuote`), which live there rather than in the renderer because the bespoke PR-topic messages in `webhook.service.ts` need them too and a service never imports a renderer.
2. Add an optional `{platform}` entry to `NotificationRoute` and fill in the routes in `NotificationRoutes` (`src/constants.ts`). Destinations that share a channel today (issues and discussions, purchases and reports) are separate on purpose so they can land in different places; on Zulip they already are.
3. Inject the platform's repository interface into `NotificationService` and add a `deliver` call in `notify`, after the platforms already there, when the destination has a route for it (and the platform is configured, if it can be unconfigured). `deliver` takes a render thunk and a send and handles the lazy rendering, logging and failure isolation.

Nothing in `webhook.service.ts` or `schedule.service.ts` should change.

### Zulip

The bot talks to Zulip through a typed `openapi-fetch` client, not an SDK.

- **Generated types**: `src/generated/zulip.ts` is generated from Zulip's OpenAPI spec and must never be edited by hand; it is excluded from prettier and eslint. Regenerate it with `npm run zulip:types`. That script in `package.json` is the only place the Zulip release tag is pinned; bump it there when the server is upgraded, rerun the script and commit the output.
- **Transport**: `src/repositories/zulip.client.ts` builds a `Client<paths>` per identity (`createZulipClient`). Its rules, all covered by `zulip.client.spec.ts`:
  - Base URL is `${ZULIP_DOMAIN}/api/v1`; a realm ending in `/` or `/api` is normalised.
  - Every request body is sent `application/x-www-form-urlencoded`, which is what the spec declares for every endpoint we call (`POST /messages`, later `PATCH /messages/{id}` and `POST /register`). Strings go as they are; `number`, `boolean`, arrays and objects are `JSON.stringify`'d; `undefined` is omitted. Query strings follow the same rule, so an array such as `narrow` becomes one JSON value, never repeated keys. A parameter the spec declares as a JSON-encoded *string* (`narrow` and `message_ids` on `GET /messages` are typed `string`) is passed already stringified.
  - Multipart (`POST /realm/emoji/{emoji_name}`): spread `multipart({ field: file })` into the call. Every part is a `File`, so it carries a filename with an extension and a content type; `fetch` sets the boundary. Do not set `Content-Type` yourself.
  - Every call rejects with `ZulipApiError` (`status`, `code`, `msg`) on a non-2xx response or a `result: "error"` body, so `data` is always set when a call resolves. Network errors and timeouts reject too; every request has a timeout.
  - A `429` is retried after the body's `retry-after` (falling back to the `Retry-After` header), with a bounded attempt count and a bounded maximum wait; the retried request re-sends its body. Nothing else is retried: a 429 was not processed, but retrying a 5xx on `POST /messages` could double-post.
  - Credentials and the `Authorization` header are never logged.
- **Two identities**: `ZulipRepository` holds a `bot` client (posts messages) and a `user` client (uploads emoji) because Zulip only lets human accounts upload emoji (`This endpoint does not accept bot requests`). Config keeps `zulip.bot` and `zulip.user` for that reason. Both are created once, in `ZulipService.init` (skipped with the `dev` sentinel keys); calling a repository method before that throws `Zulip client not initialised`.
- **Endpoints**: `ZulipRepository` exposes only what the bot uses today: `sendMessage` (resolves to the new message's `{ id }`), `getMessage` (the message's ID and *current* topic, asked with `allow_empty_topic_name` so the empty "general chat" topic comes back as `''` rather than as the realm's translated display name), `updateMessage` (`PATCH /messages/{id}`: a content edit or a topic move with a `propagateMode`, never both in one call, which Zulip rejects), `createEmote`, `listEmoji` (`GET /realm/emoji`, deactivated ones included), `getSubscriptions` (the bot's streams), and `isInitialised`, which `NotificationService` checks before routing to Zulip. Each phase adds only the endpoints it needs, a few lines each thanks to the generated types; do not add unused methods.
- **Streams**: `Constants.Zulip.Streams` holds channels by numeric ID, named after the channel (`ImmichThirdParties: 111` carries every team notification, `ImmichPullRequests: 112` one topic per pull request, `ImmichAlerts: 113` the release workflow alerts). IDs survive a rename; the dev server mirrors the names but not the IDs. Topic strings live in `NotificationRoutes`, not here.
- **Startup subscription check**: those three are private streams, and Zulip lets an unsubscribed bot post to public streams only. The bot is a plain member and cannot subscribe itself to a private stream, so `ZulipService.init` fetches its subscriptions right after the clients exist and logs one `warn` per stream in `Constants.Zulip.RequiredSubscriptions` it is missing, naming the stream. It never throws and never self-subscribes: a missing subscription is visible at deploy time instead of failing the first post at 3am, and it must not stop the bot from booting. `RequiredSubscriptions` lists those three and not `FUTOStaff` (2), where the holiday notice has posted since before the check existed: whether that stream is public or the bot was subscribed by hand, its subscription is not one the deploy needs to prove, so it is not asserted on a guess.
- **Renderer**: `toZulipMessage` (`src/renderers/zulip.renderer.ts`) flattens a `Notification` into one message of Zulip markdown. `zulip.renderer.spec.ts` pins all of the following.
  - *Shape*: `{emoji} **[title](url)** — [author](url)`, then the body, then the fields. A `line` field (every kind but `incident`) is one `**name:** value` line; a `block` field (`incident`) is a bold name line with the value quoted beneath it.
  - *Feed bodies are quoted*: a GitHub markdown body goes inside a tilde quote fence so its headings and lists stay subordinate to the title. Zulip closes a fence on a line equal to the opening one, so the fence is always one tilde longer than the longest tilde run inside it and no line can close it; a backtick fence or a shorter tilde run just opens a nested block inside the quote. An incident field value is multi-line prose and gets the same quote.
  - *Release bodies are inline*: a release body is one of the one-line `ReleaseMessages` slogans or nothing, never the release notes. Its 500-character cap mirrors Mattermost's and is insurance that never fires today.
  - *Zulip markdown only*: Zulip renders only `*`/`**` emphasis (no `_` forms), treats a single newline as a line break and shows an unknown `:name:` literally, so the renderer emits Unicode emoji characters and nothing Discord-only.
  - *Nothing in a notification was written for Zulip*: titles and bodies come from any GitHub user, order messages from any buyer, incident text from GitHub Status, and Zulip has no backslash escaping. So the renderer neutralises instead of escaping, with a zero-width space where a character must be broken up (it renders invisibly and matches no Zulip syntax) and with containment where a value must stay in its slot:
    - `neutraliseMentions` puts a zero-width space after the sigil of every `@**user**`, `@_**user**`, `@*group*` and `#**stream**` in every interpolated string, quoted body included. Nobody can ping the channel through a notification.
    - `neutraliseLabel` also runs over the title and author name, which are interpolated into the heading's `[label](url)`. Python-Markdown accepts a link only when `(` or `[` directly follows the closing `]`, so it puts a zero-width space between exactly those pairs, `](` and `][`, and touches no other `]`. An issue titled `Crash](https://evil) [` degrades the heading to plain text instead of repointing its link, while `[owner/repo]` and `Fix [BUG] thumbnails` read, copy and search as written. Bodies and field values are not link labels and keep their `](`, so an alert body's own `[text](url)` still links.
    - A field value cannot leave its slot. A `line` value shares a line with its name, so its line breaks become spaces (a field name's too, in either layout): nothing in a merch order message ever starts a line, so it can open no fence, heading or list and cannot pose as the next field. A `block` value is quoted like a feed body, with the same fence rule.
    - Other markup in those strings renders as markdown, which can only garble a heading or a line, never notify anyone, forge a link or escape a slot.

### Zulip pull request topics

The Zulip analogue of the `#team-pull-requests` Discord forum: one topic per public `immich-app/immich` PR in stream 112, kept by `WebhookService.handlePullRequestZulipTopic`. It mirrors `handlePullRequestTeamUpdate`, runs right after it whether or not it succeeded, and never changes it: the Discord path is pinned by its characterization tests and stays byte-identical. `handlePullRequestTeamPlatforms` settles the Discord path, runs the Zulip path, then rethrows the Discord rejection as the same object, so a Discord outage or rate limit cannot leave a topic uncreated or out of sync, and the webhook still answers exactly as it did (Discord's error, Discord's status). Both paths persist on the same `pull_request` row (`discordThreadId`, `zulipMessageId`); a PR may have either, both or neither.

- **Model**: the topic is named `#{number}: {title}`, cut to 58 code points, Zulip's `MAX_TOPIC_NAME_LENGTH` of 60 less the two of the resolved prefix, so that resolving a topic the bot named never overflows the limit (`shortenCodePoints`, never the Discord 100), and trimmed, since Zulip strips a name before storing it. On `opened` (not by a bot, as on Discord) the bot posts one message with the PR link and the body in a quote fence, mentions neutralised, and stores the returned message ID. Zulip has no pin, so the link Discord pins as a second message is folded into the first. Later events post plain notices: `closed` posts merged/closed by whom, then *resolves* the topic (rename to `✔ {topic}` with `propagate_mode: change_all`, Zulip's archiving; the resolved name is sent *untruncated*: a human may have renamed the topic to the full 60, and then the prefix takes it to 62 and Zulip truncates the stored name itself, because Zulip only recognises a resolve when the name it was sent, before its own `...` truncation, is `✔ ` plus the current name, and a pre-truncated name stores the same string as a plain move: no resolved notice, and checked against the move permission and time limit instead of `can_resolve_topics_group`, which is exempt from the limit); `reopened` posts the notice, then unresolves (strips the prefix); `converted_to_draft` posts the notice. Reviews and comments are not echoed there, as on Discord.
- **The message ID is the key, never a topic string.** Topics are mutable strings with no ID: a human may rename or resolve one at any time, and a reply to a stale name silently opens a new, empty topic beside the conversation. So `pull_request` stores only `zulipMessageId`, every event first calls `getMessage` for the topic *as it is now*, and every post and rename is derived from that: the close notice lands in the renamed topic, resolving keeps the human's name (`✔ ` + current), and a topic a human already resolved is not resolved again. A `#{number}: {title}` name is only ever computed for an `opened` post or a title change.
- **Title and body sync** follows the `pull_request.edited` payload's `changes`: `changes.title` renames the topic to the new name (keeping it resolved if it was), `changes.body` edits the first message. Both are separate `updateMessage` calls, because Zulip refuses a content edit and a topic move in one request. An `edited` review or review comment carries `changes` about itself, not the PR, and is ignored before the topic is read, as is a PR edit that changed neither title nor body (`touchesZulipTopic`): those events cost no Zulip call. This is a deliberate departure from the Discord thread, which is renamed to `#{number}: {title}` on every PR and review event: on Zulip the current topic name is the only record of what a human did to it, so a rename on every event would clobber a human rename or resolve on the next label or push, and "a human rename is respected" wins. The cost is that a lost or refused `pull_request.edited` leaves the name stale until the title is edited again; the topic still works, since every post finds it through the message ID, and a human can rename it by hand. Any other event on a PR with a topic reads nothing and posts nothing.
- **Degrading without permissions.** Realm settings can refuse any of this: `message_content_edit_limit_seconds` (default ten minutes) blocks an old message's edit, `move_messages_within_stream_limit_seconds` blocks an old topic's rename, `can_resolve_topics_group` and `can_move_messages_between_topics_group` can block the bot outright. PRs live for weeks, so these will be hit. Every edit, rename and resolve is therefore best effort, and `isZulipRefusal` in `webhook.service.ts` tells a refusal from an outage on `PATCH /messages/{id}`: `MOVE_MESSAGES_TIME_LIMIT_EXCEEDED` (a `change_all` move whose older messages are past the limit) is a refusal by code alone; every other refusal is a `400 BAD_REQUEST`, Zulip's catch-all code, and is told apart by `msg`. The check is a denylist, not an allowlist: a `400 BAD_REQUEST` is a refusal *unless* its `msg` is one of the documented answers that are not (`Nothing to change` and `Topic can't be empty` are programming errors, `Invalid message(s)` is a deleted message; all three are outages). The 12.3 spec's `msg` enum for the endpoint cannot be used as an allowlist: it lists the content-edit refusals only, with a stale typo (`has past` where the 12.3 server sends `The time limit for editing this message has passed`), and none of the move refusals the server raises (`You don't have permission to resolve topics in this channel.`, `The time limit for editing this message's topic has passed.`, `You don't have permission to move this message`). So an unknown or translated refusal degrades to the fallback message, never to a lost notice, and the strings are not pinned to the Zulip version. The empty topic name (Zulip's "general chat") cannot be resolved, so a PR topic a human moved there gets its notices, posted with `topic: ''` (valid since Zulip 10), and no rename. A refused rename or resolve is logged once as a `warn` and answered with a plain message in the topic that could not be moved (`Pull request has been renamed to: …`, `The topic could not be resolved automatically: <Zulip's reason>`, likewise for unresolving), so the information is not lost; a fallback post that fails in its turn is logged as an `error` and cannot reject either. A refused body edit is logged and nothing more: the body is on GitHub. Any other failure (a 5xx, a timeout, a rate limit that outlasted the client's retries, a topic that cannot be read) is an outage, logged as an `error` without a fallback message, since that post would fail too. One read failure is not an outage: `GET /messages/{id}` answering `400 BAD_REQUEST` *with* the `msg` `Invalid message(s)` means the stored first message was deleted or is no longer visible to the bot, and retrying that ID on every later event would lose every notice forever. `isZulipMessageGone` requires both: `BAD_REQUEST` is Zulip's catch-all and it has no distinct code for a missing message, so the documented text is the only thing that tells it from a transient or permission failure, and the failure direction is deliberate: if Zulip rewords it, the read counts as an outage and the update is skipped (safe, the next event retries the same ID) rather than opening a second topic and overwriting the key (a permanent split). `readOrRebuildZulipTopic` then logs a `warn`, posts the first message again under the PR's current `#{number}: {title}`, stores the new ID and carries on with the event in that topic (the close notice and the resolve land there). If the topic still exists with other messages under another name, the rebuild opens a new topic beside it: the key is gone, so there is nothing better to do, and a human can move the messages together. Nothing in the Zulip path can reject: `handlePullRequestZulipTopic` catches everything, so a blocked edit never fails the GitHub webhook, and the Discord path has already run by then; a Discord rejection is held and rethrown only after the Zulip path, so it cannot stop it either. Its catch tells a Zulip failure (`isZulipFailure`: a `ZulipApiError`, undici's `fetch failed`, the client's timeout; logged as `Zulip failed while updating the topic of pull request #N`) from anything else (`Unexpected error while updating the Zulip topic of pull request #N`), so an outage and a bug are not triaged from the same line. Zulip not being initialised (local dev) skips the path entirely.

### Emote sync

`/emote-sync` (`ChatService.syncEmotes`) uploads every Discord emote to Zulip and Mattermost. The Mattermost side takes the Discord name as it is. The Zulip side does not:

- **Names**: the 12.3 spec for `POST /realm/emoji/{emoji_name}` says a name can only contain letters, numbers, dashes and spaces, that upper and lower case are treated the same and that underscores are treated the same as spaces. `toZulipEmojiName` in `chat.service.ts` implements that documented rule: lowercase (case is one name to Zulip, so the sync must settle on one spelling to compare with `listEmoji()`), every other character becomes `_` (the `identifier` fallback for a nameless emote carries a `:`), a trailing run of `_`/`-` is dropped because the server refuses a name ending in one (`Emoji names must end with either a letter or digit.`, which the spec's description leaves out), and an empty result falls back to `emote`. A dot is outside the documented set and is not relied on.
- **Collisions**: two Discord emotes can normalise to one name (`catJAM` and `CatJam`). `claimZulipEmojiName` appends `2`, `3`, … in Discord order, deciding the suffix from the run alone, so it comes out the same on every sync. The reply lists renames (`nameless:3 → nameless_3`, `CatJam → catjam2`); a change of case only is not reported, since Zulip does not tell the two apart.
- **Idempotency**: before uploading, the sync reads `listEmoji()` and skips any name that an active realm emoji already holds, counting it as already synced and listing it by Discord name (`N already on Zulip: catJAM, CatJam → catjam2, …`). That is what makes a second sync a no-op instead of re-uploading `catjam` as `catjam2`, `catjam3`, … on every run; a deactivated emoji frees its name. The corollary is that an emoji a human uploaded by hand under a name a Discord emote normalises to is taken to be that emote and is never duplicated or suffixed: the sync cannot tell its own uploads from a human's (that would take the uploading account's user ID, an endpoint it does not have), so it chooses idempotence and makes the shadowing visible in the reply instead. If the listing itself fails, the Zulip side of the whole run is skipped, logged once and said once in the reply (`Zulip skipped: its emoji could not be listed`) rather than blamed on each emote; Mattermost still syncs and its failures are still listed. The reply stays within Discord's 2000 characters.

## Commands

```
npm run build        # Build with nest
npm run check        # TypeScript type check
npm run lint         # ESLint
npm run format       # Prettier check
npm run test         # Vitest
npm run check:all    # format + lint + check + test:cov
npm run zulip:types  # Regenerate src/generated/zulip.ts from the pinned Zulip OpenAPI spec
```

## Key Files

- `src/app.module.ts` - Root NestJS module
- `src/main.ts` - Bootstrap, Discord client init
- `src/config.ts` - Environment variable loading
- `src/constants.ts` - Enums, channel IDs, role IDs, cron expressions, notification route table (`NotificationRoutes`)
- `src/format.ts` - String helpers with no platform imports (`shorten`, `shortenCodePoints`, `asHexColor`, and the Zulip markdown guards `neutraliseZulipMentions` and `toZulipQuote`); the only helper module renderers may import
- `src/util.ts` - Discord-aware helpers (error logging to bot-spam, hyperlinks, report field builders)
- `src/discord/commands.ts` - All slash commands
- `src/discord/events.ts` - Discord event handlers
- `src/services/discord.service.ts` - Core bot logic
- `src/interfaces/database.interface.ts` - DB schema types + repository interface
- `src/repositories/database.repository.ts` - Kysely DB queries
- `src/interfaces/notification.interface.ts` - Platform-neutral `Notification` model (`kind`, `accent`, `author`, `title`, `url`, `body`, `fields`)
- `src/services/notification.service.ts` - Destination-to-platform fan-out for notifications
- `src/renderers/` - Per-platform `Notification` renderers (`discord`, `mattermost`, `zulip`) and the shared accent palette
- `src/generated/zulip.ts` - Generated Zulip API types (`npm run zulip:types`), never edited by hand
- `src/repositories/zulip.client.ts` - Typed Zulip transport: form/JSON encoding, multipart, errors, 429 retry, timeout
