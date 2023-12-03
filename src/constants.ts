export const IMMICH_REPOSITORY_BASE_OPTIONS = { owner: 'immich-app', repo: 'immich' };

const docs = {
  Logs: 'https://immich.app/docs/administration/reverse-proxy',
  ReverseProxy: `https://immich.app/docs/administration/reverse-proxy`,
  Containers: 'https://immich.app/docs/guides/docker-help#containers',
  Queries: `https://immich.app/docs/guides/database-queries`,
  Upgrade: `https://immich.app/docs/install/docker-compose#step-4---upgrading`,
  Libraries: `https://immich.app/docs/features/libraries`,
  Sidecar: `https://immich.app/docs/features/xmp-sidecars`,
  Docker: `https://immich.app/docs/guides/docker-help`,
  Backup: `https://immich.app/docs/administration/backup-and-restore`,
  CLI: `https://immich.app/docs/features/bulk-upload`,
  FAQ: `https://immich.app/docs/FAQ`,
};

const icons = {
  Checked: ':ballot_box_with_check:',
  Unchecked: ':blue_square:',
};

const urls = {
  Immich: 'https://immich.app',
  ImmichRepo: 'https://github.com/immich-app/immich',
  GitHub: 'https://github.com',
  FeatureRequest: 'https://github.com/immich-app/immich/discussions/new?category=feature-request',
  Issues: 'https://github.com/immich-app/immich/issues',
  GitHubRepoApi: 'https://api.github.com/repos/immich-app/immich',
  GoogleTakeOut: 'https://github.com/immich-app/immich/discussions/1340',
  Release: 'https://github.com/immich-app/immich/releases/latest',
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

const channels = {
  HelpDesk: '1049703391762321418',
  General: '994044917355663450',
  BotSpam: '1159083520027787307',
};

const misc = {
  ImmichBirthdayCron: '36 4 3 2 *',
};

export const Constants = {
  Misc: misc,
  Urls: {
    Docs: docs,
    ...urls,
  },
  Icons: icons,
  Channels: channels,
  Roles: roles,
  Tags: tags,
};
