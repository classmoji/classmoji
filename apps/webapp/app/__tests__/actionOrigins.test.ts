import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionOriginHosts } from '../../actionOrigins.js';
import config from '../../react-router.config.js';

const PROD = 'app.classmoji.io';

describe('actionOriginHosts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the production host when nothing is set', () => {
    expect(actionOriginHosts(undefined, PROD)).toEqual([PROD]);
    expect(actionOriginHosts('', PROD)).toEqual([PROD]);
    expect(actionOriginHosts('   ', PROD)).toEqual([PROD]);
  });

  it('takes the staging host when the build passes it', () => {
    expect(actionOriginHosts('staging.classmoji.io', PROD)).toEqual(['staging.classmoji.io']);
  });

  it('reads a comma-separated list of exact hosts, trimmed, lowercased and deduplicated', () => {
    expect(actionOriginHosts(' A.example.com , b.example.com,a.example.com ', PROD)).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
  });

  it.each([
    ['a wildcard', '*.classmoji.io'],
    ['a double wildcard', '**.classmoji.io'],
    ['a scheme', 'https://app.classmoji.io'],
    ['a port', 'app.classmoji.io:443'],
    ['a path', 'app.classmoji.io/x'],
    ['a single label', 'localhost'],
    ['an empty item', 'app.classmoji.io,'],
    ['a stray comma', ','],
    ['a space inside a host', 'app classmoji.io'],
    ['one bad entry among good ones', 'staging.classmoji.io,*.fly.dev'],
  ])('falls back to the production host for %s', (_label, raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(actionOriginHosts(raw, PROD)).toEqual([PROD]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('never returns an empty list', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const raw of [undefined, '', ',', ' , ', '*', 'x']) {
      expect(actionOriginHosts(raw, PROD).length).toBeGreaterThan(0);
    }
  });
});

describe('react-router.config', () => {
  it('lists exactly one host by default, the production one', () => {
    // The unit run sets no ACTION_ORIGIN_HOSTS.
    expect(process.env.ACTION_ORIGIN_HOSTS ?? '').toBe('');
    expect(config.allowedActionOrigins).toEqual([PROD]);
  });
});
