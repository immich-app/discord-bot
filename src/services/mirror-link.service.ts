import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { Constants } from 'src/constants';
import { neutraliseZulipMentions, plural } from 'src/format';
import { IDatabaseRepository, MirrorIdentityOwner } from 'src/interfaces/database.interface';
import {
  DiscordMirrorChannel,
  DiscordMirrorError,
  IDiscordMirrorInterface,
} from 'src/interfaces/discord-mirror.interface';
import { IZulipInterface, ZulipStream } from 'src/interfaces/zulip.interface';
import { EMPTY_TOPIC_NAME, topicKey } from 'src/mirror/names';
import { holdsIdentityRole, mainTopicProblem } from 'src/mirror/pairs';
import { escapeDiscordInline } from 'src/mirror/zulip-to-discord';
import { MirrorLink } from 'src/schema';
import {
  BackfillOutcome,
  BackfillPlan,
  BackfillRefusal,
  BackfillTarget,
  describeBackfillStop,
  MirrorService,
} from 'src/services/mirror.service';
import { ZulipService } from 'src/services/zulip.service';

export type MirrorPlatform = 'discord' | 'zulip';

export type MirrorActor = { platform: MirrorPlatform; id: string; name: string };

/** `summary` restates the announcement, which a Zulip reply in the announcement's own topic leaves out. */
export type MirrorLinkReply = {
  summary: string;
  details: string[];
  zulipAnnouncement?: { streamId: number; topic: string };
};

export type MirrorLinkRequest = { zulipStreamId: number; mainTopic?: string; actor: MirrorActor };

export type MirrorLinkCompletion = { linkId: string; discordChannelId: string; actor: MirrorActor };

export type MirrorUnlinkRequest = ({ discordChannelId: string } | { zulipStreamId: number }) & {
  actor: MirrorActor;
};

export type MirrorBackfillRequest = { target: BackfillTarget; actor: MirrorActor };

/** `done` resolves to the report, or to nothing when the notices in the topic say it all. */
export type MirrorBackfillReply = { reply: string } | { done: Promise<string | undefined> };

type PendingCode = { discordUserId: string; discordName: string; expiresAt: number };

type PendingLink = { zulipStreamId: number; mainTopic?: string; requestedBy: MirrorActor; expiresAt: number };

type Names = { channel?: DiscordMirrorChannel; stream?: ZulipStream };

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60 * 1000;
const LINK_ID_LENGTH = 6;
const LINK_ID_TTL_MS = 60 * 60 * 1000;
const FORUM_ANNOUNCEMENT_TOPIC = 'mirror';
const REQUIRED_PERMISSIONS = ['ViewChannel', 'ManageWebhooks'];
const PLATFORM_NAMES: Record<MirrorPlatform, string> = { discord: 'Discord', zulip: 'Zulip' };

const text = (platform: MirrorPlatform, value: string) =>
  platform === 'zulip' ? neutraliseZulipMentions(value) : escapeDiscordInline(value);

const code = (platform: MirrorPlatform, value: string) => {
  const inline = value.replaceAll('`', '').replaceAll(/\s+/g, ' ');
  return `\`${platform === 'zulip' ? neutraliseZulipMentions(inline) : inline}\``;
};

const channelName = (platform: MirrorPlatform, id: string, channel?: DiscordMirrorChannel) =>
  channel ? `**#${text(platform, channel.name)}** (${id})` : id;

const streamName = (platform: MirrorPlatform, id: number, stream?: Pick<ZulipStream, 'name'>) =>
  stream ? `**#${text(platform, stream.name)}** (${id})` : String(id);

const actorName = (platform: MirrorPlatform, { name, platform: from }: MirrorActor) =>
  `${text(platform, name)} on ${PLATFORM_NAMES[from]}`;

const describeError = (error: unknown) =>
  error instanceof DiscordMirrorError
    ? error.code === undefined
      ? error.kind
      : `${error.kind} (${error.code})`
    : error instanceof Error
      ? error.message
      : String(error);

const BACKFILL_REFUSALS: Record<MirrorPlatform, Record<BackfillRefusal, string>> = {
  discord: {
    off: 'The mirror is off in this deployment: Discord or Zulip is not configured.',
    'not-linked': 'This channel is not mirrored with Zulip, so there is nothing to backfill.',
    'no-conversation': 'This thread is not mirrored with a Zulip topic, so there is nothing to backfill.',
    'not-ready': 'The mirror of this channel is not running right now, so nothing can be backfilled; the log says why.',
    running: 'A backfill of this conversation is already running; its end notice on Zulip says when it is done.',
  },
  zulip: {
    off: 'The mirror is off in this deployment: Discord or Zulip is not configured.',
    'not-linked': 'This stream is not mirrored with a Discord channel, so there is nothing to backfill.',
    'no-conversation':
      'This topic is not linked with a Discord channel or thread, so there is nothing to backfill from.',
    'not-ready': 'The mirror of this stream is not running right now, so nothing can be backfilled; the log says why.',
    running: 'A backfill of this topic is already running; its end notice here says when it is done.',
  },
};

const locationName = ({ kind, threadId }: Pick<BackfillPlan, 'kind' | 'threadId'>) =>
  threadId === null ? 'channel' : kind === 'forum' ? 'post' : 'thread';

const announcementTopic = (link: Pick<MirrorLink, 'mainTopic'>) => link.mainTopic ?? FORUM_ANNOUNCEMENT_TOPIC;

const randomCode = (length: number) =>
  Array.from({ length }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

const toCode = (typed: string) => typed.toUpperCase().replaceAll(/[\s-]/g, '');

/** Links (Discord channel to Zulip stream) and identities (Zulip user to Discord user), and what announces them. */
@Injectable()
export class MirrorLinkService {
  private logger = new Logger(MirrorLinkService.name);
  private codes = new Map<string, PendingCode>();
  private pendingLinks = new Map<string, PendingLink>();

  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    @Inject(IDiscordMirrorInterface) private discordMirror: IDiscordMirrorInterface,
    @Inject(IZulipInterface) private zulip: IZulipInterface,
    private mirror: MirrorService,
    private zulipService: ZulipService,
  ) {}

  /**
   * The first half of a link, on Zulip: nothing changes until an administrator completes it on Discord, in the channel
   * to link, with the ID this answers with. IDs live in memory only: a restart voids the ones not used yet.
   */
  async requestLink({ zulipStreamId, mainTopic, actor }: MirrorLinkRequest) {
    if (!this.mirror.isActive()) {
      return 'The mirror is off in this deployment: Discord or Zulip is not configured.';
    }
    const problem = mainTopic === undefined ? undefined : mainTopicProblem(mainTopic);
    if (problem) {
      return `Could not use ${code('zulip', mainTopic!)}: ${problem}.`;
    }
    if (mainTopic !== undefined && (topicKey(mainTopic) === '' || mainTopic === this.generalChat())) {
      mainTopic = '';
    }
    const taken = (await this.database.getMirrorLinks()).find((link) => link.zulipStreamId === zulipStreamId);
    if (taken) {
      const names = await this.names(taken);
      return `This stream is already mirrored with the Discord channel ${channelName('zulip', taken.discordChannelId, names.channel)}: a stream can be in one link only, so unlink it first with ${code('zulip', 'mirror-unlink')}.`;
    }

    const now = Date.now();
    let replaced = false;
    for (const [id, pending] of this.pendingLinks) {
      if (pending.zulipStreamId === zulipStreamId) {
        replaced ||= pending.expiresAt > now;
        this.pendingLinks.delete(id);
      } else if (pending.expiresAt <= now) {
        this.pendingLinks.delete(id);
      }
    }
    let linkId = randomCode(LINK_ID_LENGTH);
    while (this.pendingLinks.has(linkId)) {
      linkId = randomCode(LINK_ID_LENGTH);
    }
    this.pendingLinks.set(linkId, { zulipStreamId, mainTopic, requestedBy: actor, expiresAt: now + LINK_ID_TTL_MS });
    this.logger.log(`Zulip user ${actor.id} asked to link Zulip stream ${zulipStreamId}`);

    return [
      `To mirror this stream with a Discord channel, run ${code('zulip', `/mirror-link id:${linkId}`)} in that channel on the Immich Discord server (for a forum, in any of its posts); it takes a member with the Administrator permission there. The ID expires in 1 hour and works once. Nothing is mirrored until then.`,
      `A text channel's own messages will go to ${this.describeMainTopic('zulip', mainTopic ?? '')}${mainTopic === undefined ? ` (${code('zulip', 'mirror-link topic=<name>')} names another)` : ''}; a forum has no main topic, each post gets a topic of its own.`,
      ...(replaced ? ['This replaces the earlier request for this stream, whose ID no longer works.'] : []),
    ].join('\n');
  }

  /** The second half of a link, on Discord, in the channel to link. */
  async completeLink({ linkId, discordChannelId, actor }: MirrorLinkCompletion): Promise<MirrorLinkReply> {
    const p = actor.platform;
    const refuse = (summary: string): MirrorLinkReply => ({ summary, details: [] });
    if (!this.mirror.isActive()) {
      return refuse('The mirror is off in this deployment: Discord or Zulip is not configured.');
    }
    const typedId = toCode(linkId);
    const pending = this.pendingLinks.get(typedId);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pendingLinks.delete(typedId);
      return refuse(
        `${code(p, linkId)} is not a link ID, or it has expired or been used. Start again in the Zulip stream to link, with ${code(p, `@${this.zulipService.ownUser?.fullName || 'the bot'} mirror-link`)}.`,
      );
    }
    const { zulipStreamId, requestedBy } = pending;

    const links = await this.database.getMirrorLinks();
    const taken =
      links.find((link) => link.discordChannelId === discordChannelId) ??
      links.find((link) => link.zulipStreamId === zulipStreamId);
    if (taken) {
      const names = await this.names(taken);
      return refuse(
        `Discord channel ${channelName(p, taken.discordChannelId, names.channel)} is already mirrored with Zulip stream ${streamName(p, taken.zulipStreamId, names.stream)}: a channel and a stream can each be in one link only, so unlink that one first.`,
      );
    }

    let channel: DiscordMirrorChannel | undefined;
    try {
      channel = await this.discordMirror.getMirrorChannel(discordChannelId);
    } catch (error) {
      return refuse(`Could not read Discord channel ${discordChannelId}: ${describeError(error)}.`);
    }
    if (!channel) {
      return refuse(`Discord channel ${discordChannelId} does not exist, or the bot cannot see it.`);
    }
    if (channel.kind === 'other') {
      return refuse(
        `Discord channel ${channelName(p, discordChannelId, channel)} is neither a text channel nor a forum.`,
      );
    }
    const missingRequired = channel.missingPermissions.filter((permission) =>
      REQUIRED_PERMISSIONS.includes(permission),
    );
    if (missingRequired.length > 0) {
      return refuse(
        `The bot needs ${REQUIRED_PERMISSIONS.join(' and ')} in Discord channel ${channelName(p, discordChannelId, channel)} to mirror it, and is missing ${missingRequired.join(', ')}.`,
      );
    }
    const details: string[] = [];
    let topic: string | null = null;
    if (channel.kind === 'text') {
      topic = pending.mainTopic ?? '';
    } else if (pending.mainTopic !== undefined) {
      details.push(`The main topic ${code(p, pending.mainTopic)} is not used: a forum has none.`);
    }

    let stream: ZulipStream;
    try {
      stream = await this.zulip.getStream(zulipStreamId);
    } catch (error) {
      return refuse(`Zulip stream ${zulipStreamId} does not exist, or the bot cannot see it: ${describeError(error)}.`);
    }
    const subscriptions = await this.zulip.getSubscriptions();
    if (!subscriptions.some(({ streamId }) => streamId === zulipStreamId)) {
      return refuse(
        `The bot is not subscribed to Zulip stream ${streamName(p, zulipStreamId, stream)}, so it could neither read nor post there: subscribe it first.`,
      );
    }

    let link: MirrorLink;
    try {
      link = await this.database.createMirrorLink({
        discordChannelId,
        zulipStreamId,
        kind: channel.kind,
        mainTopic: topic,
        createdBy: `${requestedBy.name} on Zulip (user ${requestedBy.id}) and ${actor.name} on Discord (user ${actor.id})`,
      });
    } catch (error) {
      return refuse(`Could not save the link: ${describeError(error)}.`);
    }
    this.pendingLinks.delete(typedId);
    this.logger.log(
      `Discord channel ${discordChannelId} is now linked with Zulip stream ${zulipStreamId}, by Zulip user ${requestedBy.id} and Discord user ${actor.id}`,
    );

    details.unshift(this.visibility(p, channel, stream));
    const optional = channel.missingPermissions.filter((permission) => !REQUIRED_PERMISSIONS.includes(permission));
    if (optional.length > 0) {
      details.push(
        `⚠ The bot is missing ${optional.join(', ')} in the Discord channel; some messages, files or threads are not mirrored until it has them.`,
      );
    }
    if (!(await this.mirror.enable(link))) {
      details.push(
        '⚠ The link is saved, but the mirror has not started it yet; it tries again at its next check of the channel, within ten minutes, and the log says why.',
      );
    }

    const linkedBy = (platform: MirrorPlatform) =>
      `requested by ${actorName(platform, requestedBy)} and completed by ${actorName(platform, actor)}`;
    await this.announceOnZulip(
      link,
      [
        `🔗 This stream is now mirrored with the Discord channel ${channelName('zulip', discordChannelId, channel)}, ${linkedBy('zulip')}. Everything posted here is copied to Discord, and everything posted there is copied here.`,
        topic === null
          ? 'Each topic here is a post in the Discord forum, and each post there is a topic here.'
          : `Messages in ${this.describeMainTopic('zulip', topic)} go to the Discord channel itself; every other topic becomes a thread there, and every thread there a topic here.`,
      ].join(' '),
      details,
    );
    const pinned = await this.announceOnDiscord(
      link,
      `Mirrored with Zulip #${stream.name}`,
      [
        `🔗 This channel is now mirrored with the Zulip stream ${streamName('discord', zulipStreamId, stream)}, ${linkedBy('discord')}. Everything posted here is copied to Zulip, and everything posted there is copied here.`,
        topic === null
          ? 'Each post here is a topic in the Zulip stream, and each topic there is a post here.'
          : `Messages in this channel go to ${this.describeMainTopic('discord', topic, 'Zulip ')}; each thread gets a topic of its own.`,
      ].join(' '),
      true,
      details,
    );
    if (pinned) {
      await this.database.setMirrorLinkAnnouncement(discordChannelId, pinned);
    }

    return {
      summary: `Linked Discord channel ${channelName(p, discordChannelId, channel)} with Zulip stream ${streamName(p, zulipStreamId, stream)}: everything posted on either side is now copied to the other. ${
        topic === null
          ? 'Each forum post is a topic of its own.'
          : `The channel's own messages go to ${this.describeMainTopic(p, topic)}, and each thread gets a topic of its own.`
      }`,
      details,
    };
  }

  async unlink(request: MirrorUnlinkRequest): Promise<MirrorLinkReply> {
    const { actor } = request;
    const p = actor.platform;
    const links = await this.database.getMirrorLinks();
    const found =
      'discordChannelId' in request
        ? links.find(({ discordChannelId }) => discordChannelId === request.discordChannelId)
        : links.find(({ zulipStreamId }) => zulipStreamId === request.zulipStreamId);
    const removed = found && (await this.database.removeMirrorLink(found.discordChannelId));
    if (!removed) {
      const summary =
        'discordChannelId' in request
          ? `Discord channel ${request.discordChannelId} is not mirrored with any Zulip stream.`
          : `Zulip stream ${request.zulipStreamId} is not mirrored with any Discord channel.`;
      return { summary, details: [] };
    }
    this.mirror.disable(removed.discordChannelId);
    this.logger.log(
      `Discord channel ${removed.discordChannelId} is no longer linked with Zulip stream ${removed.zulipStreamId}, by ${actor.platform} user ${actor.id}`,
    );

    const { channel, stream } = await this.names(removed);
    const details: string[] = [];
    const zulipAnnouncement = await this.announceOnZulip(
      removed,
      `✂️ This stream is no longer mirrored with the Discord channel ${channelName('zulip', removed.discordChannelId, channel)}, unlinked by ${actorName('zulip', actor)}. Nothing posted here is copied to Discord any more, and nothing posted there is copied here.`,
      details,
    );
    await this.announceOnDiscord(
      removed,
      'No longer mirrored with Zulip',
      `✂️ This channel is no longer mirrored with the Zulip stream ${streamName('discord', removed.zulipStreamId, stream)}, unlinked by ${actorName('discord', actor)}. Nothing posted here is copied to Zulip any more, and nothing posted there is copied here.`,
      false,
      details,
    );
    if (removed.discordAnnouncementId) {
      try {
        await this.discordMirror.unpinMirrorNotice(removed.discordChannelId, removed.discordAnnouncementId);
      } catch (error) {
        details.push(`⚠ Could not unpin the link announcement on Discord: ${describeError(error)}.`);
      }
    }

    return {
      summary: `Unlinked Discord channel ${channelName(p, removed.discordChannelId, channel)} from Zulip stream ${streamName(p, removed.zulipStreamId, stream)}: nothing is copied between them any more. What was mirrored stays on both sides, and linking the two again carries on the same conversations.`,
      details,
      zulipAnnouncement,
    };
  }

  async list(platform: MirrorPlatform) {
    const p = platform;
    const [links, identities] = await Promise.all([
      this.database.getMirrorLinks(),
      this.database.getMirrorIdentities(),
    ]);
    const linkLines = await Promise.all(
      links.map(async (link) => {
        const { channel, stream } = await this.names(link);
        const layout =
          link.mainTopic === null
            ? 'forum, one topic per post'
            : `text channel, main topic ${link.mainTopic ? code(p, link.mainTopic) : this.generalChat()}`;
        const state = this.mirror.handlesChannel(link.discordChannelId) ? '' : ' (off: see the log)';
        return `- Discord channel ${channelName(p, link.discordChannelId, channel)} ↔ Zulip stream ${streamName(p, link.zulipStreamId, stream)}${state}: ${layout}; linked by ${text(p, link.createdBy)} on ${link.createdAt.toISOString().slice(0, 10)}`;
      }),
    );
    const identityLines = await Promise.all(
      identities.map(async ({ zulipUserId, discordUserId }) => {
        const [zulipUser, members] = await Promise.all([
          this.zulip.getUser(zulipUserId).catch(() => undefined),
          Promise.all(
            Constants.Discord.Servers.map(async (guildId) => ({
              guildId,
              member: await this.discordMirror.getTeamMember(guildId, discordUserId).catch(() => undefined),
            })),
          ),
        ]);
        const found = members.filter(({ member }) => member);
        const verified = found.find(({ guildId, member }) => holdsIdentityRole(guildId, member!.roleIds));
        const member = (verified ?? found[0])?.member;
        const unused = verified ? '' : ' (not used: not a member with the Team or Immich role)';
        const zulipName = zulipUser ? `${text(p, zulipUser.fullName)} ` : '';
        const discordName = member ? `${text(p, member.displayName)} ` : '';
        return `- ${zulipName}(Zulip user ${zulipUserId}) ↔ ${discordName}(Discord user ${discordUserId})${unused}`;
      }),
    );
    return [
      links.length === 0 ? 'No channel is mirrored.' : 'Mirrored channels:',
      ...linkLines,
      identities.length === 0
        ? 'No accounts are linked.'
        : 'Linked accounts, whose Zulip messages appear on Discord under their Discord name:',
      ...identityLines,
    ].join('\n');
  }

  /** Codes live in memory only: a restart voids the ones not used yet. */
  async requestIdentityCode(user: { id: string; name: string }) {
    const now = Date.now();
    for (const [pending, { discordUserId, expiresAt }] of this.codes) {
      if (expiresAt <= now || discordUserId === user.id) {
        this.codes.delete(pending);
      }
    }
    let created = randomCode(CODE_LENGTH);
    while (this.codes.has(created)) {
      created = randomCode(CODE_LENGTH);
    }
    this.codes.set(created, { discordUserId: user.id, discordName: user.name, expiresAt: now + CODE_TTL_MS });

    const current = (await this.database.getMirrorIdentities()).find(({ discordUserId }) => discordUserId === user.id);
    const botName = this.zulipService.ownUser?.fullName || 'the bot';
    return [
      `Your code is \`${created}\`. Within 10 minutes, send it to ${escapeDiscordInline(botName)} in a direct message on Zulip, as \`link ${created}\`: the Zulip account that sends it is linked with your Discord account. The code works once.`,
      ...(current
        ? [`You are linked with Zulip user ${current.zulipUserId} now; the new link replaces that one.`]
        : []),
      'Your Zulip messages then appear on Discord under your Discord name and avatar, as long as you hold the Team or Immich role.',
    ].join('\n');
  }

  async redeemIdentityCode(sender: { id: number; fullName: string }, typed: string) {
    const typedCode = toCode(typed);
    const pending = this.codes.get(typedCode);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.codes.delete(typedCode);
      return 'That code is not valid, or it has expired. Run `/zulip-link` on Discord for a new one.';
    }
    this.codes.delete(typedCode);

    const replaced = await this.database.setMirrorIdentity(sender.id, pending.discordUserId);
    await this.mirror.refreshIdentities();
    this.logger.log(`Zulip user ${sender.id} is now linked with Discord user ${pending.discordUserId}`);
    const previous = replaced.filter(
      ({ zulipUserId, discordUserId }) => zulipUserId !== sender.id || discordUserId !== pending.discordUserId,
    );
    return [
      `Linked your Zulip account with the Discord account ${text('zulip', pending.discordName)} (user ${pending.discordUserId}). Your Zulip messages now appear on Discord under that name and avatar, as long as it holds the Team or Immich role.`,
      ...previous.map(
        ({ zulipUserId, discordUserId }) =>
          `It replaces the link of Zulip user ${zulipUserId} with Discord user ${discordUserId}.`,
      ),
    ].join('\n');
  }

  async unlinkIdentity(owner: MirrorIdentityOwner, platform: MirrorPlatform) {
    const removed = await this.database.removeMirrorIdentity(owner);
    if (!removed) {
      return `Your ${PLATFORM_NAMES[platform]} account is not linked.`;
    }
    await this.mirror.refreshIdentities();
    this.logger.log(`Zulip user ${removed.zulipUserId} is no longer linked with Discord user ${removed.discordUserId}`);
    return `Unlinked Zulip user ${removed.zulipUserId} from Discord user ${removed.discordUserId}: those Zulip messages appear on Discord as "Name (Zulip)" again.`;
  }

  /** Discord to Zulip only, from where it is run: a thread or forum post, or a text channel's own messages. */
  async backfill(
    { target, actor }: MirrorBackfillRequest,
    acknowledge: (ack: string) => Promise<void>,
  ): Promise<MirrorBackfillReply> {
    const p = actor.platform;
    const result = await this.mirror.backfill(target, (plan) => acknowledge(this.backfillAck(p, plan)));
    if ('refused' in result) {
      return { reply: BACKFILL_REFUSALS[p][result.refused] };
    }
    this.logger.log(`${PLATFORM_NAMES[p]} user ${actor.id} started a backfill of the Discord history`);
    return { done: result.done.then((outcome) => this.backfillReport(p, outcome)) };
  }

  private backfillAck(platform: MirrorPlatform, plan: BackfillPlan) {
    const where = locationName(plan);
    if (platform === 'zulip') {
      return `📜 Copying the messages of the Discord ${where} ${plan.threadId ?? plan.discordChannelId} that are not on Zulip yet into this topic, oldest first, up to the newest one now. Notices here mark where the history starts and where it ends, and new messages from Discord wait until it is done; a long history takes a while.`;
    }
    const stream = streamName(
      'discord',
      plan.zulipStreamId,
      plan.stream === undefined ? undefined : { name: plan.stream },
    );
    const topic =
      plan.topic === undefined
        ? `a new topic of the Zulip stream ${stream}`
        : `${this.describeMainTopic('discord', plan.topic)} of the Zulip stream ${stream}`;
    return `📜 Copying the messages of this ${where} that are not on Zulip yet into ${topic}, oldest first, up to the newest one now. Notices there mark where the history starts and where it ends, and new messages here wait until it is done. A long history takes a while; the end notice on Zulip is the report.`;
  }

  private backfillReport(platform: MirrorPlatform, { copied, failed, noticed, stopped }: BackfillOutcome) {
    if (!noticed) {
      if (stopped) {
        return `The backfill stopped before copying anything: ${describeBackfillStop(stopped)}.`;
      }
      return platform === 'zulip'
        ? 'Nothing to backfill: every Discord message of this conversation is already on Zulip.'
        : 'Nothing to backfill: every message here is already on Zulip.';
    }
    if (platform === 'zulip') {
      return undefined;
    }
    const failures = failed > 0 ? `; ${failed} could not be copied, see the log` : '';
    return stopped
      ? `The backfill stopped after copying ${plural(copied, 'message')}${failures}: ${describeBackfillStop(stopped)}.`
      : `Done: copied ${plural(copied, 'message')} to Zulip${failures}.`;
  }

  private generalChat() {
    return this.zulipService.emptyTopicName ?? EMPTY_TOPIC_NAME;
  }

  private describeMainTopic(platform: MirrorPlatform, topic: string, where = '') {
    return topic ? `the ${where}topic ${code(platform, topic)}` : `the ${where}${this.generalChat()} topic`;
  }

  private visibility(platform: MirrorPlatform, channel: DiscordMirrorChannel, stream: ZulipStream) {
    const discord = channel.everyoneCanView
      ? 'the Discord channel is visible to @everyone'
      : 'the Discord channel is not visible to @everyone';
    const zulip = stream.inviteOnly ? 'the Zulip stream is private' : 'the Zulip stream is public to the organization';
    return `Who can read it: ${text(platform, discord)}; ${zulip}.`;
  }

  private async names(link: Pick<MirrorLink, 'discordChannelId' | 'zulipStreamId'>): Promise<Names> {
    const [channel, stream] = await Promise.all([
      this.discordMirror.getMirrorChannel(link.discordChannelId).catch(() => undefined),
      this.zulip.getStream(link.zulipStreamId).catch(() => undefined),
    ]);
    return { channel, stream };
  }

  private async announceOnZulip(link: MirrorLink, content: string, details: string[]) {
    const topic = announcementTopic(link);
    try {
      await this.zulip.sendMessage({ stream: link.zulipStreamId, topic, content });
      return { streamId: link.zulipStreamId, topic };
    } catch (error) {
      details.push(`⚠ Could not post the announcement in the Zulip stream: ${describeError(error)}.`);
      return undefined;
    }
  }

  /** Resolves to the ID of the pinned announcement, if it was pinned. */
  private async announceOnDiscord(link: MirrorLink, title: string, content: string, pin: boolean, details: string[]) {
    try {
      const notice = await this.discordMirror.sendMirrorNotice(link.discordChannelId, { title, content }, pin);
      if (pin && !notice.pinned) {
        details.push('⚠ Could not pin the announcement on Discord: the bot may not pin messages there.');
      }
      return notice.pinned ? notice.messageId : undefined;
    } catch (error) {
      details.push(`⚠ Could not post the announcement in the Discord channel: ${describeError(error)}.`);
      return undefined;
    }
  }
}
