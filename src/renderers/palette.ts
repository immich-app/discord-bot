import { NotificationAccent } from 'src/interfaces/notification.interface';

/*
 * The colours are discord.js's `Colors` values, spelled out so this module depends on no platform.
 * Mattermost has always mirrored the Discord embed colour, so both renderers read this one table:
 * Discord passes the number to the embed and Mattermost formats it as `#rrggbb`.
 */
const Green = 0x57_f2_87;
const DarkGreen = 0x1f_8b_4c;
const Purple = 0x9b_59_b6;
const DarkPurple = 0x71_36_8a;
const Red = 0xed_42_45;
const Grey = 0x95_a5_a6;
const Orange = 0xe6_7e_22;
const DarkOrange = 0xa8_43_00;
const Yellow = 0xfe_e7_5c;
const NotQuiteBlack = 0x23_27_2a;

/** Accent token to plain RGB number. Several tokens sharing a colour is expected. */
export const Palette: Record<NotificationAccent, number> = {
  'pr.opened': Green,
  'pr.draft': Grey,
  'pr.merged': Purple,
  'pr.closed': Red,
  'issue.opened': Green,
  'issue.reopened': DarkGreen,
  'issue.closed': NotQuiteBlack,
  'discussion.created': Orange,
  'discussion.reopened': DarkOrange,
  'discussion.deleted': NotQuiteBlack,
  'discussion.answered': Green,
  'incident.resolved': Green,
  'incident.minor': Orange,
  'incident.major': Red,
  'incident.unknown': Grey,
  'purchase.live': Green,
  'purchase.test': Yellow,
  'order.placed': DarkGreen,
  'order.cancelled': Red,
  'order.test': Yellow,
  'report.licenses': Purple,
  'report.orders': DarkPurple,
  'release.failed': Red,
};
