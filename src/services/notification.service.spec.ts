import { Logger } from '@nestjs/common';
import { EmbedBuilder } from 'discord.js';
import { Constants, NotificationDestination, NotificationRoutes } from 'src/constants';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';
import { IMattermostInterface } from 'src/interfaces/mattermost.interface';
import { Notification, NotificationKind } from 'src/interfaces/notification.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';
import { toZulipMessage } from 'src/renderers/zulip.renderer';
import { NotificationService, toNotificationTarget } from 'src/services/notification.service';
import { MockInstance, Mocked, afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

vitest.mock('src/renderers/zulip.renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/renderers/zulip.renderer')>();
  return { ...actual, toZulipMessage: vitest.fn(actual.toZulipMessage) };
});

const newDiscordMock = (): Mocked<IDiscordInterface> => ({
  login: vitest.fn(),
  isReady: vitest.fn().mockReturnValue(true),
  onHandlerError: vitest.fn(),
  sendMessage: vitest.fn(),
  createEmote: vitest.fn(),
  getEmotes: vitest.fn(),
  setThreadArchived: vitest.fn(),
  createThread: vitest.fn(),
  updateThread: vitest.fn(),
});

const newMattermostMock = (): Mocked<IMattermostInterface> => ({
  isInitialised: vitest.fn().mockReturnValue(true),
  init: vitest.fn(),
  registerEventListener: vitest.fn() as any,
  send: vitest.fn(),
  reply: vitest.fn(),
  updatePost: vitest.fn(),
  createEmote: vitest.fn(),
  listEmoji: vitest.fn(),
  streamChannels: vitest.fn(),
  joinChannel: vitest.fn(),
  registerCommand: vitest.fn() as any,
  runCommand: vitest.fn(),
  openDialog: vitest.fn(),
  submitDialog: vitest.fn(),
});

const newZulipMock = (): Mocked<IZulipInterface> => ({
  init: vitest.fn(),
  isInitialised: vitest.fn().mockReturnValue(true),
  sendMessage: vitest.fn().mockResolvedValue({ id: 1 }),
  sendDirectMessage: vitest.fn(),
  createEmote: vitest.fn(),
  getMessage: vitest.fn(),
  updateMessage: vitest.fn(),
  listEmoji: vitest.fn(),
  getSubscriptions: vitest.fn(),
  getOwnUser: vitest.fn(),
  getUser: vitest.fn(),
  getStream: vitest.fn(),
  getMessages: vitest.fn(),
  registerQueue: vitest.fn(),
  getEvents: vitest.fn(),
  deleteQueue: vitest.fn(),
  deleteMessage: vitest.fn(),
  uploadFile: vitest.fn(),
  downloadUpload: vitest.fn(),
  getStreamMessagesBefore: vitest.fn(),
  getEmojiCodes: vitest.fn(),
  addReaction: vitest.fn(),
  removeReaction: vitest.fn(),
});

const { ImmichThirdParties, ImmichAlerts } = Constants.Zulip.Streams;

/** The routing matrix as it has always been. Every destination is listed so a new or changed route is reviewed here. */
const ExpectedRoutes: Record<
  NotificationDestination,
  {
    discord?: { channelId: string; crosspost?: true };
    mattermost?: { channelId: string; silent?: true };
    zulip?: { stream: number; topic: string };
  }
> = {
  'community.github-status': { discord: { channelId: DiscordChannel.GithubStatus } },
  'team.github-status': {
    mattermost: { channelId: Constants.Mattermost.Channels.GithubStatus, silent: true },
    zulip: { stream: ImmichThirdParties, topic: 'github status' },
  },
  'community.pull-requests': { discord: { channelId: DiscordChannel.PullRequests } },
  'team.pull-requests': {
    mattermost: { channelId: Constants.Mattermost.Channels.GithubPullRequests, silent: true },
    zulip: { stream: ImmichThirdParties, topic: 'pull requests' },
  },
  'team.fhs-pull-requests': {
    mattermost: { channelId: Constants.Mattermost.Channels.FHSGithubPullRequests, silent: true },
  },
  'community.issues': { discord: { channelId: DiscordChannel.IssuesAndDiscussions } },
  'team.issues': {
    mattermost: { channelId: Constants.Mattermost.Channels.GithubIssuesAndDiscussions, silent: true },
    zulip: { stream: ImmichThirdParties, topic: 'issues' },
  },
  'community.discussions': { discord: { channelId: DiscordChannel.IssuesAndDiscussions } },
  'team.discussions': {
    mattermost: { channelId: Constants.Mattermost.Channels.GithubIssuesAndDiscussions, silent: true },
    zulip: { stream: ImmichThirdParties, topic: 'discussions' },
  },
  'community.releases': { discord: { channelId: DiscordChannel.Releases, crosspost: true } },
  'community.announcements': { discord: { channelId: DiscordChannel.Announcements, crosspost: true } },
  'team.releases': {
    mattermost: { channelId: Constants.Mattermost.Channels.GithubReleases, silent: true },
    zulip: { stream: ImmichThirdParties, topic: 'releases' },
  },
  'team.fhs-releases': { mattermost: { channelId: Constants.Mattermost.Channels.FHSGithubReleases } },
  'team.purchases': {
    mattermost: { channelId: Constants.Mattermost.Channels.Purchases },
    zulip: { stream: ImmichThirdParties, topic: 'purchases' },
  },
  'team.reports': {
    mattermost: { channelId: Constants.Mattermost.Channels.Purchases },
    zulip: { stream: ImmichThirdParties, topic: 'reports' },
  },
  'team.release-alerts': {
    discord: { channelId: Constants.Discord.Channels.TeamAlerts },
    zulip: { stream: ImmichAlerts, topic: 'release workflow' },
  },
  'team.bot': {
    discord: { channelId: DiscordChannel.BotSpam },
    zulip: { stream: ImmichAlerts, topic: 'bot' },
  },
};

const destinations = Object.keys(ExpectedRoutes) as NotificationDestination[];

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
  let zulipMock: Mocked<IZulipInterface>;
  let loggerMock: MockInstance;
  let fatalMock: MockInstance;

  beforeEach(() => {
    discordMock = newDiscordMock();
    mattermostMock = newMattermostMock();
    zulipMock = newZulipMock();
    sut = new NotificationService(discordMock, mattermostMock, zulipMock);
    loggerMock = vitest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    fatalMock = vitest.spyOn(Logger.prototype, 'fatal').mockImplementation(() => {});
  });

  afterEach(() => {
    vitest.restoreAllMocks();
    // `restoreAllMocks` only touches spies; the module mock keeps its calls and once-implementations otherwise.
    vitest.mocked(toZulipMessage).mockReset();
  });

  describe('routes', () => {
    it('should route every destination exactly as listed', async () => {
      expect(Object.keys(NotificationRoutes).sort()).toEqual(destinations.sort());

      for (const destination of destinations) {
        const expected = ExpectedRoutes[destination];
        discordMock = newDiscordMock();
        mattermostMock = newMattermostMock();
        zulipMock = newZulipMock();
        sut = new NotificationService(discordMock, mattermostMock, zulipMock);

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

        if (expected.zulip) {
          expect(zulipMock.sendMessage, destination).toHaveBeenCalledOnce();
          const [payload] = zulipMock.sendMessage.mock.calls[0];
          expect(payload.stream, destination).toBe(expected.zulip.stream);
          expect(payload.topic, destination).toBe(expected.zulip.topic);
        } else {
          expect(zulipMock.sendMessage, destination).not.toHaveBeenCalled();
        }
      }
    });

    it('should route every team destination except FHS to Zulip, and no community destination', () => {
      for (const destination of destinations) {
        const { zulip } = NotificationRoutes[destination] as { zulip?: unknown };
        if (destination.startsWith('community.') || destination.startsWith('team.fhs-')) {
          expect(zulip, destination).toBeUndefined();
        } else {
          expect(zulip, destination).toBeDefined();
        }
      }
    });

    it('should send team notifications to the third parties channel and alerts to the alerts channel', () => {
      expect(Constants.Zulip.Streams).toEqual({
        Immich: 54,
        FUTOStaff: 2,
        ImmichThirdParties: 111,
        ImmichPullRequests: 112,
        ImmichAlerts: 113,
      });
      for (const destination of destinations) {
        const { zulip } = NotificationRoutes[destination] as { zulip?: { stream: number } };
        if (zulip) {
          const alerts = destination === 'team.release-alerts' || destination === 'team.bot';
          expect(zulip.stream, destination).toBe(alerts ? 113 : 111);
        }
      }
    });
  });

  describe('rendering', () => {
    it('should send the rendered embed to Discord', async () => {
      await sut.notify('community.pull-requests', notification);

      const [dto] = discordMock.sendMessage.mock.calls[0];
      const { embeds } = dto.message as { embeds: EmbedBuilder[] };
      expect(embeds).toHaveLength(1);
      expect(embeds[0]).toBeInstanceOf(EmbedBuilder);
      expect(embeds[0].toJSON()).toMatchObject({ title: 'Pull request opened', url: 'https://example.com/1' });
    });

    it('should send a log line to Discord and Zulip as plain text', async () => {
      await sut.notify('team.bot', { kind: 'log', title: 'Discord bot error', body: 'Error: boom' });

      expect(discordMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        channelId: DiscordChannel.BotSpam,
        message: 'Discord bot error: Error: boom',
      });
      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        stream: 113,
        topic: 'bot',
        content: 'Discord bot error:\n~~~ quote\nError: boom\n~~~',
      });
    });

    it('should send the rendered block tree to Mattermost', async () => {
      await sut.notify('team.pull-requests', notification);

      const [post] = mattermostMock.send.mock.calls[0];
      expect(post.props).toEqual({
        mm_blocks: [expect.objectContaining({ type: 'container', accent_color: '#57f287', border: true })],
      });
    });

    it('should send the rendered markdown to the routed Zulip channel and topic', async () => {
      await sut.notify('team.pull-requests', notification);

      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage).toHaveBeenCalledWith({
        stream: 111,
        topic: 'pull requests',
        content: '🆕 **[Pull request opened](https://example.com/1)**\n~~~ quote\nBody\n~~~',
      });
    });
  });

  describe('fan-out', () => {
    it('should post to every routed platform', async () => {
      await sut.notify('team.releases', notification);
      await sut.notify('team.release-alerts', notification);

      expect(discordMock.sendMessage).toHaveBeenCalledOnce();
      expect(mattermostMock.send).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('should send Discord first, then Mattermost, then Zulip, waiting for each', async () => {
      const order: string[] = [];
      discordMock.sendMessage.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        order.push('discord');
      });
      mattermostMock.send.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push('mattermost');
      });
      zulipMock.sendMessage.mockImplementation(async () => {
        order.push('zulip');
        return { id: 1 };
      });

      await sut.notify('community.releases', notification);
      await sut.notify('team.releases', notification);
      await sut.notify('team.release-alerts', notification);

      expect(order).toEqual(['discord', 'mattermost', 'zulip', 'discord', 'zulip']);
    });

    it('should skip Zulip silently when it is not initialised', async () => {
      zulipMock.isInitialised.mockReturnValue(false);

      await expect(sut.notify('team.releases', notification)).resolves.toBeUndefined();

      expect(mattermostMock.send).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      expect(loggerMock).not.toHaveBeenCalled();
      expect(fatalMock).not.toHaveBeenCalled();
    });

    it('should skip Mattermost silently when it is not configured', async () => {
      mattermostMock.isInitialised.mockReturnValue(false);

      await expect(sut.notify('team.releases', notification)).resolves.toBeUndefined();

      expect(mattermostMock.send).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
      expect(loggerMock).not.toHaveBeenCalled();
      expect(fatalMock).not.toHaveBeenCalled();
    });

    it('should skip Discord silently while it is not ready', async () => {
      discordMock.isReady.mockReturnValue(false);

      await expect(
        sut.notify('team.bot', { kind: 'log', title: 'Failed', body: 'Error: boom' }),
      ).resolves.toBeUndefined();

      expect(discordMock.sendMessage).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
      expect(loggerMock).not.toHaveBeenCalled();
      expect(fatalMock).not.toHaveBeenCalled();
    });

    it('should not render for a skipped platform', async () => {
      zulipMock.isInitialised.mockReturnValue(false);

      await sut.notify('team.release-alerts', { kind: 'alert', title: 'T' });

      expect(discordMock.sendMessage).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      expect(toZulipMessage).not.toHaveBeenCalled();
    });

    it('should render each platform just before its own send, in platform order', async () => {
      const order: string[] = [];
      vitest.mocked(toZulipMessage).mockImplementationOnce((n) => {
        order.push('render zulip');
        return `rendered ${n.title}`;
      });
      discordMock.sendMessage.mockImplementation(async () => {
        order.push('send discord');
      });
      zulipMock.sendMessage.mockImplementation(async () => {
        order.push('send zulip');
        return { id: 1 };
      });

      await sut.notify('team.release-alerts', notification);

      expect(order).toEqual(['send discord', 'render zulip', 'send zulip']);
      expect(zulipMock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'rendered Pull request opened' }),
      );
    });
  });

  describe('failure isolation', () => {
    it('should keep posting to Zulip when Mattermost fails, log it and resolve', async () => {
      mattermostMock.send.mockRejectedValue(new Error('mattermost down'));

      await expect(sut.notify('team.releases', notification)).resolves.toBeUndefined();

      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
      expect(loggerMock).toHaveBeenCalledOnce();
      expect(loggerMock.mock.calls[0][0]).toBe('Could not notify team.releases on mattermost: Error: mattermost down');
      expect(fatalMock).not.toHaveBeenCalled();
    });

    it('should keep posting to Zulip when Discord fails, log it and resolve', async () => {
      discordMock.sendMessage.mockRejectedValue(new Error('discord down'));

      await expect(sut.notify('team.release-alerts', notification)).resolves.toBeUndefined();

      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
      expect(loggerMock).toHaveBeenCalledOnce();
      expect(loggerMock.mock.calls[0][0]).toBe('Could not notify team.release-alerts on discord: Error: discord down');
      expect(fatalMock).not.toHaveBeenCalled();
    });

    it('should keep the Mattermost post when Zulip fails, log it and resolve', async () => {
      zulipMock.sendMessage.mockRejectedValue(new Error('zulip down'));

      await expect(sut.notify('team.purchases', notification)).resolves.toBeUndefined();

      expect(mattermostMock.send).toHaveBeenCalledOnce();
      expect(loggerMock).toHaveBeenCalledOnce();
      expect(loggerMock.mock.calls[0][0]).toBe('Could not notify team.purchases on zulip: Error: zulip down');
      expect(fatalMock).not.toHaveBeenCalled();
    });

    it('should resolve, log each failure and one fatal line when every routed platform fails', async () => {
      mattermostMock.send.mockRejectedValue(new Error('mattermost down'));
      zulipMock.sendMessage.mockRejectedValue(new Error('zulip down'));

      await expect(sut.notify('team.issues', notification)).resolves.toBeUndefined();

      expect(loggerMock.mock.calls.map(([message]) => message)).toEqual([
        'Could not notify team.issues on mattermost: Error: mattermost down',
        'Could not notify team.issues on zulip: Error: zulip down',
      ]);
      expect(fatalMock).toHaveBeenCalledOnce();
      expect(fatalMock).toHaveBeenCalledWith('Could not notify team.issues on any platform: notification dropped');
    });

    it('should resolve and log when the only routed platform fails', async () => {
      discordMock.sendMessage.mockRejectedValue(new Error('discord down'));

      await expect(sut.notify('community.pull-requests', notification)).resolves.toBeUndefined();

      expect(loggerMock).toHaveBeenCalledOnce();
      expect(loggerMock.mock.calls[0][0]).toBe(
        'Could not notify community.pull-requests on discord: Error: discord down',
      );
      expect(fatalMock).toHaveBeenCalledOnce();
      expect(fatalMock).toHaveBeenCalledWith(
        'Could not notify community.pull-requests on any platform: notification dropped',
      );
    });

    it('should resolve and log when Zulip is skipped and Mattermost fails', async () => {
      zulipMock.isInitialised.mockReturnValue(false);
      mattermostMock.send.mockRejectedValue(new Error('mattermost down'));

      await expect(sut.notify('team.releases', notification)).resolves.toBeUndefined();

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      expect(loggerMock).toHaveBeenCalledOnce();
      expect(fatalMock).toHaveBeenCalledOnce();
    });

    it('should still attempt every platform after a failure', async () => {
      mattermostMock.send.mockRejectedValue(new Error('mattermost down'));
      zulipMock.sendMessage.mockRejectedValue(new Error('zulip down'));

      await sut.notify('team.reports', notification);

      expect(mattermostMock.send).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
    });

    it('should let a Discord outage through to the team post that the webhook handler makes next', async () => {
      discordMock.sendMessage.mockRejectedValue(new Error('discord down'));

      await sut.notify('community.pull-requests', notification);
      await sut.notify('team.pull-requests', notification);

      expect(discordMock.sendMessage).toHaveBeenCalledOnce();
      expect(mattermostMock.send).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage).toHaveBeenCalledOnce();
      expect(fatalMock).toHaveBeenCalledOnce();
    });

    it('should let a renderer error propagate rather than log it as a platform failure', async () => {
      const broken = { kind: 'no-such-kind' as NotificationKind, title: 'T' };

      await expect(sut.notify('team.pull-requests', broken)).rejects.toBeInstanceOf(TypeError);

      expect(loggerMock).not.toHaveBeenCalled();
      expect(fatalMock).not.toHaveBeenCalled();
      expect(mattermostMock.send).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should let a Zulip renderer error propagate without undoing the Discord post before it', async () => {
      vitest.mocked(toZulipMessage).mockImplementationOnce(() => {
        throw new TypeError('zulip renderer bug');
      });

      await expect(sut.notify('team.release-alerts', notification)).rejects.toThrow('zulip renderer bug');

      expect(discordMock.sendMessage).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      expect(loggerMock).not.toHaveBeenCalled();
      expect(fatalMock).not.toHaveBeenCalled();
    });

    it('should let a Zulip renderer error propagate without undoing the Mattermost post before it', async () => {
      vitest.mocked(toZulipMessage).mockImplementationOnce(() => {
        throw new TypeError('zulip renderer bug');
      });

      await expect(sut.notify('team.pull-requests', notification)).rejects.toThrow('zulip renderer bug');

      expect(mattermostMock.send).toHaveBeenCalledOnce();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      expect(loggerMock).not.toHaveBeenCalled();
      expect(fatalMock).not.toHaveBeenCalled();
    });
  });

  describe('notifyTarget', () => {
    const rss: Notification = { kind: 'rss', title: 'Post', url: 'https://example.com/post', body: 'Summary' };

    it('should send the rendered embed to the Discord channel, and resolve true', async () => {
      await expect(sut.notifyTarget({ platform: 'discord', channelId: '123' }, rss)).resolves.toBe(true);

      expect(discordMock.sendMessage).toHaveBeenCalledOnce();
      const [dto] = discordMock.sendMessage.mock.calls[0];
      expect(dto).toStrictEqual({ channelId: '123', message: { embeds: [expect.any(EmbedBuilder)] } });
      expect((dto.message as { embeds: EmbedBuilder[] }).embeds[0].toJSON()).toMatchObject({
        title: 'Post',
        url: 'https://example.com/post',
        description: 'Summary',
      });
      expect(mattermostMock.send).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should resolve false and send nothing to Mattermost when it is not configured', async () => {
      mattermostMock.isInitialised.mockReturnValue(false);

      await expect(sut.notifyTarget({ platform: 'mattermost', channelId: 'town-square' }, rss)).resolves.toBe(false);

      expect(mattermostMock.send).not.toHaveBeenCalled();
    });

    it('should send the rendered block tree to the Mattermost channel, and resolve true', async () => {
      await expect(sut.notifyTarget({ platform: 'mattermost', channelId: 'town-square' }, rss)).resolves.toBe(true);

      expect(mattermostMock.send).toHaveBeenCalledExactlyOnceWith({
        channelId: 'town-square',
        message: '',
        props: { mm_blocks: [expect.objectContaining({ type: 'container' })] },
      });
      expect(discordMock.sendMessage).not.toHaveBeenCalled();
      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
    });

    it('should send the rendered markdown to the Zulip stream and topic, and resolve true', async () => {
      await expect(sut.notifyTarget({ platform: 'zulip', stream: 107, topic: 'blog' }, rss)).resolves.toBe(true);

      expect(zulipMock.sendMessage).toHaveBeenCalledExactlyOnceWith({
        stream: 107,
        topic: 'blog',
        content: '**[Post](https://example.com/post)**\n~~~ quote\nSummary\n~~~',
      });
      expect(discordMock.sendMessage).not.toHaveBeenCalled();
      expect(mattermostMock.send).not.toHaveBeenCalled();
    });

    it('should skip Zulip without rendering or logging when it is not initialised, and resolve false', async () => {
      zulipMock.isInitialised.mockReturnValue(false);

      await expect(sut.notifyTarget({ platform: 'zulip', stream: 107, topic: 'blog' }, rss)).resolves.toBe(false);

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      expect(toZulipMessage).not.toHaveBeenCalled();
      expect(loggerMock).not.toHaveBeenCalled();
    });

    it('should skip Discord without logging while it is not ready, and resolve false', async () => {
      discordMock.isReady.mockReturnValue(false);

      await expect(sut.notifyTarget({ platform: 'discord', channelId: '123' }, rss)).resolves.toBe(false);

      expect(discordMock.sendMessage).not.toHaveBeenCalled();
      expect(loggerMock).not.toHaveBeenCalled();
    });

    it.each([
      ['discord', { platform: 'discord', channelId: '123' }, 'channel 123', () => discordMock.sendMessage],
      ['mattermost', { platform: 'mattermost', channelId: 'c1' }, 'channel c1', () => mattermostMock.send],
      [
        'zulip',
        { platform: 'zulip', stream: 107, topic: 'blog' },
        'stream 107, topic "blog"',
        () => zulipMock.sendMessage,
      ],
    ] as const)(
      'should log a failed %s send with its target, resolve false and never reject',
      async (platform, target, label, send) => {
        send().mockRejectedValue(new Error('down'));

        await expect(sut.notifyTarget(target, rss)).resolves.toBe(false);

        expect(loggerMock).toHaveBeenCalledOnce();
        expect(loggerMock.mock.calls[0][0]).toBe(`Could not notify ${label} on ${platform}: Error: down`);
        expect(fatalMock).not.toHaveBeenCalled();
      },
    );

    it('should let a renderer error propagate rather than log it as a platform failure', async () => {
      vitest.mocked(toZulipMessage).mockImplementationOnce(() => {
        throw new TypeError('zulip renderer bug');
      });

      await expect(sut.notifyTarget({ platform: 'zulip', stream: 107, topic: 'blog' }, rss)).rejects.toThrow(
        'zulip renderer bug',
      );

      expect(zulipMock.sendMessage).not.toHaveBeenCalled();
      expect(loggerMock).not.toHaveBeenCalled();
    });
  });

  describe('toNotificationTarget', () => {
    it('should address a Discord or Mattermost row by its channel', () => {
      expect(toNotificationTarget({ service: 'discord', channelId: '123', topic: null })).toStrictEqual({
        platform: 'discord',
        channelId: '123',
      });
      expect(toNotificationTarget({ service: 'mattermost', channelId: 'c1', topic: null })).toStrictEqual({
        platform: 'mattermost',
        channelId: 'c1',
      });
    });

    it('should read a Zulip row channel as the stream ID, and a missing topic as the empty one', () => {
      expect(toNotificationTarget({ service: 'zulip', channelId: '107', topic: 'blog' })).toStrictEqual({
        platform: 'zulip',
        stream: 107,
        topic: 'blog',
      });
      expect(toNotificationTarget({ service: 'zulip', channelId: '107', topic: null })).toStrictEqual({
        platform: 'zulip',
        stream: 107,
        topic: '',
      });
    });
  });
});
