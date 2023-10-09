import { MessageFlags } from 'discord.js';
import { ArgsOf, Discord, On } from 'discordx';
import { GITHUB_API_DOMAIN, GITHUB_DOMAIN } from '../constants.js';

@Discord()
export class Messages {
  @On({ event: 'messageCreate' })
  async newMessage([message]: ArgsOf<'messageCreate'>) {
    if (message.author.id === '1158729698872930445') {
      return;
    }

    const links = await this.getGithubLinks(message.content);
    if (links.length !== 0) {
      message.reply({ content: links.join('\n'), flags: [MessageFlags.SuppressEmbeds] });
    }
  }

  private async getGithubLinks(content: string): Promise<string[]> {
    const matches = content.matchAll(/#(?<id>[0-9]+)/g);
    const links = [];
    for (const match of matches) {
      if (match?.groups) {
        const id = match.groups.id;
        const response = await fetch(`${GITHUB_API_DOMAIN}/issues/${id}`);

        if (response.status === 200) {
          const json = await response.json();
          const type = json.pull_request ? 'PR' : 'ISSUE';
          links.push(`[[${type}] ${json.title} (#${id})](${json.html_url})`);
          continue;
        }

        const { status: discussionStatus } = await fetch(`${GITHUB_DOMAIN}/discussions/${id}}`);
        if (discussionStatus === 200) {
          links.push(`[[Discussion] (#${id})](${GITHUB_DOMAIN}/discussions/${id})`);
        }
      }
    }
    return links;
  }

  @On({ event: 'messageCreate' })
  preventGithubEmbeddings([message]: ArgsOf<'messageCreate'>) {
    if (message.embeds.find((embed) => embed.url?.startsWith(GITHUB_DOMAIN))) {
      message.suppressEmbeds(true);
    }
  }
}
