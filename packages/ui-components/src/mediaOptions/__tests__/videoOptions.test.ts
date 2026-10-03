/**
 * The rules behind the three video choices.
 *
 * Worth their own suite because they are the only chance an instructor gets:
 * the choices are made once, at upload time, and every surface shows the
 * result read-only afterwards. A default that quietly flipped, or a coupling
 * that let "Keep the original" be unticked when there is no second copy to
 * keep it beside, would delete someone's only lecture recording.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIDEO_OPTIONS,
  applyVideoOption,
  canDropOriginal,
  warnsWithoutOptimising,
} from '../videoOptions.ts';

describe('the video options', () => {
  it('starts optimised, keeping the original, with no student download', () => {
    expect(DEFAULT_VIDEO_OPTIONS).toEqual({
      optimise: true,
      keepOriginal: true,
      allowDownload: false,
    });
  });

  it('cannot be mutated through the shared default', () => {
    expect(Object.isFrozen(DEFAULT_VIDEO_OPTIONS)).toBe(true);
  });

  it('forces the original to be kept the moment optimising is turned off', () => {
    const dropped = applyVideoOption(DEFAULT_VIDEO_OPTIONS, 'keepOriginal', false);
    expect(dropped.keepOriginal).toBe(false);

    const unoptimised = applyVideoOption(dropped, 'optimise', false);
    expect(unoptimised.keepOriginal).toBe(true);
    expect(canDropOriginal(unoptimised)).toBe(false);
  });

  it('lets the original be dropped again once optimising is back on', () => {
    const unoptimised = applyVideoOption(DEFAULT_VIDEO_OPTIONS, 'optimise', false);
    const reoptimised = applyVideoOption(unoptimised, 'optimise', true);

    expect(canDropOriginal(reoptimised)).toBe(true);
    expect(applyVideoOption(reoptimised, 'keepOriginal', false).keepOriginal).toBe(false);
  });

  it('leaves the download choice alone whichever way the other two go', () => {
    const allowed = applyVideoOption(DEFAULT_VIDEO_OPTIONS, 'allowDownload', true);
    expect(applyVideoOption(allowed, 'optimise', false).allowDownload).toBe(true);
  });

  it('warns about a .mov only while optimising is off', () => {
    const off = applyVideoOption(DEFAULT_VIDEO_OPTIONS, 'optimise', false);
    expect(warnsWithoutOptimising('screen.mov', off)).toBe(true);
    expect(warnsWithoutOptimising('Screen Recording.MOV', off)).toBe(true);
    expect(warnsWithoutOptimising('screen.mov', DEFAULT_VIDEO_OPTIONS)).toBe(false);
    expect(warnsWithoutOptimising('lecture.mp4', off)).toBe(false);
    expect(warnsWithoutOptimising('.mov', off)).toBe(false);
  });
});
