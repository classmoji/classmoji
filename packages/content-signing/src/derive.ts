import { assertClassroomId, assertKeyVersion, utf8 } from './canonical.ts';

const HMAC_PARAMS = { name: 'HMAC', hash: 'SHA-256' } as const;
const KEY_CACHE_LIMIT = 256;

/** `master NUL classroomId|keyVersion` -> derived key. Insertion-ordered LRU. */
const keyCache = new Map<string, Promise<CryptoKey>>();

function subtle(): SubtleCrypto {
  const cryptoRef = globalThis.crypto;
  if (!cryptoRef?.subtle) {
    throw new Error('content-signing: Web Crypto (globalThis.crypto.subtle) is unavailable');
  }
  return cryptoRef.subtle;
}

async function importRawKey(bytes: Uint8Array<ArrayBuffer> | ArrayBuffer): Promise<CryptoKey> {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return subtle().importKey('raw', raw, HMAC_PARAMS, false, ['sign', 'verify']);
}

async function deriveKeyUncached(
  master: string,
  classroomId: string,
  keyVersion: number
): Promise<CryptoKey> {
  const masterKey = await importRawKey(utf8(master));
  const material = await subtle().sign('HMAC', masterKey, utf8(`${classroomId}|${keyVersion}`));
  return importRawKey(material);
}

/**
 * Per-classroom key: `HMAC-SHA256(master, classroomId + '|' + keyVersion)`.
 *
 * The master is only ever used to derive; callers hold derived keys. Results
 * are memoized (bounded, LRU) because the Worker re-derives on every request.
 */
export function deriveKey(
  master: string,
  classroomId: string,
  keyVersion: number
): Promise<CryptoKey> {
  if (typeof master !== 'string' || master.length === 0) {
    throw new TypeError('content-signing: master secret must be a non-empty string');
  }
  assertClassroomId(classroomId);
  assertKeyVersion(keyVersion);

  const cacheKey = `${master}\u0000${classroomId}|${keyVersion}`;
  const cached = keyCache.get(cacheKey);
  if (cached) {
    keyCache.delete(cacheKey);
    keyCache.set(cacheKey, cached);
    return cached;
  }

  const pending = deriveKeyUncached(master, classroomId, keyVersion).catch(error => {
    keyCache.delete(cacheKey);
    throw error;
  });

  if (keyCache.size >= KEY_CACHE_LIMIT) {
    const oldest = keyCache.keys().next();
    if (!oldest.done) keyCache.delete(oldest.value);
  }
  keyCache.set(cacheKey, pending);
  return pending;
}

/** Test/ops hook: drop every memoized key. */
export function clearKeyCache(): void {
  keyCache.clear();
}

export async function signCanonical(key: CryptoKey, canonical: string): Promise<ArrayBuffer> {
  return subtle().sign('HMAC', key, utf8(canonical));
}

/** Constant-time by construction: the comparison happens inside Web Crypto. */
export async function verifyCanonical(
  key: CryptoKey,
  signature: Uint8Array<ArrayBuffer>,
  canonical: string
): Promise<boolean> {
  return subtle().verify('HMAC', key, signature, utf8(canonical));
}
