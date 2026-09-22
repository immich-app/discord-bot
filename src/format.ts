/*
 * Plain string helpers with no platform imports. Renderers reach for these instead of `src/util`,
 * which depends on discord.js.
 */

export const shorten = (text: string, maxLength: number = 100) => {
  return text.length > maxLength ? `${text.substring(0, maxLength - 3)}...` : text;
};

/** `#rrggbb` for a Mattermost accent. Deliberately not zero-padded: that is what has always been sent. */
export const asHexColor = (color: number) => `#${color.toString(16)}`;
