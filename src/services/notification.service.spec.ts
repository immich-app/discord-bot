import { EmbedBuilder } from 'discord.js';
import { Constants, NotificationDestination, NotificationRoutes } from 'src/constants';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { Notification } from 'src/interfaces/notification.interface';
import { NotificationService } from 'src/services/notification.service';
import { Mocked, beforeEach, describe, expect, it, vitest } from 'vitest';

const newDiscordMock = (): Mocked<IDiscordInterface> => ({
  login: vitest.fn(),
  sendMessage: vitest.fn(),
  createEmote: vitest.fn(),
  getEmotes: vitest.fn(),
  setThreadArchived: vitest.fn(),
  createThread: vitest.fn(),
  updateThread: vitest.fn(),
});

const newMattermostMock = (): Mocked<IMattermostInterface> => ({
  init: vitest.fn(),
  registerEventListener: vitest.fn() as any,
  send: vitest.fn(),
  reply: vitest.fn(),
  updatePost: vitest.fn(),
  createEmote: vitest.fn(),
  streamChannels: vitest.fn(),
  joinChannel: vitest.fn(),
  registerCommand: vitest.fn() as any,
  runCommand: vitest.fn(),
  openDialog: vitest.fn(),
  submitDialog: vitest.fn(),
});

/** The routing matrix as it has always been. Every destination is listed so a new or changed route is reviewed here. */
const ExpectedRoutes: Record<
  NotificationDestination,
  { discord?: { channelId: string; crosspost?: true }; mattermost?: { channelId: string; silent?: true } }
> = {
  'community.github-status': { discord: { channelId: DiscordChannel.GithubStatus } },
  'team.github-status': { mattermost: { channelId: Constants.Mattermost.Channels.GithubStatus, silent: true } },
  'community.pull-requests': { discord: { channelId: DiscordChannel.PullRequests } },
  'team.pull-requests': { mattermost: { channelId: Constants.Mattermost.Channels.GithubPullRequests, silent: true } },
  'team.fhs-pull-requests': {
    mattermost: { channelId: Constants.Mattermost.Channels.FHSGithubPullRequests, silent: true },
  },
  'community.issues': { discord: { channelId: DiscordChannel.IssuesAndDiscussions } },
  'team.issues': { mattermost: { channelId: Constants.Mattermost.Channels.GithubIssuesAndDiscussions, silent: true } },
  'community.discussions': { discord: { channelId: DiscordChannel.IssuesAndDiscussions } },
  'team.discussions': {
    mattermost: { channelId: Constants.Mattermost.Channels.GithubIssuesAndDiscussions, silent: true },
  },
  'community.releases': { discord: { channelId: DiscordChannel.Releases, crosspost: true } },
  'community.announcements': { discord: { channelId: DiscordChannel.Announcements, crosspost: true } },
  'team.releases': { mattermost: { channelId: Constants.Mattermost.Channels.GithubReleases, silent: true } },
  'team.fhs-releases': { mattermost: { channelId: Constants.Mattermost.Channels.FHSGithubReleases } },
  'team.purchases': { mattermost: { channelId: Constants.Mattermost.Channels.Purchases } },
  'team.reports': { mattermost: { channelId: Constants.Mattermost.Channels.Purchases } },
  'team.release-alerts': { discord: { channelId: Constants.Discord.Channels.TeamAlerts } },
};

const notification: Notification = {
  kind: 'feed',
  accent: 'pr.opened',
  title: 'Pull request opened',
  url: 'https://example.com/1',
  body: 'Body',
};

describe(NotificationService.name, () => {
  let sut: NotificationService;
  let discordMock: Mocked<IDiscordInterface>;
  let mattermostMock: Mocked<IMattermostInterface>;

  beforeEach(() => {
    discordMock = newDiscordMock();
    mattermostMock = newMattermostMock();
    sut = new NotificationService(discordMock, mattermostMock);
  });

  it('should route every destination exactly as listed', async () => {
    expect(Object.keys(NotificationRoutes).sort()).toEqual(Object.keys(ExpectedRoutes).sort());

    for (const [destination, expected] of Object.entries(ExpectedRoutes) as Array<
      [NotificationDestination, (typeof ExpectedRoutes)[NotificationDestination]]
    >) {
      discordMock = newDiscordMock();
      mattermostMock = newMattermostMock();
      sut = new NotificationService(discordMock, mattermostMock);

      await sut.notify(destination, notification);

      if (expected.discord) {
        expect(discordMock.sendMessage, destination).toHaveBeenCalledOnce();
        const [dto] = discordMock.sendMessage.mock.calls[0];
        expect(dto.channelId, destination).toBe(expected.discord.channelId);
        if (expected.discord.crosspost) {
          expect(dto.crosspost, destination).toBe(true);
        } else {
          expect(dto, destination).not.toHaveProperty('crosspost');
        }
      } else {
        expect(discordMock.sendMessage, destination).not.toHaveBeenCalled();
      }

      if (expected.mattermost) {
        expect(mattermostMock.send, destination).toHaveBeenCalledOnce();
        const [post] = mattermostMock.send.mock.calls[0];
        expect(post.channelId, destination).toBe(expected.mattermost.channelId);
        expect(post.message, destination).toBe('');
        if (expected.mattermost.silent) {
          expect(post.silent, destination).toBe(true);
        } else {
          expect(post, destination).not.toHaveProperty('silent');
        }
      } else {
        expect(mattermostMock.send, destination).not.toHaveBeenCalled();
      }
    }
  });

  it('should send the rendered embed to Discord', async () => {
    await sut.notify('community.pull-requests', notification);

    const [dto] = discordMock.sendMessage.mock.calls[0];
    const { embeds } = dto.message as { embeds: EmbedBuilder[] };
    expect(embeds).toHaveLength(1);
    expect(embeds[0]).toBeInstanceOf(EmbedBuilder);
    expect(embeds[0].toJSON()).toMatchObject({ title: 'Pull request opened', url: 'https://example.com/1' });
  });

  it('should send the rendered block tree to Mattermost', async () => {
    await sut.notify('team.pull-requests', notification);

    const [post] = mattermostMock.send.mock.calls[0];
    expect(post.props).toEqual({
      mm_blocks: [expect.objectContaining({ type: 'container', accent_color: '#57f287', border: true })],
    });
  });

  it('should wait for the Discord send before sending to Mattermost', async () => {
    const order: string[] = [];
    discordMock.sendMessage.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push('discord');
    });
    mattermostMock.send.mockImplementation(async () => {
      order.push('mattermost');
    });

    await sut.notify('community.releases', notification);
    await sut.notify('team.releases', notification);

    expect(order).toEqual(['discord', 'mattermost']);
  });
});
