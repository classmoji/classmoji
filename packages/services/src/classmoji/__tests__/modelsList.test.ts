/**
 * getModelLabel names a model on the AI settings page ("Default: Claude
 * Sonnet 5"). The id comes from an env var or a code default, so it may or may
 * not be in the list the page loaded.
 */

import { describe, expect, it } from 'vitest';
import { getModelLabel } from '../modelsList.ts';

describe('getModelLabel', () => {
  it('uses the label from the loaded list first', () => {
    expect(
      getModelLabel('claude-opus-5-5', [{ value: 'claude-opus-5-5', label: 'Claude Opus 5.5' }])
    ).toBe('Claude Opus 5.5');
  });

  it('falls back to the fallback list for the code defaults', () => {
    expect(getModelLabel('claude-sonnet-5')).toBe('Claude Sonnet 5');
    expect(getModelLabel('claude-sonnet-4-5-20250929')).toBe('Claude Sonnet 4.5');
  });

  it.each([
    ['claude-opus-5-5', 'Claude Opus 5.5'],
    ['claude-sonnet-5', 'Claude Sonnet 5'],
    ['claude-opus-4-1-20250805', 'Claude Opus 4.1'],
    ['claude-opus-4-20250514', 'Claude Opus 4'],
    ['claude-fable-5-1', 'Claude Fable 5.1'],
  ])('formats a family-first id %s it has no label for', (id, label) => {
    expect(getModelLabel(id, [])).toBe(label);
  });

  it('still formats the version-first ids', () => {
    expect(getModelLabel('claude-3-5-sonnet-20241022')).toBe('Claude 3.5 Sonnet (Oct 2024)');
  });
});
