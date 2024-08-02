import { Injectable } from '@nestjs/common';
import { Message, MessageFlags, PartialMessage } from 'discord.js';
import { ArgsOf, Discord, On } from 'discordx';
import _ from 'lodash';
import { Constants } from 'src/constants';
import { DiscordService } from 'src/services/discord.service';

const PREVIEW_BLACKLIST = [Constants.Urls.Immich, Constants.Urls.GitHub, Constants.Urls.MyImmich];

@Discord()
@Injectable()
export class BotEvents {
  constructor(private service: DiscordService) {}

  @On({ event: 'messageCreate' })
  async onMessageCreate([message]: ArgsOf<'messageCreate'>) {
    if (message.author.bot) {
      return;
    }

    await Promise.all([this.handleGithubShortLinks(message)]);
  }

  @On({ event: 'messageUpdate' })
  async onMessageUpdate([oldMessage, newMessage]: ArgsOf<'messageUpdate'>) {
    if (oldMessage.author?.bot) {
      return;
    }

    if (!_.isEqual(oldMessage.embeds, newMessage.embeds)) {
      await this.handlePreventEmbeddings(newMessage);
    }
  }

  private async handleGithubShortLinks(message: Message<boolean>) {
    const links = await this.service.handleGithubReferences(message.content);
    if (links.length !== 0) {
      await message.reply({ content: links.join('\n'), flags: [MessageFlags.SuppressEmbeds] });
    }
  }

  private async handlePreventEmbeddings(message: Message<boolean> | PartialMessage) {
    if (message.embeds.find((embed) => PREVIEW_BLACKLIST.find((domain) => embed.url?.startsWith(domain)))) {
      await message.suppressEmbeds(true);
    }
  }
}
