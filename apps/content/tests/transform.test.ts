import { describe, expect, it } from 'vitest';
import { mediaTypeFor, negotiateFormat } from '../src/transform.ts';

describe('negotiateFormat', () => {
  it('honours an explicitly signed format', () => {
    expect(negotiateFormat('avif', 'image/webp,*/*')).toBe('avif');
    expect(negotiateFormat('webp', 'image/avif,image/webp,*/*')).toBe('webp');
  });

  it('prefers avif when the browser says it can decode it', () => {
    expect(negotiateFormat('auto', 'image/avif,image/webp,image/*,*/*;q=0.8')).toBe('avif');
  });

  it('falls back to webp when avif is not offered', () => {
    expect(negotiateFormat('auto', 'image/webp,image/*,*/*;q=0.8')).toBe('webp');
    expect(negotiateFormat('auto', null)).toBe('webp');
    expect(negotiateFormat(undefined, null)).toBe('webp');
  });

  it('maps a format to the media type stored on the variant', () => {
    expect(mediaTypeFor('avif')).toBe('image/avif');
    expect(mediaTypeFor('webp')).toBe('image/webp');
  });
});
