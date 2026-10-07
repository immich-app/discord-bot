import { Logger } from '@nestjs/common';
import { Constants } from 'src/constants';
import { IDatabaseRepository, PullRequestExpansionWithCount } from 'src/interfaces/database.interface';
import { DiscordMirrorError, IDiscordMirrorInterface } from 'src/interfaces/discord-mirror.interface';
import { IZulipInterface, ZulipReceivedMessage } from 'src/interfaces/zulip.interface';
import { ZulipApiError } from 'src/repositories/zulip.client';
import { ApprovalService, markPullRequestLines, PullRequestReviewEvent } from 'src/services/approval.service';
import { makeIssueOrPRMessage, makeLink } from 'src/util';
import { afterEach, beforeEach, describe, expect, it, Mocked, vitest } from 'vitest';

const newDatabaseMock = (): Mocked<
  Pick<IDatabaseRepository, 'createPullRequestExpansions' | 'getPullRequestExpansions' | 'removePullRequestExpansions'>
> => ({
  createPullRequestExpansions: vitest.fn(),
  getPullRequestExpansions: vitest.fn().mockResolvedValue([]),
  removePullRequestExpansions: vitest.fn(),
});

const newDiscordMock = (): Mocked<
  Pick<IDiscordMirrorInterface, 'isReady' | 'getEmotes' | 'getBotMessageContent' | 'editBotMessage'>
> => ({
  isReady: vitest.fn().mockReturnValue(true),
  getEmotes: vitest.fn(),
  getBotMessageContent: vitest.fn(),
  editBotMessage: vitest.fn(),
});

const newZulipMock = (): Mocked<IZulipInterface> => ({
  init: vitest.fn(),
  isInitialised: vitest.fn().mockReturnValue(true),
  sendMessage: vitest.fn(),
  sendDirectMessage: vitest.fn(),
  createEmote: vitest.fn(),
  replaceCroppedEmote: vitest.fn(),
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
  getMessagesByIds: vitest.fn(),
  getEmojiCodes: vitest.fn(),
  addReaction: vitest.fn(),
  removeReaction: vitest.fn(),
});

const pullRequestUrl = (number: number) => `https://github.com/immich-app/immich/pull/${number}`;

const pullRequestLine = (number: number, title = 'feat: add thing') =>
  makeIssueOrPRMessage({
    type: 'PullRequest',
    title,
    link: makeLink('immich-app', 'immich', number, pullRequestUrl(number)),
  });

const issueLine = makeIssueOrPRMessage({
  type: 'Issue',
  title: 'Upload fails',
  link: makeLink('immich-app', 'immich', 6969, 'https://github.com/immich-app/immich/issues/6969'),
});
const gitlabLine = '[Merge Request] Fix (grayjay/kick#1234)';
const nitterLine = 'https://nitter.net/immich/status/1234';

const SUBMITTED_AT = '2026-10-05T12:00:00Z';

const reviewEvent = ({
  action = 'submitted',
  state = 'approved',
  user = { login: 'mertalev', type: 'User' } as { login: string; type: string } | null,
  submittedAt = SUBMITTED_AT as string | null,
  number = 1234,
} = {}) =>
  ({
    action,
    repository: { full_name: 'Immich-App/Immich', name: 'Immich', owner: { login: 'Immich-App' } },
    pull_request: { number },
    review: { id: 1, state, user, submitted_at: submittedAt },
  }) as unknown as PullRequestReviewEvent;

const expansion = (
  messageId: string,
  overrides: Partial<PullRequestExpansionWithCount> = {},
): PullRequestExpansionWithCount => ({
  service: 'zulip',
  messageId,
  organization: 'immich-app',
  repository: 'immich',
  number: 1234,
  channelId: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  pullRequestCount: 1,
  ...overrides,
});

const zulipMessage = (id: number, content: string): ZulipReceivedMessage => ({
  id,
  senderId: 99,
  senderEmail: 'fubot-bot@zulip.example.com',
  senderFullName: 'FUBot',
  type: 'stream',
  streamId: 107,
  topic: 'thumbnails',
  content,
  timestamp: 1_700_000_000,
});

const APPROVED2 = { id: '77', name: 'approved2', deactivated: false };

const THREAD = '200000000000000001';
const EMOTE = '1300000000000000077';

const discordExpansion = (messageId: string, overrides: Partial<PullRequestExpansionWithCount> = {}) =>
  expansion(messageId, { service: 'discord', channelId: THREAD, ...overrides });

const emote = (overrides: { id?: string; name?: string | null; identifier?: string; animated?: boolean } = {}) => ({
  id: EMOTE,
  identifier: `APPROVED:${EMOTE}`,
  name: 'APPROVED',
  url: `https://cdn.discordapp.com/emojis/${EMOTE}.png`,
  animated: false,
  ...overrides,
});

describe('markPullRequestLines', () => {
  it('should leave a line shaped like the pull request inside a code snippet as written, and mark the real one', () => {
    const content = ['```ts', pullRequestLine(1234), '```', pullRequestLine(1234)].join('\n');

    expect(markPullRequestLines(content, pullRequestUrl(1234), ':approved2:')).toBe(
      ['```ts', pullRequestLine(1234), '```', `:approved2: ${pullRequestLine(1234)}`].join('\n'),
    );
  });

  it('should mark nothing when the only line shaped like the pull request is inside a code snippet', () => {
    expect(
      markPullRequestLines(['```', pullRequestLine(1234), '```'].join('\n'), pullRequestUrl(1234), ':approved2:'),
    ).toBeUndefined();
  });

  it.each([
    {
      what: "only the pull request's line among other lines, leaving them byte-identical",
      content: [pullRequestLine(1), issueLine, pullRequestLine(1234), gitlabLine, nitterLine].join('\n'),
      expected: [pullRequestLine(1), issueLine, `:approved2: ${pullRequestLine(1234)}`, gitlabLine, nitterLine].join(
        '\n',
      ),
    },
    {
      what: 'both lines of a pull request rendered twice',
      content: [pullRequestLine(1234), pullRequestLine(1234, 'FEAT: ADD THING')].join('\n'),
      expected: [
        `:approved2: ${pullRequestLine(1234)}`,
        `:approved2: ${pullRequestLine(1234, 'FEAT: ADD THING')}`,
      ].join('\n'),
    },
    {
      what: "the line of the pull request, not another one's whose title quotes its link",
      content: [
        pullRequestLine(5, `Follow-up to ${makeLink('immich-app', 'immich', 1234, pullRequestUrl(1234))}`),
        pullRequestLine(1234),
      ].join('\n'),
      expected: [
        pullRequestLine(5, `Follow-up to ${makeLink('immich-app', 'immich', 1234, pullRequestUrl(1234))}`),
        `:approved2: ${pullRequestLine(1234)}`,
      ].join('\n'),
    },
    {
      what: 'nothing when its line is marked already',
      content: [`:approved2: ${pullRequestLine(1234)}`, pullRequestLine(1)].join('\n'),
      expected: undefined,
    },
    { what: 'nothing when no line is about it', content: [issueLine, nitterLine].join('\n'), expected: undefined },
  ])('should mark $what', ({ content, expected }) => {
    expect(markPullRequestLines(content, pullRequestUrl(1234), ':approved2:')).toBe(expected);
  });
});

describe(ApprovalService.name, () => {
  let sut: ApprovalService;
  let databaseMock: ReturnType<typeof newDatabaseMock>;
  let zulipMock: Mocked<IZulipInterface>;
  let discordMock: ReturnType<typeof newDiscordMock>;
  let messages: Map<number, string>;
  let discordMessages: Map<string, string>;

  const approve = async (event = reviewEvent()) => {
    sut.handleReview(event);
    await sut.whenIdle();
  };

  beforeEach(() => {
    databaseMock = newDatabaseMock();
    zulipMock = newZulipMock();
    messages = new Map();
    zulipMock.getMessagesByIds.mockImplementation((ids) =>
      Promise.resolve(ids.filter((id) => messages.has(id)).map((id) => zulipMessage(id, messages.get(id)!))),
    );
    zulipMock.updateMessage.mockImplementation((id, { content }) => {
      messages.set(id, content!);
      return Promise.resolve();
    });
    zulipMock.listEmoji.mockResolvedValue([{ id: '76', name: 'approved', deactivated: false }, APPROVED2]);
    discordMock = newDiscordMock();
    discordMessages = new Map();
    discordMock.getBotMessageContent.mockImplementation((channelId, messageId) =>
      Promise.resolve(discordMessages.get(`${channelId}/${messageId}`)),
    );
    discordMock.editBotMessage.mockImplementation((channelId, messageId, content) => {
      discordMessages.set(`${channelId}/${messageId}`, content);
      return Promise.resolve();
    });
    discordMock.getEmotes.mockResolvedValue([emote({ id: '1300000000000000076', name: 'approved' }), emote()]);
    sut = new ApprovalService(
      databaseMock as unknown as IDatabaseRepository,
      zulipMock,
      discordMock as unknown as IDiscordMirrorInterface,
    );
    for (const level of ['debug', 'warn', 'error'] as const) {
      vitest.spyOn(Logger.prototype, level).mockImplementation(() => {});
    }
  });

  afterEach(() => {
    vitest.restoreAllMocks();
    vitest.useRealTimers();
  });

  describe('track', () => {
    it("should record each pull request of a reply under the reply's IDs, the owner and name lowercased", async () => {
      await sut.track({ service: 'zulip', messageId: '901', channelId: null }, [
        { organization: 'Immich-App', repository: 'Immich', number: 1234 },
        { organization: 'futo-org', repository: 'grayjay', number: 7 },
      ]);

      expect(databaseMock.createPullRequestExpansions).toHaveBeenCalledExactlyOnceWith([
        {
          service: 'zulip',
          messageId: '901',
          channelId: null,
          organization: 'immich-app',
          repository: 'immich',
          number: 1234,
        },
        {
          service: 'zulip',
          messageId: '901',
          channelId: null,
          organization: 'futo-org',
          repository: 'grayjay',
          number: 7,
        },
      ]);
    });

    it('should record nothing for a reply that names no pull request', async () => {
      await sut.track({ service: 'zulip', messageId: '901', channelId: null }, []);

      expect(databaseMock.createPullRequestExpansions).not.toHaveBeenCalled();
    });
  });

  describe('handleReview', () => {
    it.each([
      { what: 'an edited review', event: reviewEvent({ action: 'edited' }) },
      { what: 'a dismissed review', event: reviewEvent({ action: 'dismissed' }) },
      { what: 'a comment', event: reviewEvent({ state: 'commented' }) },
      { what: 'a request for changes', event: reviewEvent({ state: 'changes_requested' }) },
      { what: "a bot's approval", event: reviewEvent({ user: { login: 'futo-kritika[bot]', type: 'Bot' } }) },
      { what: 'an approval without a user', event: reviewEvent({ user: null }) },
      { what: 'an approval without a submission time', event: reviewEvent({ submittedAt: null }) },
    ])('should mark nothing for $what', async ({ event }) => {
      await approve(event);

      expect(databaseMock.getPullRequestExpansions).not.toHaveBeenCalled();
    });

    it('should count an approval whose state is in upper case', async () => {
      await approve(reviewEvent({ state: 'APPROVED' }));

      expect(databaseMock.getPullRequestExpansions).toHaveBeenCalledOnce();
    });

    it('should log a failing database read and still run the next approval', async () => {
      const failure = new Error('database down');
      databaseMock.getPullRequestExpansions.mockRejectedValueOnce(failure);
      databaseMock.getPullRequestExpansions.mockResolvedValueOnce([expansion('902', { number: 5678 })]);
      messages.set(902, pullRequestLine(5678));

      sut.handleReview(reviewEvent());
      await approve(reviewEvent({ number: 5678 }));

      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        'approvals: approval of Immich-App/Immich#1234 failed',
        failure,
      );
      expect(messages.get(902)).toBe(`:approved2: ${pullRequestLine(5678)}`);
    });
  });

  describe('on Zulip', () => {
    it('should mark the line of the pull request in each reply posted before the approval', async () => {
      const other = [issueLine, nitterLine].join('\n');
      messages.set(901, `${pullRequestLine(1234)}\n${other}`);
      messages.set(903, `${other}\n${pullRequestLine(1234)}`);
      databaseMock.getPullRequestExpansions.mockResolvedValue([
        expansion('901'),
        expansion('300000000000000001', { service: 'discord', channelId: '100000000000000001' }),
        expansion('903'),
      ]);

      await approve();

      expect(databaseMock.getPullRequestExpansions).toHaveBeenCalledExactlyOnceWith(
        { organization: 'immich-app', repository: 'immich', number: 1234 },
        new Date(SUBMITTED_AT),
      );
      expect(zulipMock.getMessagesByIds.mock.calls).toEqual([[[901]], [[903]]]);
      expect(zulipMock.updateMessage.mock.calls).toEqual([
        [901, { content: `:approved2: ${pullRequestLine(1234)}\n${other}` }],
        [903, { content: `${other}\n:approved2: ${pullRequestLine(1234)}` }],
      ]);
      expect(zulipMock.addReaction).not.toHaveBeenCalled();
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it('should neither edit nor react to a reply whose line is marked already', async () => {
      messages.set(901, `:approved2: ${pullRequestLine(1234)}`);
      databaseMock.getPullRequestExpansions.mockResolvedValue([expansion('901')]);

      await approve();

      expect(zulipMock.updateMessage).not.toHaveBeenCalled();
      expect(zulipMock.addReaction).not.toHaveBeenCalled();
    });

    it('should mark both pull requests of one reply when both are approved', async () => {
      messages.set(901, [pullRequestLine(1234), pullRequestLine(5678)].join('\n'));
      databaseMock.getPullRequestExpansions
        .mockResolvedValueOnce([expansion('901', { pullRequestCount: 2 })])
        .mockResolvedValueOnce([expansion('901', { number: 5678, pullRequestCount: 2 })]);

      sut.handleReview(reviewEvent());
      await approve(reviewEvent({ number: 5678 }));

      expect(messages.get(901)).toBe(
        [`:approved2: ${pullRequestLine(1234)}`, `:approved2: ${pullRequestLine(5678)}`].join('\n'),
      );
    });

    describe('when the line cannot be marked', () => {
      const timeLimit = () =>
        new ZulipApiError(
          400,
          'BAD_REQUEST',
          'The time limit for editing this message has passed',
          'PATCH /api/v1/messages/901',
        );
      const oneLine = () => pullRequestLine(1234);
      const tooLong = () => `${pullRequestLine(1234)}\n${'a'.repeat(10_000 - pullRequestLine(1234).length - 1)}`;

      it.each([
        { what: 'Zulip refuses the edit', refuse: true, content: oneLine },
        { what: 'the mark would make the reply too long for Zulip', refuse: false, content: tooLong },
      ])('should react with the realm emoji to a reply of one pull request when $what', async ({ refuse, content }) => {
        messages.set(901, content());
        if (refuse) {
          zulipMock.updateMessage.mockRejectedValue(timeLimit());
        }
        databaseMock.getPullRequestExpansions.mockResolvedValue([expansion('901')]);

        await approve();

        expect(zulipMock.updateMessage).toHaveBeenCalledTimes(refuse ? 1 : 0);
        expect(zulipMock.addReaction).toHaveBeenCalledExactlyOnceWith(901, {
          name: 'approved2',
          code: '77',
          type: 'realm_emoji',
        });
        expect(Logger.prototype.error).not.toHaveBeenCalled();
      });

      it.each([
        { what: 'Zulip refuses the edit', refuse: true, content: oneLine },
        { what: 'the mark would make the reply too long for Zulip', refuse: false, content: tooLong },
      ])(
        'should not react to a reply of several pull requests when $what, since the reaction would not say which',
        async ({ refuse, content }) => {
          messages.set(901, content());
          if (refuse) {
            zulipMock.updateMessage.mockRejectedValue(timeLimit());
          }
          databaseMock.getPullRequestExpansions.mockResolvedValue([expansion('901', { pullRequestCount: 2 })]);

          await approve();

          expect(zulipMock.addReaction).not.toHaveBeenCalled();
          expect(Logger.prototype.debug).toHaveBeenCalledWith(expect.stringContaining('it names 2 pull requests'));
          expect(Logger.prototype.error).not.toHaveBeenCalled();
        },
      );

      it('should edit a reply that just fits once marked', async () => {
        const content = `${pullRequestLine(1234)}\n${'a'.repeat(10_000 - pullRequestLine(1234).length - 1 - ':approved2: '.length)}`;
        messages.set(901, content);
        databaseMock.getPullRequestExpansions.mockResolvedValue([expansion('901')]);

        await approve();

        expect([...messages.get(901)!]).toHaveLength(10_000);
        expect(zulipMock.addReaction).not.toHaveBeenCalled();
      });

      it('should log nothing when the reply has the reaction already', async () => {
        messages.set(901, pullRequestLine(1234));
        zulipMock.updateMessage.mockRejectedValue(timeLimit());
        zulipMock.addReaction.mockRejectedValue(
          new ZulipApiError(400, 'REACTION_ALREADY_EXISTS', 'Reaction already exists.', 'POST /api/v1/messages/901'),
        );
        databaseMock.getPullRequestExpansions.mockResolvedValue([expansion('901')]);

        await approve();

        expect(zulipMock.addReaction).toHaveBeenCalledOnce();
        expect(Logger.prototype.error).not.toHaveBeenCalled();
      });

      it('should log a reaction that fails otherwise as an error', async () => {
        const failure = new ZulipApiError(500, 'INTERNAL_SERVER_ERROR', 'Oops', 'POST /api/v1/messages/901/reactions');
        messages.set(901, pullRequestLine(1234));
        zulipMock.updateMessage.mockRejectedValue(timeLimit());
        zulipMock.addReaction.mockRejectedValue(failure);
        databaseMock.getPullRequestExpansions.mockResolvedValue([expansion('901')]);

        await approve();

        expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
          'Could not mark immich-app/immich#1234 as approved in Zulip message 901',
          failure,
        );
      });
    });

    it('should only note a reply that is gone', async () => {
      databaseMock.getPullRequestExpansions.mockResolvedValue([expansion('901')]);

      await approve();

      expect(zulipMock.updateMessage).not.toHaveBeenCalled();
      expect(Logger.prototype.debug).toHaveBeenCalledWith(
        'Zulip message 901 is gone, so immich-app/immich#1234 is not marked there',
      );
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it('should only note a reply deleted between the read and the edit, without reacting', async () => {
      messages.set(901, pullRequestLine(1234));
      zulipMock.updateMessage.mockRejectedValue(
        new ZulipApiError(400, 'BAD_REQUEST', 'Invalid message(s)', 'PATCH /api/v1/messages/901'),
      );
      databaseMock.getPullRequestExpansions.mockResolvedValue([expansion('901')]);

      await approve();

      expect(zulipMock.addReaction).not.toHaveBeenCalled();
      expect(Logger.prototype.debug).toHaveBeenCalledWith(
        'Zulip message 901 is gone, so immich-app/immich#1234 is not marked there',
      );
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it('should log an edit that fails as an error and still mark the next reply', async () => {
      const failure = new ZulipApiError(500, 'INTERNAL_SERVER_ERROR', 'Oops', 'PATCH /api/v1/messages/901');
      messages.set(901, pullRequestLine(1234));
      messages.set(902, pullRequestLine(1234));
      zulipMock.updateMessage.mockRejectedValueOnce(failure);
      databaseMock.getPullRequestExpansions.mockResolvedValue([expansion('901'), expansion('902')]);

      await approve();

      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        'Could not mark immich-app/immich#1234 as approved in Zulip message 901',
        failure,
      );
      expect(zulipMock.addReaction).not.toHaveBeenCalled();
      expect(messages.get(902)).toBe(`:approved2: ${pullRequestLine(1234)}`);
    });

    it.each([
      { what: 'missing', emoji: [{ id: '76', name: 'approved', deactivated: false }] },
      { what: 'deactivated', emoji: [{ ...APPROVED2, deactivated: true }] },
    ])('should mark nothing on Zulip, with a warning, while its approved2 emoji is $what', async ({ emoji }) => {
      messages.set(901, pullRequestLine(1234));
      zulipMock.listEmoji.mockResolvedValue(emoji);
      databaseMock.getPullRequestExpansions.mockResolvedValue([expansion('901')]);

      await approve();

      expect(zulipMock.getMessagesByIds).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).toHaveBeenCalledExactlyOnceWith(
        'Zulip has no realm emoji approved2, so approvals are not marked there',
      );
    });

    it('should mark nothing on Zulip, with an error, when its emoji cannot be listed', async () => {
      const failure = new Error('fetch failed');
      zulipMock.listEmoji.mockRejectedValue(failure);
      databaseMock.getPullRequestExpansions.mockResolvedValue([expansion('901')]);

      await approve();

      expect(zulipMock.getMessagesByIds).not.toHaveBeenCalled();
      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        'Could not list the Zulip realm emoji, so the approval is not marked there',
        failure,
      );
    });

    it('should ask Zulip nothing while it is not initialised', async () => {
      zulipMock.isInitialised.mockReturnValue(false);
      databaseMock.getPullRequestExpansions.mockResolvedValue([expansion('901')]);

      await approve();

      expect(zulipMock.listEmoji).not.toHaveBeenCalled();
      expect(zulipMock.getMessagesByIds).not.toHaveBeenCalled();
    });

    it('should ask Zulip nothing when no Zulip reply names the pull request', async () => {
      await approve();

      expect(zulipMock.listEmoji).not.toHaveBeenCalled();
    });
  });

  describe('on Discord', () => {
    it.each([
      { what: 'a static emote', emote: emote(), mark: `<:APPROVED:${EMOTE}>` },
      {
        what: 'an animated emote',
        emote: emote({ identifier: `a:APPROVED:${EMOTE}`, animated: true }),
        mark: `<a:APPROVED:${EMOTE}>`,
      },
    ])('should mark the line of the pull request in each reply in its channel with $what', async ({ emote, mark }) => {
      const other = [issueLine, nitterLine].join('\n');
      discordMessages.set(`${THREAD}/300000000000000001`, `${pullRequestLine(1234)}\n${other}`);
      discordMessages.set(`100000000000000001/300000000000000002`, `${other}\n${pullRequestLine(1234)}`);
      discordMock.getEmotes.mockResolvedValue([emote]);
      databaseMock.getPullRequestExpansions.mockResolvedValue([
        discordExpansion('300000000000000001'),
        expansion('901'),
        discordExpansion('300000000000000002', { channelId: '100000000000000001' }),
      ]);

      await approve();

      expect(discordMock.getEmotes).toHaveBeenCalledExactlyOnceWith(Constants.Discord.EmoteSyncServer.id);
      expect(discordMock.getBotMessageContent.mock.calls).toEqual([
        [THREAD, '300000000000000001'],
        ['100000000000000001', '300000000000000002'],
      ]);
      expect(discordMock.editBotMessage.mock.calls).toEqual([
        [THREAD, '300000000000000001', `${mark} ${pullRequestLine(1234)}\n${other}`],
        ['100000000000000001', '300000000000000002', `${other}\n${mark} ${pullRequestLine(1234)}`],
      ]);
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it('should mark with the emote named exactly APPROVED, not one only differing in case', async () => {
      discordMessages.set(`${THREAD}/300000000000000001`, pullRequestLine(1234));
      discordMock.getEmotes.mockResolvedValue([emote({ id: '1300000000000000076', name: 'Approved' }), emote()]);
      databaseMock.getPullRequestExpansions.mockResolvedValue([discordExpansion('300000000000000001')]);

      await approve();

      expect(discordMock.getEmotes).toHaveBeenCalledExactlyOnceWith('979116623879368755');
      expect(discordMessages.get(`${THREAD}/300000000000000001`)).toBe(`<:APPROVED:${EMOTE}> ${pullRequestLine(1234)}`);
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    });

    it('should not edit a reply whose line is marked already', async () => {
      discordMessages.set(`${THREAD}/300000000000000001`, `<:APPROVED:${EMOTE}> ${pullRequestLine(1234)}`);
      databaseMock.getPullRequestExpansions.mockResolvedValue([discordExpansion('300000000000000001')]);

      await approve();

      expect(discordMock.editBotMessage).not.toHaveBeenCalled();
    });

    it('should mark both pull requests of one reply when both are approved', async () => {
      discordMessages.set(`${THREAD}/300000000000000001`, [pullRequestLine(1234), pullRequestLine(5678)].join('\n'));
      databaseMock.getPullRequestExpansions
        .mockResolvedValueOnce([discordExpansion('300000000000000001')])
        .mockResolvedValueOnce([discordExpansion('300000000000000001', { number: 5678 })]);

      sut.handleReview(reviewEvent());
      await approve(reviewEvent({ number: 5678 }));

      expect(discordMessages.get(`${THREAD}/300000000000000001`)).toBe(
        [`<:APPROVED:${EMOTE}> ${pullRequestLine(1234)}`, `<:APPROVED:${EMOTE}> ${pullRequestLine(5678)}`].join('\n'),
      );
    });

    it.each([
      { outcome: 'leave', length: 2001, edited: false },
      { outcome: 'edit', length: 2000, edited: true },
    ])('should $outcome a reply that would be $length characters long once marked', async ({ length, edited }) => {
      const mark = `<:APPROVED:${EMOTE}> `;
      const filler = 'a'.repeat(length - pullRequestLine(1234).length - 1 - mark.length);
      discordMessages.set(`${THREAD}/300000000000000001`, `${pullRequestLine(1234)}\n${filler}`);
      databaseMock.getPullRequestExpansions.mockResolvedValue([discordExpansion('300000000000000001')]);

      await approve();

      expect(discordMock.editBotMessage.mock.calls.map(([, , content]) => content.length)).toEqual(
        edited ? [length] : [],
      );
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it('should only note a reply that is gone', async () => {
      databaseMock.getPullRequestExpansions.mockResolvedValue([discordExpansion('300000000000000001')]);

      await approve();

      expect(discordMock.editBotMessage).not.toHaveBeenCalled();
      expect(Logger.prototype.debug).toHaveBeenCalledWith(
        `Discord message 300000000000000001 in channel ${THREAD} is gone, so immich-app/immich#1234 is not marked there`,
      );
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it.each(['unknown-message', 'unknown-channel', 'archived', 'locked'] as const)(
      'should only note a reply that cannot be marked (%s)',
      async (kind) => {
        discordMessages.set(`${THREAD}/300000000000000001`, pullRequestLine(1234));
        discordMock.editBotMessage.mockRejectedValue(new DiscordMirrorError(kind));
        databaseMock.getPullRequestExpansions.mockResolvedValue([discordExpansion('300000000000000001')]);

        await approve();

        expect(Logger.prototype.debug).toHaveBeenCalledWith(
          `Discord message 300000000000000001 in channel ${THREAD} cannot be marked (${kind}), so immich-app/immich#1234 is not marked there`,
        );
        expect(Logger.prototype.error).not.toHaveBeenCalled();
      },
    );

    it.each(['forbidden', 'other'] as const)(
      'should log a reply that fails otherwise (%s) as an error and still mark the next one',
      async (kind) => {
        const failure = new DiscordMirrorError(kind);
        discordMessages.set(`${THREAD}/300000000000000001`, pullRequestLine(1234));
        discordMessages.set(`${THREAD}/300000000000000002`, pullRequestLine(1234));
        discordMock.getBotMessageContent.mockRejectedValueOnce(failure);
        databaseMock.getPullRequestExpansions.mockResolvedValue([
          discordExpansion('300000000000000001'),
          discordExpansion('300000000000000002'),
        ]);

        await approve();

        expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
          `Could not mark immich-app/immich#1234 as approved in Discord message 300000000000000001 in channel ${THREAD}`,
          failure,
        );
        expect(discordMessages.get(`${THREAD}/300000000000000002`)).toBe(
          `<:APPROVED:${EMOTE}> ${pullRequestLine(1234)}`,
        );
      },
    );

    it.each([
      { what: 'the Immich server has no emote named APPROVED', emotes: [emote({ name: 'approved' })] },
      { what: 'the bot cannot see the Immich server', emotes: undefined },
    ])('should mark nothing on Discord, with a warning, when $what', async ({ emotes }) => {
      discordMessages.set(`${THREAD}/300000000000000001`, pullRequestLine(1234));
      discordMock.getEmotes.mockResolvedValue(emotes);
      databaseMock.getPullRequestExpansions.mockResolvedValue([discordExpansion('300000000000000001')]);

      await approve();

      expect(discordMock.getBotMessageContent).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).toHaveBeenCalledExactlyOnceWith(
        'The Immich Discord server has no emote APPROVED, so approvals are not marked on Discord',
      );
    });

    it('should ask Discord nothing while it is not ready', async () => {
      discordMock.isReady.mockReturnValue(false);
      databaseMock.getPullRequestExpansions.mockResolvedValue([discordExpansion('300000000000000001')]);

      await approve();

      expect(discordMock.getEmotes).not.toHaveBeenCalled();
      expect(discordMock.getBotMessageContent).not.toHaveBeenCalled();
    });

    it('should ask Discord nothing when no Discord reply names the pull request', async () => {
      databaseMock.getPullRequestExpansions.mockResolvedValue([expansion('901')]);

      await approve();

      expect(discordMock.getEmotes).not.toHaveBeenCalled();
    });
  });

  describe('on both platforms', () => {
    beforeEach(() => {
      messages.set(901, pullRequestLine(1234));
      discordMessages.set(`${THREAD}/300000000000000001`, pullRequestLine(1234));
      databaseMock.getPullRequestExpansions.mockResolvedValue([
        expansion('901'),
        discordExpansion('300000000000000001'),
      ]);
    });

    it('should mark the Discord replies when the Zulip emoji cannot be listed', async () => {
      zulipMock.listEmoji.mockRejectedValue(new Error('fetch failed'));

      await approve();

      expect(discordMessages.get(`${THREAD}/300000000000000001`)).toBe(`<:APPROVED:${EMOTE}> ${pullRequestLine(1234)}`);
    });

    it('should mark the Zulip replies when the Discord emote cannot be found', async () => {
      const failure = new Error('gateway down');
      discordMock.getEmotes.mockRejectedValue(failure);

      await approve();

      expect(messages.get(901)).toBe(`:approved2: ${pullRequestLine(1234)}`);
      expect(discordMock.getBotMessageContent).not.toHaveBeenCalled();
      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        'Could not find the Discord emote of the approval, so it is not marked on Discord',
        failure,
      );
    });

    it('should mark the Zulip replies when a Discord edit fails', async () => {
      const failure = new DiscordMirrorError('other');
      discordMock.editBotMessage.mockRejectedValue(failure);

      await approve();

      expect(messages.get(901)).toBe(`:approved2: ${pullRequestLine(1234)}`);
      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        `Could not mark immich-app/immich#1234 as approved in Discord message 300000000000000001 in channel ${THREAD}`,
        failure,
      );
    });
  });

  describe('prune', () => {
    it('should remove the expansions older than 30 days', async () => {
      vitest.useFakeTimers();
      vitest.setSystemTime(new Date('2026-07-15T12:00:00Z'));

      await sut.prune();

      expect(databaseMock.removePullRequestExpansions).toHaveBeenCalledExactlyOnceWith(
        new Date('2026-06-15T12:00:00Z'),
      );
    });

    it('should log a failure instead of throwing', async () => {
      const failure = new Error('database down');
      databaseMock.removePullRequestExpansions.mockRejectedValue(failure);

      await expect(sut.prune()).resolves.toBeUndefined();

      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(
        'Could not prune the pull request expansions',
        failure,
      );
    });
  });
});
