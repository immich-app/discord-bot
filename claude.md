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

Located in `src/migrations/` with naming pattern `{timestamp}-{description}.ts`. Each exports `up()` and `down()` functions using Kysely schema builder. Migrations run automatically on module init via `DatabaseService.runMigrations()`.

### Adding a New Database Table

1. Create migration in `src/migrations/{timestamp}-{name}.ts`
2. Add table type + Selectable/Insertable/Updateable types in `src/interfaces/database.interface.ts`
3. Add table to the `Database` interface
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

## Commands

```
npm run build        # Build with nest
npm run check        # TypeScript type check
npm run lint         # ESLint
npm run format       # Prettier check
npm run test         # Vitest
npm run check:all    # format + lint + check + test:cov
```

## Key Files

- `src/app.module.ts` - Root NestJS module
- `src/main.ts` - Bootstrap, Discord client init
- `src/config.ts` - Environment variable loading
- `src/constants.ts` - Enums, channel IDs, role IDs, cron expressions
- `src/discord/commands.ts` - All slash commands
- `src/discord/events.ts` - Discord event handlers
- `src/services/discord.service.ts` - Core bot logic
- `src/interfaces/database.interface.ts` - DB schema types + repository interface
- `src/repositories/database.repository.ts` - Kysely DB queries
