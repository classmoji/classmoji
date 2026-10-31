import { describe, expect, it } from 'vitest';

import { TIER_POLICY, bucketExpiry } from '../bucket.ts';
import { filesCanonicalString, toBase64Url, utf8 } from '../canonical.ts';
import { deriveKey, signCanonical } from '../derive.ts';
import { encodeFilesGrant, signFilesBase } from '../urls.ts';
import type { FilesFolder, Tier } from '../types.ts';
import {
  isFilesGrantFolder,
  parseContentUrl,
  parseFilesGrant,
  parseFilesUrl,
  verifyContentUrl,
  verifyFilesUrl,
  verifyThemeUrl,
} from '../verify.ts';
import {
  CLASSROOM_A,
  CLASSROOM_B,
  HOST,
  MASTER,
  NOW,
  ORIGIN,
  OTHER_MASTER,
  OTHER_ORIGIN,
  OTHER_SHA,
  SHA,
  TREE_SHA,
  ctx,
} from './fixtures.ts';

const TIERS: Tier[] = ['month', 'week', 'edit', 'download'];

const GAMES: FilesFolder = { path: 'games/snake', treeSha: TREE_SHA };
const BLOCKS: FilesFolder = { path: 'slides/intro/blocks', treeSha: SHA };

const filesBase = (tier: Tier = 'month', folders: FilesFolder[] = [GAMES, BLOCKS]) =>
  signFilesBase(ORIGIN, ctx(tier), { folders });

/** base64url of any text, including grants the signer refuses to produce. */
const rawGrant = (text: string) => toBase64Url(utf8(text));

/**
 * A validly SIGNED files URL over any grant segment at all. The mint path
 * validates its folders; a leaked key would not, so the verifier must not rely
 * on the signer having done so.
 */
async function signedOverGrant(grant: string, tier: Tier = 'month'): Promise<string> {
  const exp = bucketExpiry(tier, CLASSROOM_A, NOW);
  const canonical = filesCanonicalString({
    host: HOST,
    classroomId: CLASSROOM_A,
    grant,
    tier,
    keyVersion: 0,
    exp,
  });
  const key = await deriveKey(MASTER, CLASSROOM_A, 0);
  const sig = toBase64Url(await signCanonical(key, canonical));
  return `${ORIGIN}/c/${CLASSROOM_A}/files/${grant}/${tier}.0.${exp}.${sig}/`;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * The same bytes spelled differently: an unpadded base64url string whose
 * length is not a multiple of four ends in bits that decode to nothing, and
 * flipping one of them changes the string but not the bytes.
 */
function nonCanonical(grant: string): string {
  if (grant.length % 4 === 0 || grant.length % 4 === 1)
    throw new Error('fixture has no spare bits');
  const last = ALPHABET.indexOf(grant[grant.length - 1]);
  return grant.slice(0, -1) + ALPHABET[last ^ 1];
}

describe('filesCanonicalString', () => {
  it('pins the files shape', () => {
    expect(
      filesCanonicalString({
        host: HOST,
        classroomId: CLASSROOM_A,
        grant: 'Z2FtZXM',
        tier: 'week',
        keyVersion: 2,
        exp: 1767225600,
      })
    ).toBe(`cm1|files|${HOST}|${CLASSROOM_A}|Z2FtZXM|week|2|1767225600`);
  });
});

describe('encodeFilesGrant', () => {
  it('encodes sorted path/sha lines as unpadded base64url', () => {
    const grant = encodeFilesGrant([BLOCKS, GAMES]);
    expect(grant).toBe(rawGrant(`games/snake\t${TREE_SHA}\nslides/intro/blocks\t${SHA}`));
    expect(grant).not.toMatch(/[=+/]/);
  });

  it('is order-independent, so one set of folders has one URL', () => {
    expect(encodeFilesGrant([GAMES, BLOCKS])).toBe(encodeFilesGrant([BLOCKS, GAMES]));
  });

  it('refuses sets no verifier would accept', () => {
    const bad: FilesFolder[][] = [
      [],
      [{ path: '', treeSha: TREE_SHA }],
      [{ path: '/games', treeSha: TREE_SHA }],
      [{ path: 'games/', treeSha: TREE_SHA }],
      [{ path: 'games/../slides', treeSha: TREE_SHA }],
      [{ path: 'games/./snake', treeSha: TREE_SHA }],
      [{ path: 'games//snake', treeSha: TREE_SHA }],
      [{ path: 'games\\snake', treeSha: TREE_SHA }],
      [{ path: 'games/a%2Fb', treeSha: TREE_SHA }],
      [{ path: 'games\tx', treeSha: TREE_SHA }],
      [{ path: 'games\nx', treeSha: TREE_SHA }],
      [{ path: 'games', treeSha: 'not-a-sha' }],
      [GAMES, GAMES],
      [GAMES, { path: 'games/snake/assets', treeSha: SHA }],
      [GAMES, { path: 'games', treeSha: SHA }],
      Array.from({ length: 13 }, (_, i) => ({
        path: `f${String(i).padStart(2, '0')}`,
        treeSha: SHA,
      })),
    ];
    for (const folders of bad) {
      expect(() => encodeFilesGrant(folders)).toThrow(TypeError);
    }
  });

  it('accepts siblings that share a prefix but are not nested', () => {
    const grant = encodeFilesGrant([
      { path: 'games/snake', treeSha: TREE_SHA },
      { path: 'games/snake-2', treeSha: SHA },
      { path: 'games/snake.old', treeSha: OTHER_SHA },
    ]);
    expect(parseFilesGrant(grant)?.map(folder => folder.path)).toEqual([
      'games/snake',
      'games/snake-2',
      'games/snake.old',
    ]);
  });

  it('accepts twelve folders and non-ascii names', () => {
    const folders = Array.from({ length: 12 }, (_, i) => ({
      path: `übung/${String(i).padStart(2, '0')}`,
      treeSha: SHA,
    }));
    expect(parseFilesGrant(encodeFilesGrant(folders))).toEqual(folders);
  });
});

describe('isFilesGrantFolder', () => {
  it('accepts a normalized path and refuses the repo root', () => {
    expect(isFilesGrantFolder('games/snake')).toBe(true);
    expect(isFilesGrantFolder('games/hero shot')).toBe(true);
    expect(isFilesGrantFolder('')).toBe(false);
    expect(isFilesGrantFolder('.')).toBe(false);
    expect(isFilesGrantFolder(undefined)).toBe(false);
  });
});

describe('signFilesBase', () => {
  it('builds the folder base with the policy in the path', async () => {
    const base = await filesBase('week');
    const grant = encodeFilesGrant([GAMES, BLOCKS]);
    const exp = bucketExpiry('week', CLASSROOM_A, NOW);
    const prefix = `${ORIGIN}/c/${CLASSROOM_A}/files/${grant}/week.0.${exp}.`;
    expect(base.startsWith(prefix)).toBe(true);
    expect(base.endsWith('/')).toBe(true);
    expect(base.slice(prefix.length, -1)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is byte-identical inside one bucket', async () => {
    expect(await filesBase('month')).toBe(await filesBase('month'));
  });

  it('refuses a bad grant at mint time', async () => {
    await expect(
      signFilesBase(ORIGIN, ctx('month'), { folders: [{ path: '', treeSha: TREE_SHA }] })
    ).rejects.toThrow(TypeError);
  });
});

describe('verifyFilesUrl', () => {
  it.each(TIERS)('verifies a file under the base for %s', async tier => {
    const base = await filesBase(tier);
    const result = await verifyFilesUrl(MASTER, `${base}games/snake/index.html`, NOW);
    expect(result).toEqual({
      ok: true,
      kind: 'files',
      classroomId: CLASSROOM_A,
      folders: [GAMES, BLOCKS],
      tier,
      keyVersion: 0,
      exp: bucketExpiry(tier, CLASSROOM_A, NOW),
      repoPath: 'games/snake/index.html',
      inGrace: false,
      keySlot: 'current',
    });
  });

  it('decodes the repo path once', async () => {
    const base = await filesBase();
    const result = await verifyFilesUrl(MASTER, `${base}games/snake/hero%20shot.png`, NOW);
    expect(result.ok && result.repoPath).toBe('games/snake/hero shot.png');
  });

  it('ignores the query string — it is neither signed nor refused', async () => {
    const base = await filesBase();
    const result = await verifyFilesUrl(
      MASTER,
      `${base}games/snake/index.html?deck=x&f=y&sig=zzz&p=edit`,
      NOW
    );
    expect(result.ok && result.tier).toBe('month');
    expect(result.ok && result.repoPath).toBe('games/snake/index.html');
  });

  it('comes back through verifyContentUrl as kind files', async () => {
    const base = await filesBase();
    const result = await verifyContentUrl(MASTER, `${base}games/snake/a.js`, NOW);
    expect(result.ok && result.kind).toBe('files');
  });

  it('refuses a tampered grant, signature or expiry', async () => {
    const base = await filesBase();
    const grant = encodeFilesGrant([GAMES, BLOCKS]);
    const wider = encodeFilesGrant([{ path: 'games', treeSha: TREE_SHA }, BLOCKS]);
    const swapped = base.replace(`/files/${grant}/`, `/files/${wider}/`);
    expect(await verifyFilesUrl(MASTER, `${swapped}games/x.html`, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });

    const sigTampered = base.replace(/\.([A-Za-z0-9_-])([A-Za-z0-9_-]*)\/$/, (_, first, rest) => {
      return `.${first === 'A' ? 'B' : 'A'}${rest}/`;
    });
    expect(await verifyFilesUrl(MASTER, `${sigTampered}games/snake/a.js`, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });

    const exp = bucketExpiry('month', CLASSROOM_A, NOW);
    const extended = base.replace(`.0.${exp}.`, `.0.${exp + 86_400}.`);
    expect(await verifyFilesUrl(MASTER, `${extended}games/snake/a.js`, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a URL minted for another host or another classroom', async () => {
    const base = await filesBase();
    expect(
      await verifyFilesUrl(MASTER, `${base.replace(ORIGIN, OTHER_ORIGIN)}games/snake/a.js`, NOW)
    ).toEqual({ ok: false, reason: 'bad-signature' });
    expect(
      await verifyFilesUrl(MASTER, `${base.replace(CLASSROOM_A, CLASSROOM_B)}games/snake/a.js`, NOW)
    ).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('applies the tier grace, then expires', async () => {
    const base = await filesBase('week');
    const exp = bucketExpiry('week', CLASSROOM_A, NOW);
    const inGrace = await verifyFilesUrl(MASTER, `${base}games/snake/a.js`, exp + 60);
    expect(inGrace.ok && inGrace.inGrace).toBe(true);
    const graceSeconds = TIER_POLICY.week.graceSeconds;
    expect(await verifyFilesUrl(MASTER, `${base}games/snake/a.js`, exp + graceSeconds + 1)).toEqual(
      { ok: false, reason: 'expired' }
    );
  });

  it('refuses a repo path that escapes or is spelled twice', async () => {
    const base = await filesBase();
    for (const path of [
      'games/snake/../../slides/intro/deck.json',
      'games/snake/%2e%2e/x.html',
      'games/snake/%252e%252e/x.html',
      'games/snake/a%2Fb.html',
      'games/snake/a%5Cb.html',
      'games/snake//a.html',
      'games/snake/%00.html',
    ]) {
      const result = await verifyFilesUrl(MASTER, `${base}${path}`, NOW);
      // `new URL` collapses a literal `..` before we see it, so that one parses
      // to a path outside every folder rather than failing here; the Worker
      // 404s it. Everything else is malformed outright.
      if (result.ok) expect(result.repoPath.startsWith('games/snake/')).toBe(false);
      else expect(result.reason).toBe('malformed');
    }
  });

  it('decodes and re-validates a grant only after the signature verifies', async () => {
    // Each of these is validly signed. None could have been minted.
    const bad = [
      rawGrant(`slides/intro/blocks\t${SHA}\ngames/snake\t${TREE_SHA}`), // unsorted
      rawGrant(`games/snake\t${TREE_SHA}\ngames/snake\t${SHA}`), // duplicate
      rawGrant(`games\t${TREE_SHA}\ngames/snake\t${SHA}`), // nested
      rawGrant(`\t${TREE_SHA}`), // repo root
      rawGrant(`games/../slides\t${TREE_SHA}`), // traversal
      rawGrant(`games/snake\tnot-a-sha`), // bad sha
      rawGrant(`games/snake\t${TREE_SHA}\n`), // trailing newline
      rawGrant(`games/snake\t${TREE_SHA}\textra`), // extra field
      rawGrant(`games/snake`), // no sha
      rawGrant(
        Array.from({ length: 13 }, (_, i) => `f${String(i).padStart(2, '0')}\t${SHA}`).join('\n')
      ), // too many
      nonCanonical(rawGrant(`games/snake\t${TREE_SHA}`)), // second spelling of the same bytes
    ];
    for (const grant of bad) {
      const url = await signedOverGrant(grant);
      expect(await verifyFilesUrl(MASTER, `${url}games/snake/a.js`, NOW)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('refuses a grant segment that is not base64url, or too long to have been minted', async () => {
    const base = await filesBase();
    const grant = encodeFilesGrant([GAMES, BLOCKS]);
    for (const segment of [`${grant}=`, `${grant}%3D`, 'a'.repeat(4097)]) {
      expect(
        await verifyFilesUrl(MASTER, `${base.replace(grant, segment)}games/snake/a.js`, NOW)
      ).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('will not verify a files URL as a theme URL', async () => {
    const base = await filesBase();
    expect(await verifyThemeUrl(MASTER, `${base}games/snake/a.css`, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('files key rotation', () => {
  it('accepts a previous-key URL and says so, and stops once the slot is cleared', async () => {
    const base = await filesBase();
    const url = `${base}games/snake/index.html`;
    const during = await verifyFilesUrl([OTHER_MASTER, MASTER], url, NOW);
    expect(during.ok && during.keySlot).toBe('previous');
    expect(await verifyFilesUrl([OTHER_MASTER], url, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('retires every files URL when the classroom key version moves', async () => {
    const base = await filesBase();
    const bumped = base.replace(/\/(month)\.0\./, '/$1.1.');
    expect(await verifyFilesUrl(MASTER, `${bumped}games/snake/a.js`, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });
});

describe('parseFilesUrl', () => {
  it('lifts classroom, repo path and query without key material', async () => {
    const base = await filesBase();
    expect(parseFilesUrl(`${base}games/snake/draw.html?deck=x&f=y`)).toEqual({
      host: HOST,
      classroomId: CLASSROOM_A,
      repoPath: 'games/snake/draw.html',
      query: '?deck=x&f=y',
    });
    expect(parseFilesUrl(`${base}games/snake/draw.html`)?.query).toBe('');
  });

  it('parses an expired or foreign-key URL too — it is not an authorisation', async () => {
    const base = await signFilesBase(ORIGIN, ctx('edit', { now: NOW - 30 * 86_400 }), {
      folders: [GAMES],
    });
    expect(parseFilesUrl(`${base}games/snake/a.js`)?.repoPath).toBe('games/snake/a.js');
  });

  it('returns null for other shapes, and parseContentUrl returns null for files', async () => {
    const base = await filesBase();
    expect(parseContentUrl(`${base}games/snake/a.js`)).toBeNull();
    expect(parseFilesUrl('https://example.com/c/x/files/y')).toBeNull();
    expect(parseFilesUrl('not a url')).toBeNull();
    expect(
      parseFilesUrl(`${ORIGIN}/c/${CLASSROOM_A}/blob/${SHA}.png?p=month&v=0&exp=1&sig=x`)
    ).toBe(null);
  });
});
