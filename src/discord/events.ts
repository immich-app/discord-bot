import { Injectable, Logger } from '@nestjs/common';
import { Message, MessageFlags, PartialMessage } from 'discord.js';
import { ArgsOf, Discord, On, Once } from 'discordx';
import _ from 'lodash';
import { Constants } from 'src/constants';
import { DiscordService } from 'src/services/discord.service';

const PREVIEW_BLACKLIST = [Constants.Urls.Immich, Constants.Urls.GitHub, Constants.Urls.MyImmich];

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
    this.logger.verbose(
      `DiscordBot.onMessageCreate [${message.author.username}] ${shorten(message.content)} ${message.embeds.length} - embed(s)`,
    );
    if (message.author.bot) {
      return;
    }

    await Promise.all([this.handleGithubShortLinks(message)]);
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
      await this.handlePreventEmbeddings(newMessage);
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
