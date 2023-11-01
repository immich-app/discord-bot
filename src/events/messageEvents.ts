import { Octokit } from '@octokit/rest';
import { GITHUB_DOMAIN, IMMICH_DOMAIN, IMMICH_REPOSITORY, IMMICH_REPOSITORY_BASE_OPTIONS } from '../constants.js';
import { Message, MessageFlags, PartialMessage } from 'discord.js';
import { ArgsOf, Discord, On } from 'discordx';
import _ from 'lodash';

const PREVIEW_BLACKLIST = [GITHUB_DOMAIN, IMMICH_DOMAIN];
const octokit = new Octokit();

@Discord()
export class MessageEvents {
  @On({ event: 'messageCreate' })
  async messageCreate([message]: ArgsOf<'messageCreate'>) {
    if (message.author.bot) {
      return;
    }

    await Promise.all([this.handleGithubShortLinks(message)]);
  }

  @On({ event: 'messageUpdate' })
  async messageUpdate([oldMessage, newMessage]: ArgsOf<'messageUpdate'>) {
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
    const links = new Set<string>();
    for (const match of matches) {
      if (match?.groups) {
        const id = match.groups.id;
        const response = await octokit.rest.issues.get({ ...IMMICH_REPOSITORY_BASE_OPTIONS, issue_number: Number(id) });

        if (response.status === 200) {
          const type = response.data.pull_request ? 'PR' : 'ISSUE';
          links.add(`[${type}] ${response.data.title} ([#${id}](${response.data.html_url}))`);
          continue;
        }

        const { status: discussionStatus } = await fetch(`${IMMICH_REPOSITORY}/discussions/${id}}`);
        if (discussionStatus === 200) {
          links.add(`[Discussion] ([#${id}](${IMMICH_REPOSITORY}/discussions/${id}))`);
        }
      }
    }
    return [...links];
  }
}
