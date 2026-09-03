import type { Env } from '../src/env.ts';
import {
  blobCanonicalString,
  deriveKey,
  nowSeconds,
  signCanonical,
  themeCanonicalString,
  toBase64Url,
  type Tier,
  type Transform,
} from '../src/signing-stub.ts';

export const MASTER = 'test-master-secret';
export const CLASSROOM = 'c1a55c0d-0000-4000-8000-000000000001';
export const ORIGIN = 'https://content-staging.classmoji.io';
/** The host is part of every canonical string, so fixtures must mint for the origin they are fetched from. */
export const HOST = new URL(ORIGIN).host;

/** Git shas are validated as 40 lowercase hex characters, so fixtures must be real ones. */
export const BLOB_SHA = '0123456789abcdef0123456789abcdef01234567';
export const MISSING_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
export const TREE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const THEME_BLOB_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

interface StoredObject {
  body: string;
  contentType?: string;
}

export interface FakeBucket {
  get(key: string): Promise<unknown>;
  put(
    key: string,
    value: unknown,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
  readonly puts: Array<{ key: string; contentType?: string }>;
  readonly gets: string[];
}

export function fakeBucket(initial: Record<string, StoredObject> = {}): FakeBucket {
  const store = new Map(Object.entries(initial));
  const puts: Array<{ key: string; contentType?: string }> = [];
  const gets: string[] = [];

  return {
    puts,
    gets,
    async get(key: string) {
      gets.push(key);
      const object = store.get(key);
      if (!object) return null;
      return {
        body: new Response(object.body).body,
        httpMetadata: { contentType: object.contentType },
        httpEtag: `"${key}"`,
        arrayBuffer: async () => new TextEncoder().encode(object.body).buffer,
        json: async () => JSON.parse(object.body),
        text: async () => object.body,
      };
    },
    async put(key: string, _value: unknown, options?: { httpMetadata?: { contentType?: string } }) {
      puts.push({ key, contentType: options?.httpMetadata?.contentType });
      store.set(key, { body: 'stored', contentType: options?.httpMetadata?.contentType });
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

async function sign(
  master: string,
  classroomId: string,
  keyVersion: number,
  canonical: string
): Promise<string> {
  const key = await deriveKey(master, classroomId, keyVersion);
  return toBase64Url(await signCanonical(key, canonical));
}

export async function signedBlobUrl(options: {
  classroomId?: string;
  sha: string;
  ext: string;
  tier?: Tier;
  keyVersion?: number;
  exp?: number;
  transform?: Transform;
  master?: string;
  /** Origin the URL is minted for. Defaults to the origin it will be fetched from. */
  origin?: string;
  /** Host baked into the signature, when it should differ from `origin` (replay tests). */
  signedHost?: string;
}): Promise<string> {
  const origin = options.origin ?? ORIGIN;
  const host = options.signedHost ?? new URL(origin).host;
  const classroomId = options.classroomId ?? CLASSROOM;
  const tier = options.tier ?? 'public';
  const keyVersion = options.keyVersion ?? 1;
  const exp = options.exp ?? futureExp();
  const canonical = blobCanonicalString({
    host,
    classroomId,
    sha: options.sha,
    ext: options.ext,
    tier,
    keyVersion,
    exp,
    transform: options.transform,
  });
  const sig = await sign(options.master ?? MASTER, classroomId, keyVersion, canonical);

  const params = new URLSearchParams({ p: tier, v: String(keyVersion), exp: String(exp), sig });
  if (options.transform?.w !== undefined) params.set('w', String(options.transform.w));
  if (options.transform?.fmt !== undefined) params.set('fmt', options.transform.fmt);
  return `${origin}/c/${classroomId}/blob/${options.sha}.${options.ext}?${params.toString()}`;
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
  const host = options.signedHost ?? new URL(origin).host;
  const classroomId = options.classroomId ?? CLASSROOM;
  const tier = options.tier ?? 'public';
  const keyVersion = options.keyVersion ?? 1;
  const exp = options.exp ?? futureExp();
  const canonical = themeCanonicalString({
    host,
    classroomId,
    theme: options.theme,
    treeSha: options.treeSha,
    tier,
    keyVersion,
    exp,
  });
  const sig = await sign(options.master ?? MASTER, classroomId, keyVersion, canonical);
  return `${origin}/c/${classroomId}/theme/${options.theme}/${options.treeSha}/${tier}.${keyVersion}.${exp}.${sig}/${options.relPath}`;
}
