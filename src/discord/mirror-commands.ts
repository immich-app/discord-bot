import { Injectable, Logger } from '@nestjs/common';
import {
  ApplicationCommandOptionType,
  ChannelType,
  type CommandInteraction,
  GuildMember,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { shorten } from 'src/format';
import { MirrorActor, MirrorLinkReply, MirrorLinkService } from 'src/services/mirror-link.service';

const DISCORD_MESSAGE_LENGTH = 2000;

const ADMIN_ONLY = {
  defaultMemberPermissions: PermissionFlagsBits.Administrator,
  contexts: [InteractionContextType.Guild],
};

const NOT_AN_ADMIN = 'Only members with the Administrator permission can change or list the Discord-Zulip mirror.';

const toContent = ({ summary, details }: MirrorLinkReply) => [summary, ...details].join('\n');

const actorOf = (interaction: CommandInteraction): MirrorActor => ({
  platform: 'discord',
  id: interaction.user.id,
  name: interaction.member instanceof GuildMember ? interaction.member.displayName : interaction.user.displayName,
});

/** A forum takes no messages, so the commands for one are run in one of its posts. */
const mirrorTarget = ({ channel, channelId }: CommandInteraction) => {
  if (!channel?.isThread()) {
    return channelId;
  }
  return channel.parent?.type === ChannelType.GuildForum ? channel.parent.id : undefined;
};

const IN_THREAD = 'Run this in the channel itself, not in a thread; for a forum, run it in any of its posts.';

const PRIVATE_THREAD = 'Private threads are not mirrored, so there is nothing to backfill.';

/** A thread or forum post is backfilled on its own; a text channel itself, its own messages without its threads. */
const backfillTarget = ({ channel, channelId }: CommandInteraction) =>
  channel?.isThread()
    ? { discordChannelId: channel.parentId ?? channelId, threadId: channel.id }
    : { discordChannelId: channelId, threadId: null };

@Discord()
@Injectable()
export class DiscordMirrorCommands {
  private logger = new Logger(DiscordMirrorCommands.name);

  constructor(private mirrorLinks: MirrorLinkService) {}

  @Slash({
    name: 'mirror-link',
    description: 'Mirror this channel with the Zulip stream where `mirror-link` gave you the ID',
    ...ADMIN_ONLY,
  })
  async mirrorLink(
    @SlashOption({
      name: 'id',
      description: 'The link ID the bot gave in the Zulip stream',
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    linkId: string,
    interaction: CommandInteraction,
  ) {
    const discordChannelId = await this.target(interaction);
    if (!discordChannelId) {
      return;
    }
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const reply = await this.mirrorLinks.completeLink({ linkId, discordChannelId, actor: actorOf(interaction) });
    await this.edit(interaction, toContent(reply));
  }

  @Slash({ name: 'mirror-unlink', description: 'Stop mirroring this channel with its Zulip stream', ...ADMIN_ONLY })
  async mirrorUnlink(interaction: CommandInteraction) {
    const discordChannelId = await this.target(interaction);
    if (!discordChannelId) {
      return;
    }
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const reply = await this.mirrorLinks.unlink({ discordChannelId, actor: actorOf(interaction) });
    await this.edit(interaction, toContent(reply));
  }

  /** The interaction token lasts 15 minutes, so the report here is a courtesy: the end notice on Zulip is the record. */
  @Slash({
    name: 'mirror-backfill',
    description: 'Copy the messages here that are not on Zulip yet into the linked Zulip topic, oldest first',
    ...ADMIN_ONLY,
  })
  async mirrorBackfill(interaction: CommandInteraction) {
    if (!(await this.authorised(interaction))) {
      return;
    }
    if (interaction.channel?.type === ChannelType.PrivateThread) {
      await interaction.reply({ content: PRIVATE_THREAD, flags: [MessageFlags.Ephemeral] });
      return;
    }
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    let ack = '';
    const result = await this.mirrorLinks.backfill(
      { target: backfillTarget(interaction), actor: actorOf(interaction) },
      async (content) => {
        ack = content;
        await this.edit(interaction, content);
      },
    );
    if ('reply' in result) {
      await this.edit(interaction, result.reply);
      return;
    }
    void result.done
      .then((report) => (report === undefined ? undefined : this.edit(interaction, `${ack}\n${report}`)))
      .catch(() =>
        this.logger.log('Could not report the end of a backfill on Discord: the interaction has likely expired'),
      );
  }

  @Slash({ name: 'mirror-list', description: 'List the mirrored channels and linked accounts', ...ADMIN_ONLY })
  async mirrorList(interaction: CommandInteraction) {
    if (!(await this.authorised(interaction))) {
      return;
    }
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    await this.edit(interaction, await this.mirrorLinks.list('discord'));
  }

  @Slash({
    name: 'zulip-link',
    description: 'Link your Zulip account, so that your Zulip messages appear under your Discord name',
    contexts: [InteractionContextType.Guild],
  })
  async zulipLink(interaction: CommandInteraction) {
    const { id } = interaction.user;
    const reply = await this.mirrorLinks.requestIdentityCode({ id, name: actorOf(interaction).name });
    await interaction.reply({ content: reply, flags: [MessageFlags.Ephemeral], allowedMentions: { parse: [] } });
  }

  @Slash({ name: 'zulip-unlink', description: 'Unlink your Zulip account', contexts: [InteractionContextType.Guild] })
  async zulipUnlink(interaction: CommandInteraction) {
    const reply = await this.mirrorLinks.unlinkIdentity({ discordUserId: interaction.user.id }, 'discord');
    await interaction.reply({ content: reply, flags: [MessageFlags.Ephemeral], allowedMentions: { parse: [] } });
  }

  /** The default member permissions can be overridden per server, so the permission is checked again here. */
  private async authorised(interaction: CommandInteraction) {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return true;
    }
    await interaction.reply({ content: NOT_AN_ADMIN, flags: [MessageFlags.Ephemeral] });
    return false;
  }

  /** Answers the interaction itself when it resolves to `undefined`. */
  private async target(interaction: CommandInteraction) {
    if (!(await this.authorised(interaction))) {
      return undefined;
    }
    const channelId = mirrorTarget(interaction);
    if (!channelId) {
      await interaction.reply({ content: IN_THREAD, flags: [MessageFlags.Ephemeral] });
    }
    return channelId;
  }

  private edit(interaction: CommandInteraction, content: string) {
    return interaction.editReply({ content: shorten(content, DISCORD_MESSAGE_LENGTH), allowedMentions: { parse: [] } });
  }
}
