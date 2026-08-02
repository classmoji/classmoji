import { describe, it, expect } from 'vitest';

// Shim re-export smoke test: @classmoji/content moved into @classmoji/services
// and this package is now a thin re-export. Every symbol of the historical
// export surface must still resolve here, and must be the SAME binding the
// services package exports (not a copy).

import * as shim from '../index.ts';
import * as services from '@classmoji/services';

describe('@classmoji/content shim', () => {
  it('re-exports the full historical surface', () => {
    // Write operations
    expect(typeof shim.ContentService).toBe('function');
    expect(typeof shim.ContentService.put).toBe('function');
    expect(typeof shim.ContentService.uploadBatch).toBe('function');

    // URL builders
    expect(typeof shim.getContentUrl).toBe('function');
    expect(typeof shim.getSlideContentUrl).toBe('function');
    expect(typeof shim.getRawContentUrl).toBe('function');

    // Validation utilities
    expect(typeof shim.validateFile).toBe('function');
    expect(typeof shim.sanitizeFilename).toBe('function');
    expect(typeof shim.MAX_FILE_SIZE).toBe('number');
    expect(Array.isArray(shim.ALLOWED_EXTENSIONS)).toBe(true);

    // Content type utilities
    expect(typeof shim.getMimeType).toBe('function');
    expect(typeof shim.isBinaryFile).toBe('function');
    expect(typeof shim.isImageFile).toBe('function');
  });

  it('re-exports the exact bindings from @classmoji/services', () => {
    expect(shim.ContentService).toBe(services.ContentService);
    expect(shim.getContentUrl).toBe(services.getContentUrl);
    expect(shim.getSlideContentUrl).toBe(services.getSlideContentUrl);
    expect(shim.getRawContentUrl).toBe(services.getRawContentUrl);
    expect(shim.validateFile).toBe(services.validateFile);
    expect(shim.sanitizeFilename).toBe(services.sanitizeFilename);
    expect(shim.MAX_FILE_SIZE).toBe(services.MAX_FILE_SIZE);
    expect(shim.ALLOWED_EXTENSIONS).toBe(services.ALLOWED_EXTENSIONS);
    expect(shim.getMimeType).toBe(services.getMimeType);
    expect(shim.isBinaryFile).toBe(services.isBinaryFile);
    expect(shim.isImageFile).toBe(services.isImageFile);
  });

  it('behaves like the original module (spot checks)', () => {
    expect(
      shim.getContentUrl({ org: 'dali', repo: 'content-dali-26w', path: '/pages/x.html' })
    ).toBe('https://dali.github.io/content-dali-26w/pages/x.html');
    expect(
      shim.getSlideContentUrl({ orgLogin: 'dali', term: '26w', contentPath: 'slides/intro' })
    ).toBe('https://dali.github.io/content-dali-26w/slides/intro/index.html');
    expect(shim.getMimeType('photo.PNG')).toBe('image/png');
    expect(shim.isImageFile('photo.png')).toBe(true);
    expect(shim.isBinaryFile('doc.pdf')).toBe(true);
    expect(shim.validateFile({ filename: 'evil.exe', size: 10 }).valid).toBe(false);
  });
});
