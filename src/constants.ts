import { DiscordChannel } from 'src/interfaces/discord.interface';

export enum DiscordModal {
  Env = 'envModal',
  Logs = 'logsModal',
  Compose = 'composeModal',
}

export enum DiscordButton {
  Submit = 'submit',
  OpenTicket = 'openTicket',
}

export enum DiscordField {
  Env = 'env',
  Logs = 'logs',
  Source = 'source',
}

export enum GithubRepo {
  Immich = 'immich',
  StaticPages = 'static-pages',
}

export enum GithubOrg {
  ImmichApp = 'immich-app',
}

export const IMMICH_REPOSITORY_BASE_OPTIONS = { owner: 'immich-app', repo: 'immich' };

const docs = {
  Backup: 'https://immich.app/docs/administration/backup-and-restore',
  CLI: 'https://immich.app/docs/features/command-line-interface',
  Containers: 'https://immich.app/docs/guides/docker-help#containers',
  Docker: 'https://immich.app/docs/guides/docker-help',
  FAQ: 'https://immich.app/docs/FAQ',
  Libraries: 'https://immich.app/docs/features/libraries',
  Logs: 'https://immich.app/docs/guides/docker-help#logs',
  Queries: 'https://immich.app/docs/guides/database-queries',
  ReverseProxy: 'https://immich.app/docs/administration/reverse-proxy',
  Sidecar: 'https://immich.app/docs/features/xmp-sidecars',
  Upgrade: 'https://immich.app/docs/install/docker-compose#step-4---upgrading',
};

const icons = {
  Checked: ':ballot_box_with_check:',
  Immich: '<:immich:1216750773598294066>',
  Unchecked: ':blue_square:',
};

const urls = {
  FeatureRequest: 'https://github.com/immich-app/immich/discussions/new?category=feature-request',
  GitHub: 'https://github.com',
  GitHubRepoApi: 'https://api.github.com/repos/immich-app/immich',
  GoogleTakeOut: 'https://github.com/immich-app/immich/discussions/1340',
  Immich: 'https://immich.app',
  ImmichRepo: 'https://github.com/immich-app/immich',
  Issues: 'https://github.com/immich-app/immich/issues',
  MyImmich: 'https://my.immich.app',
  Release: 'https://github.com/immich-app/immich/discussions?discussions_q=label%3Abreaking-change+sort%3Adate_created',
};

const tags = {
  Question: '1049704189686730823',
  Ready: '1166852154292699207',
  Setup: '1049704231692677120',
  Usage: '1049704247517794315',
};

const roles = {
  Contributor: '980972470964215870',
};

export const Constants = {
  Urls: {
    Docs: docs,
    ...urls,
  },
  Icons: icons,
  Roles: roles,
  Tags: tags,
  Cron: {
    ImmichBirthday: '36 4 3 2 *',
    DailyReport: '0 12 * * *',
    WeeklyReport: '0 12 * * 4',
  },
};

export const linkCommands: Record<string, string> = {
  'reverse proxy': Constants.Urls.Docs.ReverseProxy,
  database: Constants.Urls.Docs.Queries,
  upgrade: Constants.Urls.Docs.Upgrade,
  libraries: Constants.Urls.Docs.Libraries,
  'xmp sidecar': Constants.Urls.Docs.Sidecar,
  docker: Constants.Urls.Docs.Docker,
  backup: Constants.Urls.Docs.Backup,
  github: Constants.Urls.ImmichRepo,
  cli: Constants.Urls.Docs.CLI,
  'google-takeout': Constants.Urls.GoogleTakeOut,
  faq: Constants.Urls.Docs.FAQ,
};

export const HELP_TEXTS = {
  'docker logs': `View container logs by running \`docker compose logs\`. For further information refer to ${Constants.Urls.Docs.Docker}`,
  'help ticket': `Please open a <#${DiscordChannel.HelpDesk}> ticket with more information and we can help you troubleshoot the issue.`,
  'reverse proxy': `This sounds like it could be a reverse proxy issue. Here's a link to the relevant documentation page: ${Constants.Urls.Docs.ReverseProxy}.`,
  'feature request': `For ideas or features you'd like Immich to have, feel free to [open a feature request in the Github discussions](${Constants.Urls.FeatureRequest}). However, please make sure to search for similar requests first to avoid duplicates.`,
};
