import { Octokit } from '@octokit/rest';
import { Constants } from '../constants.js';
import { Message, MessageFlags, PartialMessage } from 'discord.js';
import { ArgsOf, Discord, On } from 'discordx';
import _ from 'lodash';
import { getDiscussion, getIssueOrPr } from '../utils.js';

const PREVIEW_BLACKLIST = [Constants.Urls.Immich, Constants.Urls.GitHub];
const octokit = new Octokit();

@Discord()
export class MessageEvents {
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
    const links = await this.getGithubLinks(message.content);
    if (links.length !== 0) {
      await message.reply({ content: links.join('\n'), flags: [MessageFlags.SuppressEmbeds] });
    }
  }

  private async handlePreventEmbeddings(message: Message<boolean> | PartialMessage) {
    if (message.embeds.find((embed) => PREVIEW_BLACKLIST.find((domain) => embed.url?.startsWith(domain)))) {
      await message.suppressEmbeds(true);
    }
  }

  private async getGithubLinks(content: string): Promise<string[]> {
    content = content.replaceAll(/```.*```/gs, '');
    const matches = content.matchAll(/(^|\W)#(?<id>[0-9]+)/g);
    const ids = new Set<string>();
    for (const match of matches) {
      const id = match?.groups?.id;
      if (!id) {
        continue;
      }

      ids.add(id);
    }

    const filteredIds = ids.size > 1 ? [...ids].filter((id) => Number(id) > 500 && Number(id) < 15000) : [...ids];
    const links = await Promise.all(
      filteredIds.map(async (id) => (await getIssueOrPr(octokit, id)) || (await getDiscussion(id))),
    );

    return links.filter((link): link is string => link !== undefined);
  }
}
