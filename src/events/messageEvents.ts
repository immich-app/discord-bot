import { Octokit } from '@octokit/rest';
import { IMMICH_REPOSITORY_BASE_OPTIONS, Constants } from '../constants.js';
import { Message, MessageFlags, PartialMessage } from 'discord.js';
import { ArgsOf, Discord, On } from 'discordx';
import _ from 'lodash';
import { RequestError } from '@octokit/request-error';

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
    const links = new Set<string>();
    for (const match of matches) {
      const id = match?.groups?.id;
      if (!id) {
        continue;
      }

      if (Number(id) < 500 || Number(id) > 15000) {
        continue;
      }

      const link = (await this.getIssueOrPr(id)) || (await this.getDiscussion(id));

      link && links.add(link);
    }

    return [...links];
  }

  private async getIssueOrPr(id: string) {
    try {
      const response = await octokit.rest.issues.get({
        ...IMMICH_REPOSITORY_BASE_OPTIONS,
        issue_number: Number(id),
      });

      const type = response.data.pull_request ? 'Pull Request' : 'Issue';
      return `[${type}] ${response.data.title} ([#${id}](${response.data.html_url}))`;
    } catch (error) {
      if (error instanceof RequestError && error.status !== 404) {
        console.log(`Could not fetch #${id}`);
      }
    }
  }

  private async getDiscussion(id: string) {
    try {
      const { status } = await fetch(`${Constants.Urls.Discussions}/${id}}`);

      if (status === 200) {
        return `[Discussion] ([#${id}](${Constants.Urls.Discussions}/${id}))`;
      }
    } catch (error) {
      console.log(`Could not fetch #${id}`);
    }
  }
}
