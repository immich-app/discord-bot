import { Injectable, Logger } from '@nestjs/common';
import { MessageFlags } from 'discord.js';
import { ArgsOf, Discord, On, Once } from 'discordx';
import _ from 'lodash';
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

    const links = await this.service.handleGithubReferences(message.content);
    if (links.length !== 0) {
      await message.reply({ content: links.join('\n'), flags: [MessageFlags.SuppressEmbeds] });
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
      if (await this.service.hasBlacklistUrl(urls)) {
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
}
