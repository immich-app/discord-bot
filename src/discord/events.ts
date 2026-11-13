import { Inject, Injectable, Logger } from '@nestjs/common';
import { Message, MessageFlags, ThreadChannel } from 'discord.js';
import { ArgsOf, Discord, On, Once, RestArgsOf } from 'discordx';
import _ from 'lodash';
import { Constants } from 'src/constants';
import { DiscordMirrorError } from 'src/interfaces/discord-mirror.interface';
import { IDiscordInterface } from 'src/interfaces/discord.interface';
import { ApprovalService } from 'src/services/approval.service';
import { ChatService } from 'src/services/chat.service';

const shorten = (message: string | null) => {
  if (!message) {
    return message;
  }

  return message.length > 50 ? `${message.slice(0, 40)}...` : message;
};

@Discord()
@Injectable()
export class DiscordEvents {
  private logger = new Logger(DiscordEvents.name);

  constructor(
    private service: ChatService,
    private approvals: ApprovalService,
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
  ) {}

  @On.rest({ event: 'restDebug' })
  onDebug([message]: RestArgsOf<'restDebug'>) {
    this.logger.debug(message);
  }

  @Once({ event: 'clientReady' })
  onReady() {
    this.service.onReady();
  }

  @On({ event: 'error' })
  async onError([error]: ArgsOf<'error'>) {
    await this.service.onError(error);
  }

  @On({ event: 'messageCreate' })
  async onMessageCreate([message]: ArgsOf<'messageCreate'>) {
    if (message.author.bot) {
      return;
    }

    if (message.channel.isDMBased()) {
      return;
    }

    const isPrivileged = message.member?.roles.cache.has(Constants.Discord.Roles.Team) ?? false;
    const { content } = await this.readContent(message);

    const [{ parts, pullRequests }, twitterLinks] = await Promise.all([
      this.service.handleGithubReferences({ content, channelParentId: message.channel.parentId }, isPrivileged),
      this.service.handleTwitterReferences(content),
      this.service.handleTaggingOfPullRequestThreads(message),
    ]);

    // Neither reply waits on the other, so the GitHub reply or its tracking failing cannot cost the fxtwitter reply.
    await Promise.all([
      parts.length === 0
        ? undefined
        : message
            .reply({
              content: parts.join('\n'),
              flags: [MessageFlags.SuppressEmbeds, MessageFlags.SuppressNotifications],
            })
            .then((reply) =>
              this.approvals.track(
                { service: 'discord', channelId: reply.channelId, messageId: reply.id },
                pullRequests,
              ),
            ),
      twitterLinks.length === 0
        ? undefined
        : message.reply({
            content: twitterLinks.join('\n'),
            flags: [MessageFlags.SuppressNotifications],
          }),
    ]);
  }

  @On({ event: 'messageUpdate' })
  async onMessageUpdate([oldMessage, newMessage]: ArgsOf<'messageUpdate'>) {
    this.logger.verbose(
      `DiscordBot.onMessageUpdate [${oldMessage.author?.username || 'Unknown'}] => ${shorten(newMessage.content)}`,
    );
    if (oldMessage.author?.bot) {
      return;
    }

    if (!_.isEqual(oldMessage.embeds, newMessage.embeds)) {
      this.logger.verbose('Removing embeds', oldMessage.embeds, newMessage.embeds);
      const urls = newMessage.embeds.map((embed) => embed.url).filter((url): url is string => !!url);
      if (this.service.hasBlacklistUrl(urls)) {
        await newMessage.suppressEmbeds(true);
      }
    } else {
      this.logger.verbose('Skipping, no embeds');
    }
  }

  @On({ event: 'messageDelete' })
  async onMessageDelete([message]: ArgsOf<'messageDelete'>) {
    this.logger.verbose(
      `DiscordBot.onMessageDelete [${message.author?.username || 'Unknown'}] => ${shorten(message.content)}`,
    );
  }

  @On({ event: 'threadCreate' })
  async onThreadCreate([thread]: ArgsOf<'threadCreate'>) {
    if (!thread.isTextBased()) {
      return;
    }

    const link = await this.service.createOutlineDoc({
      threadParentId: thread.parentId ?? undefined,
      threadTags: thread.appliedTags,
      title: thread.name,
      text: await this.starterText(thread),
    });

    if (link) {
      await this.sendAndPinOutlineLink(thread, link);
    }
  }

  @On({ event: 'threadUpdate' })
  async onThreadUpdate([oldThread, newThread]: ArgsOf<'threadUpdate'>) {
    const tagDiff = _.difference(newThread.appliedTags, oldThread.appliedTags);

    if (tagDiff.length === 0) {
      return;
    }

    const link = await this.service.createOutlineDoc({
      threadParentId: newThread.parentId ?? undefined,
      threadTags: tagDiff,
      title: newThread.name,
      text: await this.starterText(newThread),
    });

    if (link) {
      await this.sendAndPinOutlineLink(newThread, link);
    }
  }

  /** One that cannot be read as the user account counts as empty, as it would without one. */
  private async readContent(message: Message) {
    if (!this.discord.needsContentRead(message)) {
      return message;
    }
    try {
      return (await this.discord.withContent(message)) ?? message;
    } catch (error) {
      const text = `Could not read Discord message ${message.id} as the user account: ${error}`;
      if (error instanceof DiscordMirrorError && error.kind === 'forbidden') {
        this.logger.debug(text);
      } else {
        this.logger.warn(text);
      }
      return message;
    }
  }

  private async starterText(thread: ThreadChannel) {
    const starter = await thread.fetchStarterMessage();
    return starter ? (await this.readContent(starter)).content : undefined;
  }

  private async sendAndPinOutlineLink(thread: ThreadChannel, link: string) {
    const role =
      thread.parentId === Constants.Discord.Channels.YuccaFocusTopic
        ? Constants.Discord.Roles.Yucca
        : Constants.Discord.Roles.Immich;

    const message = await thread.send({
      content: `<@&${role}> ${link}`,
      flags: [MessageFlags.SuppressEmbeds],
    });
    await message.pin();
  }
}
