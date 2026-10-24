import { describe, expect, it } from 'vitest';
import { shouldFocusInput } from '../focusInput';

describe('shouldFocusInput', () => {
  it('focuses on a plain click (a collapsed selection)', () => {
    expect(shouldFocusInput({ isCollapsed: true })).toBe(true);
  });

  it('leaves focus alone while text is selected, so it can be copied', () => {
    expect(shouldFocusInput({ isCollapsed: false })).toBe(false);
  });

  it('focuses where there is no selection object', () => {
    expect(shouldFocusInput(null)).toBe(true);
  });
});
