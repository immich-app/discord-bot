import { Message, MessageFlags } from 'discord.js';
import { ArgsOf, Discord, On } from 'discordx';
import { GITHUB_API_DOMAIN, GITHUB_DOMAIN, IMMICH_REPOSITORY } from '../constants.js';

@Discord()
export class MessageEvents {
  @On({ event: 'messageCreate' })
  async messageCreate([message]: ArgsOf<'messageCreate'>) {
    if (message.author.bot) {
      return;
    }

    await Promise.all([this.handleGithubShortLinks(message), this.handlePreventGithubEmbeddings(message)]);
  }

  private async handleGithubShortLinks(message: Message<boolean>) {
    const links = await this.getGithubLinks(message.content);
    if (links.length !== 0) {
      message.reply({ content: links.join('\n'), flags: [MessageFlags.SuppressEmbeds] });
    }
  }

  private async handlePreventGithubEmbeddings(message: Message<boolean>) {
    if (message.embeds.find((embed) => embed.url?.startsWith(GITHUB_DOMAIN))) {
      await message.suppressEmbeds(true);
    }
  }

  private async getGithubLinks(content: string): Promise<string[]> {
    content = content.replaceAll(/```.*```/gs, '');
    const matches = content.matchAll(/(^|\s)#(?<id>[0-9]+)/g);
    const links = new Set<string>();
    for (const match of matches) {
      if (match?.groups) {
        const id = match.groups.id;
        const response = await fetch(`${GITHUB_API_DOMAIN}/issues/${id}`);

        if (response.status === 200) {
          const json = await response.json();
          const type = json.pull_request ? 'PR' : 'ISSUE';
          links.add(`[${type}] ${json.title} ([#${id}](${json.html_url}))`);
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
