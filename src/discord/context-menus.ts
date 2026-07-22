import { Injectable } from '@nestjs/common';
import { ApplicationCommandType, MessageContextMenuCommandInteraction, MessageFlags } from 'discord.js';
import { ContextMenu, Discord } from 'discordx';
import { DiscordService } from 'src/services/discord.service';

@Discord()
@Injectable()
export class DiscordContextMenus {
  constructor(private service: DiscordService) {}

  @ContextMenu({ name: 'Find similar issues', type: ApplicationCommandType.Message })
  async handleFindSimilarIssues(interaction: MessageContextMenuCommandInteraction) {
    const [deferredInteraction, content] = await Promise.all([
      interaction.deferReply(),
      this.service.handleFindSimilarIssuesOrDiscussions(interaction.targetMessage.content),
    ]);

    if (content) {
      await deferredInteraction.edit({ content, flags: [MessageFlags.SuppressEmbeds] });
    }
  }
}
