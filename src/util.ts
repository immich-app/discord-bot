import { Logger } from '@nestjs/common';
import { channelLink, hyperlink } from 'discord.js';
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
