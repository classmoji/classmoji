/**
 * The checks the CX-2 rehearsal helper runs before it loads the auth server
 * (./support/rehearsalTarget.ts).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  REHEARSAL_MARKER_USER_ID,
  assertRehearsalTarget,
  rehearsalTarget,
} from './support/rehearsalTarget.ts';

const NEON =
  'postgresql://owner:pw@ep-quiet-river-123456.us-east-2.aws.neon.tech/neondb?sslmode=require';
const LOCAL = 'postgresql://classmoji:classmoji@localhost:5433/classmoji_rehearsal';

describe('rehearsalTarget', () => {
  it.each([
    [undefined, 'neondb', /OAUTH_REHEARSAL_DATABASE_URL is not set/],
    ['not a url', 'neondb', /is not a URL/],
    ['postgresql://u:p@localhost:5433/', 'neondb', /names no database/],
    [
      NEON,
      undefined,
      /set OAUTH_REHEARSAL_DATABASE_NAME to the database it connects to \(neondb\)/,
    ],
    [NEON, '', /set OAUTH_REHEARSAL_DATABASE_NAME/],
    [NEON, 'neondb2', /OAUTH_REHEARSAL_DATABASE_NAME is "neondb2", the URL names "neondb"/],
    [LOCAL, 'neondb', /the URL names "classmoji_rehearsal"/],
  ])('refuses %s named %s', (url, name, reason) => {
    const target = rehearsalTarget(url, name);
    expect(target).toHaveProperty('refused');
    expect((target as { refused: string }).refused).toMatch(reason);
  });

  it.each([
    'postgresql://u:p@db.example.org:5432/neondb',
    'postgresql://u:p@10.0.0.5:5432/neondb',
    'postgresql://u:p@neon.tech/neondb',
    'postgresql://u:p@xneon.tech/neondb',
    'postgresql://u:p@ep-a.neon.tech.example.org/neondb',
  ])('refuses a host that is neither this machine nor a Neon endpoint: %s', url => {
    expect(rehearsalTarget(url, 'neondb')).toEqual({
      refused: expect.stringMatching(/is neither this machine nor a Neon endpoint/),
    });
  });

  it.each([
    [NEON, 'neondb', { host: 'ep-quiet-river-123456.us-east-2.aws.neon.tech', neon: true }],
    [
      'postgresql://o:p@ep-quiet-river-123456-pooler.us-east-2.aws.neon.tech/neondb',
      'neondb',
      { host: 'ep-quiet-river-123456-pooler.us-east-2.aws.neon.tech', neon: true },
    ],
    [LOCAL, 'classmoji_rehearsal', { host: 'localhost', neon: false }],
    ['postgresql://u:p@127.0.0.1:5433/r_it', 'r_it', { host: '127.0.0.1', neon: false }],
    ['postgresql://u:p@[::1]:5433/r_it', 'r_it', { host: '[::1]', neon: false }],
    ['postgresql://u:p@localhost:5433/my%20db', 'my db', { host: 'localhost', neon: false }],
  ])('names the target when the name matches: %s', (url, name, expected) => {
    expect(rehearsalTarget(url, name)).toEqual({ database: name, ...expected });
  });
});

describe('assertRehearsalTarget', () => {
  it('reads the target only once the URL checks pass', async () => {
    const hasMarker = vi.fn(async () => true);
    await expect(assertRehearsalTarget(NEON, 'other', hasMarker)).rejects.toThrow(
      /rehearsal refused: OAUTH_REHEARSAL_DATABASE_NAME/
    );
    await expect(
      assertRehearsalTarget('postgresql://u:p@db.example.org/neondb', 'neondb', hasMarker)
    ).rejects.toThrow(/neither this machine nor a Neon endpoint/);
    expect(hasMarker).not.toHaveBeenCalled();
  });

  it.each([NEON, LOCAL])('refuses %s without the rehearsal’s own user', async url => {
    const name = new URL(url).pathname.slice(1);
    await expect(assertRehearsalTarget(url, name, async () => false)).rejects.toThrow(
      new RegExp(`has no user ${REHEARSAL_MARKER_USER_ID}`)
    );
  });

  it('runs on a target that holds it', async () => {
    const hasMarker = vi.fn(async () => true);
    await expect(assertRehearsalTarget(NEON, 'neondb', hasMarker)).resolves.toMatchObject({
      database: 'neondb',
      neon: true,
    });
    expect(hasMarker).toHaveBeenCalledTimes(1);
  });

  it('is the user the rehearsal’s window step creates', () => {
    expect(REHEARSAL_MARKER_USER_ID).toBe('cx2-rehearsal-user');
  });
});
