import { CommandInteraction, GuildMember, MessageFlags, User } from 'discord.js';
import { DiscordCommands } from 'src/discord/commands';
import { ChatService } from 'src/services/chat.service';
import { GithubService } from 'src/services/github.service';
import { RSSService } from 'src/services/rss.service';
import { ScheduledMessageService } from 'src/services/scheduled-message.service';
import { WebhookService } from 'src/services/webhook.service';
import { beforeEach, describe, expect, it, Mocked, vitest } from 'vitest';

const USER = '400000000000000012';

const makeUser = () => Object.assign(Object.create(User.prototype) as User, { id: USER });

const makeMember = (communicationDisabledUntilTimestamp: number | null) =>
  Object.assign(Object.create(GuildMember.prototype) as GuildMember, {
    user: makeUser(),
    communicationDisabledUntilTimestamp,
  });

describe(DiscordCommands.name, () => {
  let sut: DiscordCommands;
  let chat: Mocked<Pick<ChatService, 'pruneMessages'>>;
  let interaction: Mocked<CommandInteraction>;
  let edit: ReturnType<typeof vitest.fn>;

  beforeEach(() => {
    chat = { pruneMessages: vitest.fn() };
    edit = vitest.fn();
    interaction = {
      reply: vitest.fn(),
      deferReply: vitest.fn().mockResolvedValue({ edit }),
    } as unknown as Mocked<CommandInteraction>;
    sut = new DiscordCommands(
      chat as unknown as ChatService,
      {} as RSSService,
      {} as ScheduledMessageService,
      {} as GithubService,
      {} as WebhookService,
    );
  });

  describe('prune', () => {
    it('should refuse a user who is not a member of the server', async () => {
      await sut.handleCleanUp(makeUser(), 5, interaction);

      expect(interaction.reply).toHaveBeenCalledWith({
        content: `<@${USER}> is not a member of this server`,
        flags: [MessageFlags.Ephemeral],
      });
      expect(interaction.deferReply).not.toHaveBeenCalled();
      expect(chat.pruneMessages).not.toHaveBeenCalled();
    });

    it('should refuse a member who is not timed out', async () => {
      await sut.handleCleanUp(makeMember(null), 5, interaction);

      expect(interaction.reply).toHaveBeenCalledWith({
        content: `<@${USER}> must be timeouted first`,
        flags: [MessageFlags.Ephemeral],
      });
      expect(interaction.deferReply).not.toHaveBeenCalled();
      expect(chat.pruneMessages).not.toHaveBeenCalled();
    });

    it('should prune the messages of a timed out member', async () => {
      const member = makeMember(Date.now() + 60_000);

      await sut.handleCleanUp(member, 10, interaction);

      expect(interaction.reply).not.toHaveBeenCalled();
      expect(chat.pruneMessages).toHaveBeenCalledWith(interaction, member, 10);
      expect(edit).toHaveBeenCalledWith(`Successfully cleaned up <@${USER}>`);
    });
  });
});
