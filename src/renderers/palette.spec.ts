import { Colors } from 'discord.js';
import { NotificationAccent } from 'src/interfaces/notification.interface';
import { Palette } from 'src/renderers/palette';
import { describe, expect, it } from 'vitest';

/** The colour each accent has always rendered as, by its discord.js name. */
const ExpectedColors: Record<NotificationAccent, keyof typeof Colors> = {
  'pr.opened': 'Green',
  'pr.draft': 'Grey',
  'pr.merged': 'Purple',
  'pr.closed': 'Red',
  'issue.opened': 'Green',
  'issue.reopened': 'DarkGreen',
  'issue.closed': 'NotQuiteBlack',
  'discussion.created': 'Orange',
  'discussion.reopened': 'DarkOrange',
  'discussion.deleted': 'NotQuiteBlack',
  'discussion.answered': 'Green',
  'incident.resolved': 'Green',
  'incident.minor': 'Orange',
  'incident.major': 'Red',
  'incident.unknown': 'Grey',
  'purchase.live': 'Green',
  'purchase.test': 'Yellow',
  'order.placed': 'DarkGreen',
  'order.cancelled': 'Red',
  'order.test': 'Yellow',
  'report.licenses': 'Purple',
  'report.orders': 'DarkPurple',
  'release.failed': 'Red',
};

describe('Palette', () => {
  it('should map every accent to the exact discord.js colour it has always used', () => {
    const expected = Object.fromEntries(Object.entries(ExpectedColors).map(([accent, name]) => [accent, Colors[name]]));
    expect(Palette).toEqual(expected);
  });
});
