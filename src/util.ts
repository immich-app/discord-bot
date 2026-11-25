import { Logger } from '@nestjs/common';
import { BaseInteraction, channelLink, hyperlink } from 'discord.js';
import { NotificationService } from 'src/services/notification.service';

type Repos = { notifications: NotificationService; logger: Logger };
export const logError = async (message: string, error: unknown, { notifications, logger }: Repos) => {
  logger.error(message, error);
  try {
    await notifications.notify('team.bot', { kind: 'log', title: message, body: `${error}` });
  } catch (error) {
    logger.error('Failed to send error message to bot spam channel', error);
  }
};

type WithErrorOptions<T> = Repos & {
  message: string;
  method: () => Promise<T>;
  fallbackValue: T;
};
export const withErrorLogging = async <T = unknown>(options: WithErrorOptions<T>) => {
  const { message, method, fallbackValue, notifications, logger } = options;
  try {
    return await method();
  } catch (error) {
    await logError(message, error, { notifications, logger });
    return fallbackValue;
  }
};

/**
 * Whether the member who ran an interaction holds a role. Discord sends the member's roles with every guild interaction,
 * as a cached `GuildMemberRoleManager` or the raw API's role IDs, so this needs neither the member cache nor the
 * privileged GuildMembers intent.
 */
export const memberHasRole = (interaction: Pick<BaseInteraction, 'member'>, roleId: string) => {
  const roles = interaction.member?.roles;
  return Array.isArray(roles) ? roles.includes(roleId) : (roles?.cache.has(roleId) ?? false);
};

export const getTotal = ({ server, client }: { server: number; client: number }) => {
  return '$' + (server * 100 + client * 25).toLocaleString();
};

export const makeLicenseFields = ({ server, client }: { server: number; client: number }) => {
  return [
    {
      name: 'Server keys',
      value: `$${(server * 100).toLocaleString()} - ${server.toLocaleString()} keys`,
      inline: true,
    },
    {
      name: 'Client keys',
      value: `$${(client * 25).toLocaleString()} - ${client.toLocaleString()} keys`,
      inline: true,
    },
  ];
};

export const makeOrderFields = ({
  revenue,
  profit,
  message,
}: {
  revenue: number;
  profit: number;
  message?: string;
}) => {
  const fields = [
    { name: 'Revenue', value: `${revenue.toLocaleString()} USD`, inline: true },
    { name: 'Profit', value: `${profit.toLocaleString()} USD`, inline: true },
  ];
  if (message) {
    fields.push({ name: 'Message', value: message, inline: true });
  }
  return fields;
};

export const formatCommand = (name: string, ...args: string[]) => {
  return `\n\`\`\`\n/${name} ${args.join(' ')}\n\`\`\``;
};

export const makeLink = (org: string, repo: string, id: number, url: string) => hyperlink(`${org}/${repo}#${id}`, url);

const PULL_REQUEST_LABEL = '[Pull Request]';
const THREAD_LINK = /, \[Thread\]\(https:\/\/discord\.com\/channels\/[^)]*\)\)$/;

export const makeIssueOrPRMessage = (dto: { type: string; title: string; link: string; discordThreadId?: string }) => {
  const { type, title, link, discordThreadId } = dto;
  const label = type === 'Issue' ? '[Issue]' : PULL_REQUEST_LABEL;

  if (discordThreadId) {
    return `${label} ${title} (${link}, ${hyperlink('Thread', channelLink(discordThreadId))})`;
  }

  return `${label} ${title} (${link})`;
};

/** A title is any GitHub user's text and comes before the link, so only the end of the line is trusted. */
export const isPullRequestLine = (line: string, url: string) =>
  line.startsWith(`${PULL_REQUEST_LABEL} `) &&
  line.replace(THREAD_LINK, ')').toLowerCase().endsWith(`](${url.toLowerCase()}))`);

/** Fewer open pull requests than this are approved one by one, without a command. */
const APPROVE_ALL_MIN_PULL_REQUESTS = 3;

/**
 * A `gh` command per repository, which bash, zsh and fish all run, that approves every pull request given, for whoever
 * reviews them all at once; `undefined` under three of them. Repositories and their pull requests keep the order given.
 */
export const makeApproveAllMessage = (pullRequests: { organization: string; repository: string; number: number }[]) => {
  if (pullRequests.length < APPROVE_ALL_MIN_PULL_REQUESTS) {
    return;
  }

  // `github.com/` pins the host, which a `GH_HOST` naming GitHub Enterprise would otherwise replace.
  const byRepository = Map.groupBy(pullRequests, ({ organization, repository }) => `${organization}/${repository}`);
  // `xargs` rather than a loop, which fish has no `for ...; do ...; done` for.
  const commands = [...byRepository].map(
    ([repository, group]) =>
      `echo ${group.map(({ number }) => number).join(' ')} | xargs -n1 gh pr review -R github.com/${repository} --approve`,
  );

  return [`Approve all ${pullRequests.length} open:`, '```sh', ...commands, '```'].join('\n');
};
