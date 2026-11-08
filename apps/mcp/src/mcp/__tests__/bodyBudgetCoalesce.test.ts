// countedBody passes every body through byte for byte, however it is chunked.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BodyBytesBudget, COALESCED_CHUNK_BYTES, countedBody } from '../bodyBudget.ts';

const KiB = 1024;
const MiB = 1024 * KiB;

function sha(buffers: Buffer[]) {
  const h = createHash('sha256');
  for (const b of buffers) h.update(b);
  return h.digest('hex');
}

/** Feed `chunks` through countedBody; return what came out. */
async function through(chunks: Buffer[]) {
  // Room for anything: the limits are not under test here.
  const budget = new BodyBytesBudget(1 << 30, 1 << 30, 1 << 30, 1);
  const reservation = budget.open('u');
  const source = Readable.from(chunks, { objectMode: false });
  const out: Buffer[] = [];
  const body = countedBody(source, reservation);
  await new Promise<void>((resolve, reject) => {
    body.on('data', (b: Buffer) => out.push(b));
    body.on('end', resolve);
    body.on('error', reject);
  });
  const counted = budget.inFlight('u');
  reservation.release();
  return { out, counted, after: budget.inFlight() };
}

/** Deterministic pseudo-random sizes. */
function sizes(n: number, max: number, seed = 7) {
  let x = seed;
  return Array.from({ length: n }, () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return 1 + (x % max);
  });
}

function bytes(n: number, seed = 1) {
  const b = Buffer.allocUnsafe(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

function split(total: Buffer, lengths: number[]) {
  const chunks: Buffer[] = [];
  let at = 0;
  for (const len of lengths) {
    if (at >= total.length) break;
    chunks.push(Buffer.from(total.subarray(at, Math.min(total.length, at + len))));
    at += len;
  }
  if (at < total.length) chunks.push(Buffer.from(total.subarray(at)));
  return chunks;
}

const cases: Array<[string, () => Buffer[]]> = [
  ['200,000 one-byte chunks', () => split(bytes(200_000), Array(200_000).fill(1))],
  ['random sizes 1..70,000', () => split(bytes(3 * MiB), sizes(400, 70_000))],
  [
    'straddling 64 KiB',
    () => split(bytes(10 * 64 * KiB), [65535, 2, 65536, 65537, 1, 65535, 1, 1, 65534, 3]),
  ],
  ['exactly 64 KiB, one chunk', () => [bytes(64 * KiB)]],
  ['64 KiB - 1, one chunk', () => [bytes(64 * KiB - 1)]],
  ['64 KiB + 1, one chunk', () => [bytes(64 * KiB + 1)]],
  ['64 KiB in 1 + (64 KiB - 1)', () => split(bytes(64 * KiB), [1, 64 * KiB - 1])],
  ['64 KiB in (64 KiB - 1) + 1, then 1', () => split(bytes(64 * KiB + 1), [64 * KiB - 1, 1, 1])],
  ['exactly 8 MiB in 1,000-byte chunks', () => split(bytes(8 * MiB), Array(8 * 1024).fill(1000))],
  [
    '8 MiB + 1 in 1,000-byte chunks',
    () => split(bytes(8 * MiB + 1), Array(8 * 1024 + 1).fill(1000)),
  ],
  ['8 MiB in 7-byte chunks', () => split(bytes(8 * MiB), Array(Math.ceil((8 * MiB) / 7)).fill(7))],
  ['trailing partial buffer', () => split(bytes(5 * 64 * KiB + 123), Array(400).fill(817))],
  ['empty body', () => []],
];

describe('countedBody passes the body through unchanged', () => {
  for (const [name, make] of cases) {
    it(name, async () => {
      const chunks = make();
      const inLength = chunks.reduce((n, c) => n + c.length, 0);
      const { out, counted, after } = await through(chunks);
      expect(sha(out)).toBe(sha(chunks));
      expect(out.reduce((n, c) => n + c.length, 0)).toBe(inLength);
      expect(counted).toBe(inLength);
      expect(after).toBe(0);
      const passedThrough = new Set(chunks.filter(c => c.length >= COALESCED_CHUNK_BYTES));
      const sourceStores = new Set(chunks.map(c => c.buffer));
      const stores = new Set<ArrayBufferLike>();
      let coalesced = 0;
      for (const b of out) {
        if (passedThrough.has(b)) continue;
        coalesced += 1;
        // A coalesced buffer: at most 64 KiB, its own allocation (not a pool slice, not a source chunk).
        expect(b.length).toBeLessThanOrEqual(COALESCED_CHUNK_BYTES);
        expect(b.byteOffset).toBe(0);
        expect(b.buffer.byteLength).toBeLessThanOrEqual(COALESCED_CHUNK_BYTES);
        expect(sourceStores.has(b.buffer)).toBe(false);
        stores.add(b.buffer);
      }
      expect(stores.size).toBe(coalesced);
    });
  }

  it('multi-byte UTF-8 split mid-codepoint at every offset decodes to the same text', async () => {
    const text = JSON.stringify({ s: 'é€😀ü中文'.repeat(9000) });
    const raw = Buffer.from(text, 'utf8');
    for (const step of [1, 2, 3, 5, 7, 4093, 65535, 65537]) {
      const { out } = await through(split(raw, Array(Math.ceil(raw.length / step)).fill(step)));
      expect(Buffer.concat(out).toString('utf8')).toBe(text);
    }
  });
});
