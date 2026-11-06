/**
 * Unit tests for the build-time action origin list (apps/slides/actionOrigins.js).
 * Run in the Playwright runner without a browser or the dev stack.
 */
import { test, expect } from '@playwright/test';
import { actionOriginHosts } from '../../actionOrigins.js';
import config from '../../react-router.config.js';

const PROD = 'slides.classmoji.io';

const quietly = <T>(fn: () => T): T => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
};

test.describe('actionOriginHosts', () => {
  test('uses the production host when nothing is set', () => {
    expect(actionOriginHosts(undefined, PROD)).toEqual([PROD]);
    expect(actionOriginHosts('', PROD)).toEqual([PROD]);
    expect(actionOriginHosts('   ', PROD)).toEqual([PROD]);
  });

  test('takes the staging host when the build passes it', () => {
    expect(actionOriginHosts('slides.staging.classmoji.io', PROD)).toEqual([
      'slides.staging.classmoji.io',
    ]);
  });

  test('reads a comma-separated list of exact hosts, trimmed, lowercased and deduplicated', () => {
    expect(actionOriginHosts(' A.example.com , b.example.com,a.example.com ', PROD)).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
  });

  for (const [label, raw] of [
    ['a wildcard', '*.classmoji.io'],
    ['a double wildcard', '**.classmoji.io'],
    ['a scheme', 'https://slides.classmoji.io'],
    ['a port', 'slides.classmoji.io:443'],
    ['a path', 'slides.classmoji.io/x'],
    ['a single label', 'localhost'],
    ['an empty item', 'slides.classmoji.io,'],
    ['a stray comma', ','],
    ['one bad entry among good ones', 'slides.staging.classmoji.io,*.fly.dev'],
  ]) {
    test(`falls back to the production host for ${label}`, () => {
      expect(quietly(() => actionOriginHosts(raw, PROD))).toEqual([PROD]);
    });
  }
});

test.describe('react-router.config', () => {
  test('lists exactly one host by default, the production one', () => {
    expect(process.env.ACTION_ORIGIN_HOSTS ?? '').toBe('');
    expect(config.allowedActionOrigins).toEqual([PROD]);
  });
});
