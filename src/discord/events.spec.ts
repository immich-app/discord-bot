import { MessageFlags } from 'discord.js';
import { ArgsOf } from 'discordx';
import { Constants } from 'src/constants';
import { DiscordEvents } from 'src/discord/events';
import { ApprovalService } from 'src/services/approval.service';
import { ChatService } from 'src/services/chat.service';
import { beforeEach, describe, expect, it, Mocked, vitest } from 'vitest';

const PARENT = '100000000000000001';
const THREAD = '200000000000000001';
const REPLY = '300000000000000002';
const NITTER_REPLY = '300000000000000003';

const pullRequests = [
  { organization: 'immich-app', repository: 'immich', number: 1234 },
  { organization: 'immich-app', repository: 'immich', number: 5678 },
];
const parts = ['[Pull Request] Fix (immich-app/immich#1234)', '[Pull Request] Add (immich-app/immich#5678)'];
const nitterLinks = ['https://nitter.net/immich/status/1'];

const flags = [MessageFlags.SuppressEmbeds, MessageFlags.SuppressNotifications];

const newMessage = ({ bot = false, dm = false } = {}) => ({
  content: 'see #1234 and #5678',
  author: { bot },
  channel: { id: THREAD, parentId: PARENT, isDMBased: () => dm },
  member: { roles: { cache: new Map([[Constants.Discord.Roles.Team, {}]]) } },
  reply: vitest
    .fn()
    .mockResolvedValueOnce({ id: REPLY, channelId: THREAD })
    .mockResolvedValueOnce({ id: NITTER_REPLY, channelId: THREAD }),
});

describe(DiscordEvents.name, () => {
  let sut: DiscordEvents;
  let chat: Mocked<
    Pick<ChatService, 'handleGithubReferences' | 'handleTwitterReferences' | 'handleTaggingOfPullRequestThreads'>
  >;
  let approvals: Mocked<Pick<ApprovalService, 'track'>>;

  const onMessageCreate = (message: ReturnType<typeof newMessage>) =>
    sut.onMessageCreate([message] as unknown as ArgsOf<'messageCreate'>);

  beforeEach(() => {
    chat = {
      handleGithubReferences: vitest.fn().mockResolvedValue({ parts, pullRequests }),
      handleTwitterReferences: vitest.fn().mockResolvedValue([]),
      handleTaggingOfPullRequestThreads: vitest.fn(),
    };
    approvals = { track: vitest.fn() };
    sut = new DiscordEvents(chat as unknown as ChatService, approvals as unknown as ApprovalService);
  });

  describe('onMessageCreate', () => {
    it('should reply with the expansions and track the reply with the pull requests it names', async () => {
      const message = newMessage();

      await onMessageCreate(message);

      expect(chat.handleGithubReferences).toHaveBeenCalledExactlyOnceWith(
        { content: 'see #1234 and #5678', channelParentId: PARENT },
        true,
      );
      expect(message.reply).toHaveBeenCalledExactlyOnceWith({ content: parts.join('\n'), flags });
      expect(approvals.track).toHaveBeenCalledExactlyOnceWith(
        { service: 'discord', channelId: THREAD, messageId: REPLY },
        pullRequests,
      );
    });

    it.each([
      { what: 'a message that expands to nothing', message: { bot: false, dm: false }, expands: false },
      { what: "a bot's message", message: { bot: true, dm: false }, expands: true },
      { what: 'a direct message', message: { bot: false, dm: true }, expands: true },
    ])('should neither reply nor track for $what', async ({ message: options, expands }) => {
      const message = newMessage(options);
      if (!expands) {
        chat.handleGithubReferences.mockResolvedValue({ parts: [], pullRequests: [] });
      }

      await onMessageCreate(message);

      expect(message.reply).not.toHaveBeenCalled();
      expect(approvals.track).not.toHaveBeenCalled();
    });

    it('should reply with the nitter links of a message that names nothing on GitHub, without tracking it', async () => {
      const message = newMessage();
      chat.handleGithubReferences.mockResolvedValue({ parts: [], pullRequests: [] });
      chat.handleTwitterReferences.mockResolvedValue(nitterLinks);

      await onMessageCreate(message);

      expect(message.reply).toHaveBeenCalledExactlyOnceWith({ content: nitterLinks.join('\n'), flags });
      expect(approvals.track).not.toHaveBeenCalled();
    });

    it('should still post the nitter reply when tracking fails, and reject', async () => {
      const message = newMessage();
      const failure = new Error('database down');
      chat.handleTwitterReferences.mockResolvedValue(nitterLinks);
      approvals.track.mockRejectedValue(failure);

      await expect(onMessageCreate(message)).rejects.toBe(failure);

      expect(message.reply.mock.calls).toEqual([
        [{ content: parts.join('\n'), flags }],
        [{ content: nitterLinks.join('\n'), flags }],
      ]);
      expect(approvals.track).toHaveBeenCalledExactlyOnceWith(
        { service: 'discord', channelId: THREAD, messageId: REPLY },
        pullRequests,
      );
    });

    it('should still post the nitter reply when the GitHub reply fails, and reject without tracking', async () => {
      const message = newMessage();
      const failure = new Error('Missing Permissions');
      message.reply
        .mockReset()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ id: NITTER_REPLY, channelId: THREAD });
      chat.handleTwitterReferences.mockResolvedValue(nitterLinks);

      await expect(onMessageCreate(message)).rejects.toBe(failure);

      expect(message.reply.mock.calls).toEqual([
        [{ content: parts.join('\n'), flags }],
        [{ content: nitterLinks.join('\n'), flags }],
      ]);
      expect(approvals.track).not.toHaveBeenCalled();
    });

    it('should still track the GitHub reply when the nitter reply fails, and reject', async () => {
      const message = newMessage();
      const failure = new Error('Unknown message');
      message.reply.mockReset().mockResolvedValueOnce({ id: REPLY, channelId: THREAD }).mockRejectedValueOnce(failure);
      chat.handleTwitterReferences.mockResolvedValue(nitterLinks);

      await expect(onMessageCreate(message)).rejects.toBe(failure);

      expect(message.reply).toHaveBeenCalledTimes(2);
      expect(approvals.track).toHaveBeenCalledExactlyOnceWith(
        { service: 'discord', channelId: THREAD, messageId: REPLY },
        pullRequests,
      );
    });
  });
});
