/**
 * The `X-Classmoji-Timezone` hint: Ask Moji sends the student's browser zone so
 * `_local` fields have a zone when the classroom sets none. It is a rendering
 * hint, validated against Intl and silently dropped when invalid.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../auth/resolveViewer.ts', () => ({ resolveViewer: vi.fn() }));
vi.mock('../../mcp/registry.ts', () => ({ buildMcpServer: vi.fn() }));
vi.mock('../../resources/index.ts', () => ({ registerAllResources: vi.fn() }));

const { timezoneHintFrom, TIMEZONE_HEADER } = await import('../mcp.ts');

const headersWith = (value?: string) =>
  new Headers(value === undefined ? {} : { [TIMEZONE_HEADER]: value });

describe('timezoneHintFrom', () => {
  it('accepts a real zone, in its canonical spelling', () => {
    expect(timezoneHintFrom(headersWith('America/New_York'))).toBe('America/New_York');
    expect(timezoneHintFrom(headersWith('america/new_york'))).toBe('America/New_York');
  });

  it('ignores a missing, unknown or malformed value rather than failing the request', () => {
    expect(timezoneHintFrom(headersWith())).toBeNull();
    expect(timezoneHintFrom(headersWith('Mars/Olympus'))).toBeNull();
    expect(timezoneHintFrom(headersWith('America/New York'))).toBeNull();
    expect(timezoneHintFrom(headersWith('x'.repeat(100)))).toBeNull();
  });
});
