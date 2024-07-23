import { DiscordChannel } from 'src/interfaces/discord.interface';

export const IMMICH_REPOSITORY_BASE_OPTIONS = { owner: 'immich-app', repo: 'immich' };

const docs = {
  Logs: 'https://immich.app/docs/guides/docker-help#logs',
  ReverseProxy: 'https://immich.app/docs/administration/reverse-proxy',
  Containers: 'https://immich.app/docs/guides/docker-help#containers',
  Queries: 'https://immich.app/docs/guides/database-queries',
  Upgrade: 'https://immich.app/docs/install/docker-compose#step-4---upgrading',
  Libraries: 'https://immich.app/docs/features/libraries',
  Sidecar: 'https://immich.app/docs/features/xmp-sidecars',
  Docker: 'https://immich.app/docs/guides/docker-help',
  Backup: 'https://immich.app/docs/administration/backup-and-restore',
  CLI: 'https://immich.app/docs/features/command-line-interface',
  FAQ: 'https://immich.app/docs/FAQ',
};

const icons = {
  Checked: ':ballot_box_with_check:',
  Unchecked: ':blue_square:',
  Immich: '<:immich:1216750773598294066>',
};

const urls = {
  Immich: 'https://immich.app',
  ImmichRepo: 'https://github.com/immich-app/immich',
  GitHub: 'https://github.com',
  FeatureRequest: 'https://github.com/immich-app/immich/discussions/new?category=feature-request',
  Issues: 'https://github.com/immich-app/immich/issues',
  GitHubRepoApi: 'https://api.github.com/repos/immich-app/immich',
  GoogleTakeOut: 'https://github.com/immich-app/immich/discussions/1340',
  Release: 'https://github.com/immich-app/immich/discussions?discussions_q=label%3Abreaking-change+sort%3Adate_created',
  Discussions: 'https://github.com/immich-app/immich/discussions',
};

const tags = {
  Question: '1049704189686730823',
  Setup: '1049704231692677120',
  Usage: '1049704247517794315',
  Ready: '1166852154292699207',
};

const roles = {
  Contributor: '980972470964215870',
};

const cron = {
  ImmichBirthday: '36 4 3 2 *',
};

export const Constants = {
  Urls: {
    Docs: docs,
    ...urls,
  },
  Icons: icons,
  Roles: roles,
  Tags: tags,
  Cron: cron,
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
