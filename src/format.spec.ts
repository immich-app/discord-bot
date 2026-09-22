import { asHexColor, shorten } from 'src/format';
import { describe, expect, it } from 'vitest';

describe('shorten', () => {
  it('should leave text at or under the limit alone', () => {
    expect(shorten('abc', 3)).toBe('abc');
  });

  it('should cut to the limit including the ellipsis', () => {
    expect(shorten('abcdefgh', 6)).toBe('abc...');
  });

  it('should default to 100 characters', () => {
    expect(shorten('x'.repeat(101))).toBe('x'.repeat(97) + '...');
  });
});

describe('asHexColor', () => {
  it('should format a colour as #rrggbb', () => {
    expect(asHexColor(0x57_f2_87)).toBe('#57f287');
  });

  it('should not zero-pad, matching what has always been sent', () => {
    expect(asHexColor(0x00_ff_00)).toBe('#ff00');
  });
});
