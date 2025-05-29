import { Injectable, Logger } from '@nestjs/common';
import { MessageFlags } from 'discord.js';
import { ArgsOf, Discord, On, Once, RestArgsOf } from 'discordx';
import _ from 'lodash';
import { Constants } from 'src/constants';
import { DiscordService } from 'src/services/discord.service';

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

  constructor(private service: DiscordService) {}

  @On.rest({ event: 'restDebug' })
  onDebug([message]: RestArgsOf<'restDebug'>) {
    this.logger.debug(message);
  }

  @Once({ event: 'ready' })
  async onReady() {
    await this.service.onReady();
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

    const messageParts = await this.service.handleGithubReferences(message.content);
    if (messageParts.length !== 0) {
      await message.reply({
        content: messageParts.join('\n'),
        flags: [MessageFlags.SuppressEmbeds, MessageFlags.SuppressNotifications],
      });
    }
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
      text: (await thread.fetchStarterMessage())?.content ?? undefined,
    });

    if (link) {
      const message = await thread.send({
        content: `<@&${Constants.Discord.Roles.Team}> ${link}`,
        flags: [MessageFlags.SuppressEmbeds],
      });
      await message.pin();
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
      text: (await newThread.fetchStarterMessage())?.content ?? undefined,
    });

    if (link) {
      const message = await newThread.send({
        content: `<@&${Constants.Discord.Roles.Team}> ${link}`,
        flags: [MessageFlags.SuppressEmbeds],
      });
      await message.pin();
    }
  }
}
