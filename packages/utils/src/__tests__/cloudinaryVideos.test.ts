import { describe, it, expect } from 'vitest';
import { cloudinaryVideoSelection } from '../cloudinaryVideos.ts';

// Cloudinary video hosting is billed per account, so it is Pro-only. These
// cases pin the gate itself: apps/slides has Playwright only, so without them
// nothing would notice the import route silently honouring `requested` again.
describe('cloudinaryVideoSelection', () => {
  const requested = ['videos/intro.mp4', 'videos/demo.webm'];

  it('passes the requested paths through for a Pro classroom with Cloudinary configured', () => {
    expect(cloudinaryVideoSelection({ isPro: true, configured: true, requested })).toEqual(
      requested
    );
  });

  it('drops every path for a non-Pro classroom, even when Cloudinary is configured', () => {
    expect(cloudinaryVideoSelection({ isPro: false, configured: true, requested })).toEqual([]);
  });

  it('drops every path when Cloudinary is not configured, even for a Pro classroom', () => {
    expect(cloudinaryVideoSelection({ isPro: true, configured: false, requested })).toEqual([]);
  });

  it('returns an empty list when nothing was requested', () => {
    expect(cloudinaryVideoSelection({ isPro: true, configured: true, requested: [] })).toEqual([]);
  });

  // The route hands the result straight to processZipImport, which builds a Set
  // from it; returning the caller's own array would let later mutation of one
  // reach the other.
  it('returns a copy rather than the caller’s array', () => {
    const result = cloudinaryVideoSelection({ isPro: true, configured: true, requested });
    expect(result).not.toBe(requested);
  });
});
