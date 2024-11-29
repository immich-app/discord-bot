import { Injectable } from '@nestjs/common';
import { Discord } from 'discordx';
import { DiscordService } from 'src/services/discord.service';

@Discord()
@Injectable()
export class DiscordContextMenus {
  constructor(private service: DiscordService) {}

  // @ContextMenu({
  //   name: 'Save as emote',
  //   type: ApplicationCommandType.Message,
  //   defaultMemberPermissions: 'ManageEmojisAndStickers',
  // })
  // async onSaveEmote(interaction: MessageContextMenuCommandInteraction) {
  //   const modal = new ModalBuilder({
  //     customId: 'emote_create_label',
  //     title: 'Create Emote',
  //     components: [
  //       new ActionRowBuilder<TextInputBuilder>({
  //         components: [
  //           new TextInputBuilder({
  //             customId: 'name',
  //             label: 'Emote Name',
  //             style: TextInputStyle.Short,
  //             required: true,
  //           }),
  //         ],
  //       }),
  //     ],
  //   });
  //   await interaction.showModal(modal);
  //   const modalResponse = await interaction.awaitModalSubmit({ time: 9999999 });

  //   const emoteUrl = interaction.targetMessage.attachments.first()?.url;

  //   if (!emoteUrl) {
  //     await interaction.reply({ content: 'Could not find emote.' });
  //     return;
  //   }

  //   const emote = await this.service.createEmote(
  //     modalResponse.fields.getTextInputValue('name'),
  //     emoteUrl,
  //     interaction.guildId,
  //   );
  //   console.log(emote);
  //   await interaction.reply({ content: emote?.identifier });
  // }
}
