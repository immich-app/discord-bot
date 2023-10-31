import { GITHUB_DOMAIN, IMMICH_DOMAIN, IMMICH_REPOSITORY, IMMICH_REPOSITORY_BASE_OPTIONS } from '../constants.js';
import { Octokit } from '@octokit/rest';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Message,
  MessageActionRowComponentBuilder,
  MessageFlags,
  PartialMessage,
  ThreadChannel,
} from 'discord.js';
import { ArgsOf, ButtonComponent, Discord, On } from 'discordx';
import _ from 'lodash';
import { HELP_TEXTS } from '../commands/slashes.js';

const hammerButton = new ButtonBuilder({
  url: 'https://www.amazon.com/s?k=hammer',
  emoji: '🔨',
  label: 'Get A Hammer',
  style: ButtonStyle.Link,
});

const reverseProxyButton = new ButtonBuilder({
  customId: 'reverseProxy',
  label: 'Reverse Proxy',
  style: ButtonStyle.Primary,
});

const submitButton = new ButtonBuilder({
  customId: 'submit',
  label: 'Submit',
  style: ButtonStyle.Success,
  disabled: true,
});

const buttonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
  hammerButton,
  reverseProxyButton,
  submitButton,
);

const PREVIEW_BLACKLIST = [GITHUB_DOMAIN, IMMICH_DOMAIN];
const octokit = new Octokit();
const helpDeskWelcomeMessage = `:wave: Hey

Thanks for reaching out to us.
To make it easier for us to help you, please follow the troubleshooting steps below and then provide us with as much information as possible about your issue.
This will save us time we can instead invest in making Immich even better <:immich:991481316950425643>

1. :blue_square: turn it off and on again
2. :blue_square: pray to the Immich-gods
3. :blue_square: try it without a reverse proxy
4. :blue_square: did you apply a :hammer:?

For further information on how to do this, check out the buttons below.`;

const helpDeskChannelId = '1049703391762321418';

const readyTagId = '1166852154292699207';

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
