import { Constants } from '../constants.js';
import { Message, MessageFlags, PartialMessage } from 'discord.js';
import { ArgsOf, Discord, On } from 'discordx';
import _ from 'lodash';
import { BotRepository } from '../repositories/bot.repository.js';
import { handleGithubReferences } from '../service.js';

const PREVIEW_BLACKLIST = [Constants.Urls.Immich, Constants.Urls.GitHub];

@Discord()
export class MessageEvents {
  constructor(private botRepository: BotRepository = new BotRepository()) {}

  @On({ event: 'messageCreate' })
  async handleMessageCreate([message]: ArgsOf<'messageCreate'>) {
    if (message.author.bot) {
      return;
    }

    await Promise.all([this.handleGithubShortLinks(message)]);
  }

  @On({ event: 'messageUpdate' })
  async handleMessageUpdate([oldMessage, newMessage]: ArgsOf<'messageUpdate'>) {
    if (oldMessage.author?.bot) {
      return;
    }

    if (!_.isEqual(oldMessage.embeds, newMessage.embeds)) {
      await this.handlePreventEmbeddings(newMessage);
    }
  }

  private async handleGithubShortLinks(message: Message<boolean>) {
    const links = await handleGithubReferences(this.botRepository, message.content);
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
