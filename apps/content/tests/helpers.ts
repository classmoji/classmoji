import {
  blobCanonicalString,
  deriveKey,
  hostOf,
  nowSeconds,
  signBlobUrl,
  signThemeBase,
  themeCanonicalString,
  type Tier,
  type Transform,
} from '@classmoji/content-signing';
import type { Env } from '../src/env.ts';

export const MASTER = 'test-master-secret';
export const CLASSROOM = 'c1a55c0d-0000-4000-8000-000000000001';
export const ORIGIN = 'https://content-staging.classmoji.io';
/** The host is part of every canonical string, so fixtures must mint for the origin they are fetched from. */
export const HOST = hostOf(ORIGIN);

/** Git shas are validated as 40 lowercase hex characters, so fixtures must be real ones. */
export const BLOB_SHA = '0123456789abcdef0123456789abcdef01234567';
export const MISSING_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
export const TREE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const THEME_BLOB_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

interface StoredObject {
  body: string;
  contentType?: string;
  /** Override the reported size, so a ceiling can be tested without the bytes. */
  size?: number;
}

export interface FakeBucketOptions {
  /**
   * Whether the origin behind this test declared an honest `Content-Length`.
   *
   * Real R2 takes a `ReadableStream` only when the runtime already knows how
   * many bytes are coming — which it does from the origin response's
   * `Content-Length`, and only when the body was not encoded. There is no way
   * to observe that from a stream object, so the test says it instead. Default
   * false: GitHub gzips text, the runtime decodes it, and the length is gone.
   */
  originDeclaresLength?: boolean;
}

export interface FakeBucket {
  get(key: string): Promise<unknown>;
  head(key: string): Promise<unknown>;
  put(
    key: string,
    value: unknown,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
  readonly puts: Array<{ key: string; contentType?: string; bytes: number; streamed: boolean }>;
  readonly gets: string[];
  readonly heads: string[];
}

/**
 * Consume whatever R2 was handed, and say how big it was.
 *
 * Real R2 reads the stream it is given; a fake that only records the key would
 * hide the bug that matters here. The write-back half of a `tee()` is a stream
 * nobody else reads, so if the delivery half is abandoned rather than
 * cancelled, this read is where it stalls — and a hung `ctx.settled()` or a
 * short byte count is the test failing, which is the point.
 */
async function drain(value: unknown): Promise<number> {
  if (value instanceof ReadableStream) {
    const reader = (value as ReadableStream<Uint8Array>).getReader();
    let total = 0;
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      total += chunk.byteLength;
    }
    return total;
  }
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return 0;
}

export function fakeBucket(
  initial: Record<string, StoredObject> = {},
  options: FakeBucketOptions = {}
): FakeBucket {
  const store = new Map(Object.entries(initial));
  const puts: Array<{ key: string; contentType?: string; bytes: number; streamed: boolean }> = [];
  const gets: string[] = [];
  const heads: string[] = [];

  const metadata = (key: string, object: StoredObject) => ({
    httpMetadata: { contentType: object.contentType },
    httpEtag: `"${key}"`,
    size: object.size ?? new TextEncoder().encode(object.body).byteLength,
  });

  return {
    puts,
    gets,
    heads,
    async get(key: string) {
      gets.push(key);
      const object = store.get(key);
      if (!object) return null;
      return {
        ...metadata(key, object),
        body: new Response(object.body).body,
        arrayBuffer: async () => new TextEncoder().encode(object.body).buffer,
        json: async () => JSON.parse(object.body),
        text: async () => object.body,
      };
    },
    async head(key: string) {
      heads.push(key);
      const object = store.get(key);
      return object ? metadata(key, object) : null;
    },
    async put(
      key: string,
      value: unknown,
      putOptions?: { httpMetadata?: { contentType?: string } }
    ) {
      const streamed = value instanceof ReadableStream;
      if (streamed && !options.originDeclaresLength) {
        // The real rejection, verbatim: R2 refuses a stream whose length the
        // runtime cannot see. A fake that drained it regardless is why every
        // text blob silently failed to cache in production.
        throw new Error('Provided readable stream must have a known length');
      }
      const bytes = await drain(value);
      puts.push({ key, contentType: putOptions?.httpMetadata?.contentType, bytes, streamed });
      store.set(key, { body: 'stored', contentType: putOptions?.httpMetadata?.contentType });
      return {};
    },
  };
}

export function fakeContext(): ExecutionContext & { settled(): Promise<void> } {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
    async settled() {
      await Promise.allSettled(pending);
    },
  } as unknown as ExecutionContext & { settled(): Promise<void> };
}

export function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CACHE: fakeBucket() as unknown as R2Bucket,
    IMAGES: {} as unknown as ImagesBinding,
    CONTENT_TOKEN_ENDPOINT: 'https://staging.classmoji.io/api/content/token',
    ENVIRONMENT: 'test',
    CONTENT_SIGNING_SECRET: MASTER,
    CONTENT_WORKER_SHARED_SECRET: 'shared',
    ...overrides,
  };
}

export function futureExp(seconds = 3600): number {
  return nowSeconds() + seconds;
}

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Sign a canonical string the package built, using a key the package derived.
 *
 * `signBlobUrl` / `signThemeBase` pick their own `exp` (bucketed per tier) and
 * always sign the origin's own host, so tests that pin an expiry or forge a
 * host go through this instead. Everything security-relevant — key derivation
 * and the canonical string itself — still comes from the package.
 */
async function signCanonicalString(
  master: string,
  classroomId: string,
  keyVersion: number,
  canonical: string
): Promise<string> {
  const key = await deriveKey(master, classroomId, keyVersion);
  return toBase64Url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical)));
}

export async function signedBlobUrl(options: {
  classroomId?: string;
  sha: string;
  ext: string;
  tier?: Tier;
  keyVersion?: number;
  /** Pin the expiry (grace/expiry tests). Otherwise the package buckets it. */
  exp?: number;
  transform?: Transform;
  master?: string;
  /** Origin the URL is minted for. Defaults to the origin it will be fetched from. */
  origin?: string;
  /** Host baked into the signature, when it should differ from `origin` (replay tests). */
  signedHost?: string;
}): Promise<string> {
  const origin = options.origin ?? ORIGIN;
  const classroomId = options.classroomId ?? CLASSROOM;
  const tier = options.tier ?? 'public';
  const keyVersion = options.keyVersion ?? 1;
  const master = options.master ?? MASTER;

  if (options.exp === undefined && options.signedHost === undefined) {
    return signBlobUrl(
      origin,
      { master, classroomId, keyVersion, tier },
      { sha: options.sha, ext: options.ext, transform: options.transform }
    );
  }

  const exp = options.exp ?? futureExp();
  const canonical = blobCanonicalString({
    host: options.signedHost ?? hostOf(origin),
    classroomId,
    sha: options.sha,
    ext: options.ext,
    tier,
    keyVersion,
    exp,
    transform: options.transform,
  });
  const sig = await signCanonicalString(master, classroomId, keyVersion, canonical);

  const query = [`p=${tier}`, `v=${keyVersion}`, `exp=${exp}`, `sig=${sig}`];
  if (options.transform?.w !== undefined) query.push(`w=${options.transform.w}`);
  if (options.transform?.fmt !== undefined) query.push(`fmt=${options.transform.fmt}`);
  return `${origin}/c/${classroomId}/blob/${options.sha}.${options.ext}?${query.join('&')}`;
}

export async function signedThemeUrl(options: {
  classroomId?: string;
  theme: string;
  treeSha: string;
  relPath: string;
  tier?: Tier;
  keyVersion?: number;
  exp?: number;
  master?: string;
  origin?: string;
  signedHost?: string;
}): Promise<string> {
  const origin = options.origin ?? ORIGIN;
  const classroomId = options.classroomId ?? CLASSROOM;
  const tier = options.tier ?? 'public';
  const keyVersion = options.keyVersion ?? 1;
  const master = options.master ?? MASTER;

  if (options.exp === undefined && options.signedHost === undefined) {
    const base = await signThemeBase(
      origin,
      { master, classroomId, keyVersion, tier },
      { theme: options.theme, treeSha: options.treeSha }
    );
    return `${base}${options.relPath}`;
  }

  const exp = options.exp ?? futureExp();
  const canonical = themeCanonicalString({
    host: options.signedHost ?? hostOf(origin),
    classroomId,
    theme: options.theme,
    treeSha: options.treeSha,
    tier,
    keyVersion,
    exp,
  });
  const sig = await signCanonicalString(master, classroomId, keyVersion, canonical);
  return `${origin}/c/${classroomId}/theme/${options.theme}/${options.treeSha}/${tier}.${keyVersion}.${exp}.${sig}/${options.relPath}`;
}
