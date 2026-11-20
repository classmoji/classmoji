/**
 * The SSRF guard for URL imports: which URLs and addresses are refused, that
 * the connection goes to the validated address and nowhere else, and that the
 * HTTP-level rules (no redirects, 2xx only, byte cap) hold.
 *
 * What each group protects against:
 *
 *  - URL VALIDATION. http:// would send the request in clear and skip
 *    certificate checks; a non-443 port is how a URL reaches an internal
 *    service on a public host; userinfo would be sent to whoever answers.
 *  - ADDRESS CLASSIFICATION. The table is the policy. IPv4-mapped and NAT64
 *    IPv6 forms are the classic way around an IPv4-only blocklist, and
 *    169.254.169.254 / fd00:ec2::254 are the cloud metadata endpoints.
 *  - ALL RECORDS. A name that answers both a public and a private address must
 *    be refused: checking only the first record lets the socket layer pick the
 *    private one.
 *  - THE PIN. After validation, the Agent must connect to the validated
 *    address without resolving again — otherwise a DNS answer that changes
 *    between check and connect (rebinding) walks straight past the check. The
 *    real-socket test uses a `.test` hostname, which cannot resolve, so a
 *    response at all proves the pinned lookup was used.
 *  - THE PROTOCOL. The pinned Agent offers HTTP/1.1 only in ALPN (undici 8
 *    offers h2 by default); read from the ClientHello it sends.
 *  - THE BYTE CAP. It must hold against a lying or absent Content-Length:
 *    the header is a claim, the stream is the fact.
 */

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo, Server as NetServer, Socket } from 'node:net';

import { Agent, MockAgent, request } from 'undici';
import type { Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOST_NOT_PUBLIC_MESSAGE,
  UrlImportError,
  createPinnedAgent,
  createPinnedLookup,
  fetchImportUrl,
  filenameFromContentDisposition,
  isBlockedAddress,
  parseImportUrl,
  resolvePublicAddress,
} from '../safeUrlFetch.ts';
import type { ResolveAll } from '../safeUrlFetch.ts';

/** Expect `fn` to reject with a UrlImportError carrying `code`. */
async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(UrlImportError);
  expect((err as UrlImportError).code).toBe(code);
  return err as UrlImportError;
}

function expectSyncCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(UrlImportError);
    expect((e as UrlImportError).code).toBe(code);
    return;
  }
  throw new Error(`expected UrlImportError(${code})`);
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<number> {
  let n = 0;
  for await (const c of body) n += c.byteLength;
  return n;
}

// ─── URL validation ──────────────────────────────────────────────────────────

describe('parseImportUrl', () => {
  it('accepts a plain https URL, and an explicit :443 (normalised away)', () => {
    expect(parseImportUrl('https://example.com/a/b.pdf').hostname).toBe('example.com');
    expect(parseImportUrl('https://example.com:443/x').port).toBe('');
  });

  it.each([
    ['http://example.com/file.pdf', 'http scheme'],
    ['ftp://example.com/file', 'ftp scheme'],
    ['file:///etc/passwd', 'file scheme'],
    ['https://example.com:8443/file', 'non-443 port'],
    ['https://example.com:80/file', 'port 80 on https'],
    ['https://user:pass@example.com/file', 'user and password'],
    ['https://user@example.com/file', 'username only'],
    // (`https:///x` is NOT hostless: WHATWG treats it as `https://x/`.)
    ['https://', 'no host'],
    ['https://?q=1', 'no host, query only'],
    ['not a url', 'unparseable'],
    ['', 'empty'],
    [`https://example.com/${'a'.repeat(5000)}`, 'too long'],
  ])('refuses %s (%s)', raw => {
    expectSyncCode(() => parseImportUrl(raw), 'BAD_URL');
  });
});

// ─── Address classification ────────────────────────────────────────────────

describe('isBlockedAddress', () => {
  it.each([
    // IPv4
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1', // CGNAT low
    '100.127.255.255', // CGNAT high
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254', // metadata
    '169.254.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    // IPv6
    '::',
    '::1',
    'fc00::1',
    'fd00:ec2::254', // metadata (ULA)
    'fe80::1',
    'febf::1',
    'fe80::1%eth0', // zone id
    'ff02::1',
    '100::1',
    '2001:db8::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '3fff::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:7f00:1', // same, hex form
    '::ffff:169.254.169.254', // mapped metadata
    '::ffff:10.0.0.1',
    '64:ff9b::a9fe:a9fe', // NAT64 → 169.254.169.254
    '64:ff9b::127.0.0.1',
    '2002:7f00:1::1', // 6to4 of 127.0.0.1
    '2002:c0a8:101::1', // 6to4 of 192.168.1.1
    '::127.0.0.1', // deprecated IPv4-compatible
    // Not an IP at all: fail closed.
    'localhost',
    '',
    '1.2.3',
    '[::1]',
  ])('blocks %s', ip => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '100.63.255.255', // just below CGNAT
    '100.128.0.0', // just above CGNAT
    '172.15.255.255', // just below 172.16/12
    '172.32.0.0', // just above
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
    '::ffff:8.8.8.8', // mapped public
    '64:ff9b::808:808', // NAT64 → 8.8.8.8
    '2002:808:808::1', // 6to4 of 8.8.8.8
    '3fff:1000::1', // just past 3fff::/20
  ])('allows %s', ip => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

// ─── DNS ──────────────────────────────────────────────────────────────────

describe('resolvePublicAddress', () => {
  const answering =
    (records: { address: string; family: 4 | 6 }[]): ResolveAll =>
    async () =>
      records;

  it('returns a public record, preferring IPv4', async () => {
    const r = await resolvePublicAddress(
      'files.example.com',
      answering([
        { address: '2606:4700:4700::1111', family: 6 },
        { address: '1.1.1.1', family: 4 },
      ])
    );
    expect(r).toEqual({ address: '1.1.1.1', family: 4 });
  });

  it('refuses when ANY record is private, even if another is public', async () => {
    await expectCode(
      resolvePublicAddress(
        'mixed.example.com',
        answering([
          { address: '1.1.1.1', family: 4 },
          { address: '10.0.0.5', family: 4 },
        ])
      ),
      'BLOCKED_ADDRESS'
    );
    await expectCode(
      resolvePublicAddress(
        'mixed6.example.com',
        answering([
          { address: '1.1.1.1', family: 4 },
          { address: '::1', family: 6 },
        ])
      ),
      'BLOCKED_ADDRESS'
    );
  });

  it('checks a literal IP host without DNS', async () => {
    const resolveAll = vi.fn<ResolveAll>();
    await expectCode(resolvePublicAddress('127.0.0.1', resolveAll), 'BLOCKED_ADDRESS');
    await expectCode(
      resolvePublicAddress('[::ffff:169.254.169.254]', resolveAll),
      'BLOCKED_ADDRESS'
    );
    await expectCode(resolvePublicAddress('[fd00:ec2::254]', resolveAll), 'BLOCKED_ADDRESS');
    expect(await resolvePublicAddress('[2606:4700:4700::1111]', resolveAll)).toEqual({
      address: '2606:4700:4700::1111',
      family: 6,
    });
    expect(resolveAll).not.toHaveBeenCalled();
  });

  it('treats "localhost" like any other name — it resolves to loopback and is refused', async () => {
    // The real system resolver, not a stub: /etc/hosts maps localhost to loopback.
    await expectCode(resolvePublicAddress('localhost'), 'BLOCKED_ADDRESS');
  });

  // Two sentences would let a caller probe which internal names exist.
  it('says the same thing for a name that does not resolve and one that resolves privately', async () => {
    const unresolved = await expectCode(
      resolvePublicAddress('nx.example.com', async () => {
        throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
      }),
      'DNS_FAILED'
    );
    const empty = await expectCode(
      resolvePublicAddress('empty.example.com', answering([])),
      'DNS_FAILED'
    );
    const privateName = await expectCode(
      resolvePublicAddress(
        'db.internal.example.com',
        answering([{ address: '10.0.0.5', family: 4 }])
      ),
      'BLOCKED_ADDRESS'
    );
    const privateLiteral = await expectCode(resolvePublicAddress('127.0.0.1'), 'BLOCKED_ADDRESS');
    for (const err of [unresolved, empty, privateName, privateLiteral]) {
      expect(err.message).toBe(HOST_NOT_PUBLIC_MESSAGE);
    }
    expect(HOST_NOT_PUBLIC_MESSAGE).not.toMatch(/example|10\.0|127/);
  });

  it('maps resolver failure and empty answers to DNS_FAILED', async () => {
    await expectCode(
      resolvePublicAddress('nx.example.com', async () => {
        throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
      }),
      'DNS_FAILED'
    );
    await expectCode(resolvePublicAddress('empty.example.com', answering([])), 'DNS_FAILED');
  });

  it('refuses an obfuscated loopback URL end to end (URL parser normalises it)', async () => {
    const host = parseImportUrl('https://0x7f.1/').hostname;
    expect(host).toBe('127.0.0.1');
    await expectCode(resolvePublicAddress(host), 'BLOCKED_ADDRESS');
    const dec = parseImportUrl('https://2130706433/').hostname;
    await expectCode(resolvePublicAddress(dec), 'BLOCKED_ADDRESS');
  });
});

// ─── The pin ──────────────────────────────────────────────────────────────

describe('createPinnedLookup', () => {
  const pinned = { address: '93.184.216.34', family: 4 as const };

  it('answers only the pinned address in the all:true (array) form', async () => {
    const lookup = createPinnedLookup('files.example.com', pinned);
    const result = await new Promise<unknown[]>(resolve =>
      lookup('files.example.com', { all: true }, (err, address, family) =>
        resolve([err, address, family])
      )
    );
    expect(result[0]).toBeNull();
    expect(result[1]).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('answers only the pinned address in the all:false (address, family) form', async () => {
    const lookup = createPinnedLookup('files.example.com', pinned);
    const result = await new Promise<unknown[]>(resolve =>
      lookup('files.example.com', { family: 0 }, (err, address, family) =>
        resolve([err, address, family])
      )
    );
    expect(result).toEqual([null, '93.184.216.34', 4]);
  });

  it('ignores a family hint and still returns only the pinned address', async () => {
    const lookup = createPinnedLookup('files.example.com', pinned);
    const result = await new Promise<unknown[]>(resolve =>
      lookup('files.example.com', { family: 6, all: true }, (err, address) =>
        resolve([err, address])
      )
    );
    expect(result[1]).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('refuses to answer for any other hostname', async () => {
    const lookup = createPinnedLookup('files.example.com', pinned);
    const err = await new Promise<NodeJS.ErrnoException | null>(resolve =>
      lookup('evil.example.com', { all: true }, e => resolve(e))
    );
    expect(err?.code).toBe('ENOTFOUND');
  });
});

describe('createPinnedAgent (real socket)', () => {
  let server: Server;
  let port: number;
  const seenHosts: (string | undefined)[] = [];

  beforeEach(async () => {
    seenHosts.length = 0;
    server = createServer((req, res) => {
      seenHosts.push(req.headers.host);
      res.end('pinned-ok');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.close();
    await once(server, 'close');
  });

  it('connects to the pinned address for a name DNS cannot resolve, keeping the Host header', async () => {
    // `.test` is reserved (RFC 2606) and never resolves, so any response at all
    // proves the connection used the pinned lookup rather than DNS.
    const agent = createPinnedAgent(
      'pinned.test',
      { address: '127.0.0.1', family: 4 },
      { connectTimeoutMs: 2000, headersTimeoutMs: 2000, bodyIdleTimeoutMs: 2000 }
    );
    try {
      const res = await request(`http://pinned.test:${port}/`, { dispatcher: agent });
      expect(res.statusCode).toBe(200);
      expect(await res.body.text()).toBe('pinned-ok');
      expect(seenHosts).toEqual([`pinned.test:${port}`]);
    } finally {
      await agent.destroy();
    }
  });

  it('will not connect to a different hostname through the same Agent', async () => {
    const agent = createPinnedAgent(
      'pinned.test',
      { address: '127.0.0.1', family: 4 },
      { connectTimeoutMs: 2000, headersTimeoutMs: 2000, bodyIdleTimeoutMs: 2000 }
    );
    try {
      await expect(request(`http://other.test:${port}/`, { dispatcher: agent })).rejects.toThrow();
      expect(seenHosts).toEqual([]);
    } finally {
      await agent.destroy();
    }
  });
});

/**
 * The protocols a TLS ClientHello offers in its ALPN extension, or null when
 * the bytes are not a complete ClientHello yet. Enough of RFC 8446 §4.1.2 to
 * walk to the extensions; nothing here needs a certificate.
 */
function offeredAlpn(hello: Buffer): string[] | null {
  if (hello.length < 5 || hello[0] !== 0x16) return null;
  const recordEnd = 5 + hello.readUInt16BE(3);
  if (hello.length < recordEnd || hello[5] !== 0x01) return null;
  let p = 5 + 4 + 2 + 32; // record header, handshake header, version, random
  p += 1 + hello[p]; // session id
  p += 2 + hello.readUInt16BE(p); // cipher suites
  p += 1 + hello[p]; // compression methods
  const extensionsEnd = p + 2 + hello.readUInt16BE(p);
  p += 2;
  while (p + 4 <= extensionsEnd) {
    const type = hello.readUInt16BE(p);
    const len = hello.readUInt16BE(p + 2);
    if (type === 0x0010) {
      const out: string[] = [];
      let q = p + 4 + 2;
      while (q < p + 4 + len) {
        const n = hello[q];
        out.push(hello.subarray(q + 1, q + 1 + n).toString('latin1'));
        q += 1 + n;
      }
      return out;
    }
    p += 4 + len;
  }
  return [];
}

describe('createPinnedAgent (TLS ClientHello)', () => {
  let server: NetServer;
  let port: number;
  let offered: (string[] | null)[];

  beforeEach(async () => {
    offered = [];
    // Reads the client's first TLS record and hangs up: what was OFFERED is
    // the whole question, so no certificate or handshake is needed.
    server = createNetServer(socket => {
      let hello = Buffer.alloc(0);
      socket.on('data', chunk => {
        hello = Buffer.concat([hello, chunk]);
        const alpn = offeredAlpn(hello);
        if (alpn !== null) {
          offered.push(alpn);
          socket.destroy();
        }
      });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.close();
    await once(server, 'close');
  });

  async function offeredBy(dispatcher: Agent): Promise<string[] | null> {
    try {
      await expect(
        request(`https://pinned.test:${port}/`, { dispatcher, method: 'GET' })
      ).rejects.toThrow();
    } finally {
      await dispatcher.destroy();
    }
    expect(offered).toHaveLength(1);
    return offered[0];
  }

  it('offers HTTP/1.1 only, never h2', async () => {
    const agent = createPinnedAgent(
      'pinned.test',
      { address: '127.0.0.1', family: 4 },
      { connectTimeoutMs: 2000, headersTimeoutMs: 2000, bodyIdleTimeoutMs: 2000 }
    );
    expect(await offeredBy(agent)).toEqual(['http/1.1']);
  });

  it('sees h2 when an Agent does offer it (the check above can fail)', async () => {
    const agent = new Agent({
      connect: { lookup: createPinnedLookup('pinned.test', { address: '127.0.0.1', family: 4 }) },
      allowH2: true,
    });
    expect(await offeredBy(agent)).toContain('h2');
  });
});

// ─── fetchImportUrl (HTTP behaviour, via MockAgent) ────────────────────────

describe('fetchImportUrl', () => {
  const ORIGIN = 'https://files.example.com';
  const publicDns: ResolveAll = async () => [{ address: '93.184.216.34', family: 4 }];
  let mock: MockAgent;

  beforeEach(() => {
    mock = new MockAgent();
    mock.disableNetConnect();
  });

  afterEach(async () => {
    await mock.close();
  });

  const opts = (extra: Partial<Parameters<typeof fetchImportUrl>[1]> = {}) => ({
    maxBytes: 1024,
    resolveAll: publicDns,
    __testOnlyDispatcher: mock,
    ...extra,
  });

  it('streams a 200 body and reports its metadata', async () => {
    const payload = Buffer.alloc(500, 7);
    mock
      .get(ORIGIN)
      .intercept({ path: '/docs/Lecture%201.pdf', method: 'GET' })
      .reply(200, payload, {
        headers: { 'content-type': 'Application/PDF; charset=binary', 'content-length': '500' },
      });

    const res = await fetchImportUrl(`${ORIGIN}/docs/Lecture%201.pdf`, opts());
    expect(res.contentLength).toBe(500);
    expect(res.contentType).toBe('application/pdf');
    expect(res.filename).toBe('Lecture 1.pdf');
    expect(await drain(res.body)).toBe(500);
  });

  it('sends no credentials: only a plain user-agent, accept and identity encoding', async () => {
    let sent: Record<string, string> = {};
    mock
      .get(ORIGIN)
      .intercept({ path: '/f', method: 'GET' })
      .reply(opts => {
        sent = opts.headers as Record<string, string>;
        return { statusCode: 200, data: 'x' };
      });
    const res = await fetchImportUrl(`${ORIGIN}/f`, opts());
    await drain(res.body);
    const names = Object.keys(sent)
      .map(k => k.toLowerCase())
      .sort();
    expect(names).toEqual(['accept', 'accept-encoding', 'user-agent']);
    expect(sent['user-agent']).toBe('Classmoji-Import/1.0');
  });

  it.each([301, 302, 303, 307, 308])('refuses a %i redirect and names the target', async status => {
    mock
      .get(ORIGIN)
      .intercept({ path: '/moved', method: 'GET' })
      .reply(status, '', { headers: { location: '/final.pdf' } });
    const err = await expectCode(fetchImportUrl(`${ORIGIN}/moved`, opts()), 'REDIRECT_REFUSED');
    expect(err.status).toBe(status);
    expect(err.message).toContain('https://files.example.com/final.pdf');
    expect(err.message).toMatch(/pass the final URL/);
  });

  it.each([404, 403, 500])('refuses HTTP %i with the status', async status => {
    mock.get(ORIGIN).intercept({ path: '/x', method: 'GET' }).reply(status, 'nope');
    const err = await expectCode(fetchImportUrl(`${ORIGIN}/x`, opts()), 'HTTP_ERROR');
    expect(err.status).toBe(status);
  });

  it.each(['gzip', 'br', 'deflate', 'gzip, identity'])(
    'refuses a body sent with content-encoding: %s',
    async encoding => {
      mock
        .get(ORIGIN)
        .intercept({ path: '/z', method: 'GET' })
        .reply(200, 'compressed', { headers: { 'content-encoding': encoding } });
      const err = await expectCode(fetchImportUrl(`${ORIGIN}/z`, opts()), 'UNSUPPORTED_ENCODING');
      expect(err.message).toMatch(/only uncompressed downloads/);
    }
  );

  it('accepts an explicit identity encoding', async () => {
    mock
      .get(ORIGIN)
      .intercept({ path: '/id', method: 'GET' })
      .reply(200, 'plain', { headers: { 'content-encoding': 'Identity' } });
    const res = await fetchImportUrl(`${ORIGIN}/id`, opts());
    expect(await drain(res.body)).toBe(5);
  });

  it('refuses early when Content-Length exceeds the cap', async () => {
    mock
      .get(ORIGIN)
      .intercept({ path: '/big', method: 'GET' })
      .reply(200, 'small', { headers: { 'content-length': '999999' } });
    await expectCode(fetchImportUrl(`${ORIGIN}/big`, opts()), 'TOO_LARGE');
  });

  it('enforces the cap on streamed bytes when Content-Length lies', async () => {
    mock
      .get(ORIGIN)
      .intercept({ path: '/liar', method: 'GET' })
      .reply(200, Buffer.alloc(5000, 1), { headers: { 'content-length': '10' } });
    const res = await fetchImportUrl(`${ORIGIN}/liar`, opts());
    expect(res.contentLength).toBe(10);
    let received = 0;
    const err = await (async () => {
      try {
        for await (const c of res.body) received += c.byteLength;
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(UrlImportError);
    expect((err as UrlImportError).code).toBe('TOO_LARGE');
    expect(received).toBeLessThanOrEqual(1024);
  });

  it('enforces the cap on streamed bytes when Content-Length is absent', async () => {
    mock.get(ORIGIN).intercept({ path: '/nolen', method: 'GET' }).reply(200, Buffer.alloc(5000, 1));
    const res = await fetchImportUrl(`${ORIGIN}/nolen`, opts());
    expect(res.contentLength).toBeNull();
    await expectCode(drain(res.body), 'TOO_LARGE');
  });

  it('accepts a body exactly at the cap', async () => {
    mock.get(ORIGIN).intercept({ path: '/exact', method: 'GET' }).reply(200, Buffer.alloc(1024, 1));
    const res = await fetchImportUrl(`${ORIGIN}/exact`, opts());
    expect(await drain(res.body)).toBe(1024);
  });

  it('prefers the Content-Disposition filename, and sanitises it', async () => {
    mock
      .get(ORIGIN)
      .intercept({ path: '/download?id=1', method: 'GET' })
      .reply(200, 'x', {
        headers: {
          'content-disposition': `attachment; filename="../../etc/fallback.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`,
        },
      });
    const res = await fetchImportUrl(`${ORIGIN}/download?id=1`, opts());
    expect(res.filename).toBe('résumé.pdf');
    await res.cancel();
  });

  it('refuses a blocked resolution before any request is made', async () => {
    const privateDns: ResolveAll = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ];
    // No intercept registered: a request would fail loudly with a different error.
    await expectCode(
      fetchImportUrl(`${ORIGIN}/x`, opts({ resolveAll: privateDns })),
      'BLOCKED_ADDRESS'
    );
  });

  it('refuses a literal private IP URL', async () => {
    await expectCode(fetchImportUrl('https://10.1.2.3/secret', opts()), 'BLOCKED_ADDRESS');
    await expectCode(fetchImportUrl('https://[::1]/secret', opts()), 'BLOCKED_ADDRESS');
    await expectCode(
      fetchImportUrl('https://169.254.169.254/latest/meta-data/', opts()),
      'BLOCKED_ADDRESS'
    );
  });

  it('refuses bad URLs before resolving', async () => {
    const resolveAll = vi.fn<ResolveAll>(publicDns);
    await expectCode(fetchImportUrl('http://files.example.com/x', opts({ resolveAll })), 'BAD_URL');
    await expectCode(
      fetchImportUrl('https://files.example.com:8443/x', opts({ resolveAll })),
      'BAD_URL'
    );
    await expectCode(
      fetchImportUrl('https://u:p@files.example.com/x', opts({ resolveAll })),
      'BAD_URL'
    );
    expect(resolveAll).not.toHaveBeenCalled();
  });

  it('resolves exactly once per import (no second lookup to rebind)', async () => {
    const resolveAll = vi.fn<ResolveAll>(publicDns);
    mock.get(ORIGIN).intercept({ path: '/once', method: 'GET' }).reply(200, 'ok');
    const res = await fetchImportUrl(`${ORIGIN}/once`, opts({ resolveAll }));
    await drain(res.body);
    expect(resolveAll).toHaveBeenCalledTimes(1);
  });

  it('times out on the overall deadline', async () => {
    mock.get(ORIGIN).intercept({ path: '/slow', method: 'GET' }).reply(200, 'late').delay(2000);
    await expectCode(fetchImportUrl(`${ORIGIN}/slow`, opts({ totalTimeoutMs: 50 })), 'TIMEOUT');
  });

  it('times out when DNS hangs past the deadline', async () => {
    const hanging: ResolveAll = () => new Promise(() => {});
    await expectCode(
      fetchImportUrl(`${ORIGIN}/x`, opts({ resolveAll: hanging, totalTimeoutMs: 50 })),
      'TIMEOUT'
    );
  });

  it('rejects a non-positive or non-integer maxBytes', async () => {
    await expect(fetchImportUrl(`${ORIGIN}/x`, opts({ maxBytes: 0 }))).rejects.toThrow(TypeError);
    await expect(fetchImportUrl(`${ORIGIN}/x`, opts({ maxBytes: 1.5 }))).rejects.toThrow(TypeError);
  });

  it('refuses the test-only dispatcher outside Vitest', async () => {
    const prev = process.env.VITEST;
    process.env.VITEST = '';
    try {
      await expect(fetchImportUrl(`${ORIGIN}/x`, opts())).rejects.toThrow(
        /only available under test/
      );
    } finally {
      process.env.VITEST = prev;
    }
  });
});

// ─── fetchImportUrl (real socket) ──────────────────────────────────────────

/**
 * The same refusals over a real undici connection. MockAgent hands back a
 * body that has no socket behind it; these use a raw TCP server that writes
 * each response in ONE write, so the whole body has arrived by the time the
 * helper decides to refuse it — the case where discarding the body must not
 * raise an error nobody listens for (in the Trigger task that error would
 * fail the attempt, and the caller would lose the specific refusal).
 *
 * The import URL stays https and is still resolved through `resolveAll`; the
 * test dispatcher only rewrites the origin to the local plain-HTTP server.
 */
describe('fetchImportUrl (real socket)', () => {
  const ORIGIN = 'https://files.example.com';
  const publicDns: ResolveAll = async () => [{ address: '93.184.216.34', family: 4 }];

  let server: NetServer;
  let port: number;
  let base: Agent;
  let dispatcher: Dispatcher;
  /** What the server writes back, in one write, once it has read a request. */
  let reply: (socket: Socket) => void;
  /** Every connection the server accepted. */
  let sockets: Socket[];
  const strays: unknown[] = [];
  const onStray = (e: unknown) => strays.push(e);

  beforeEach(async () => {
    sockets = [];
    strays.length = 0;
    process.on('uncaughtException', onStray);
    process.on('unhandledRejection', onStray);
    server = createNetServer(socket => {
      sockets.push(socket);
      socket.on('error', () => {});
      socket.once('data', () => reply(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
    base = new Agent();
    dispatcher = base.compose(
      dispatch => (opts, handler) =>
        dispatch({ ...opts, origin: `http://127.0.0.1:${port}` }, handler)
    );
  });

  afterEach(async () => {
    await base.destroy();
    server.close();
    await once(server, 'close');
    process.off('uncaughtException', onStray);
    process.off('unhandledRejection', onStray);
  });

  const opts = (extra: Partial<Parameters<typeof fetchImportUrl>[1]> = {}) => ({
    maxBytes: 16,
    resolveAll: publicDns,
    __testOnlyDispatcher: dispatcher,
    ...extra,
  });

  /** A complete HTTP/1.1 response, written in one go. */
  const respond =
    (head: string, body = '') =>
    (socket: Socket) => {
      socket.write(`${head}\r\n\r\n${body}`);
    };

  /** Long enough for an `error` emitted on a later tick to have surfaced. */
  const settle = () => new Promise(r => setTimeout(r, 100));

  it('refuses a 404 whose body arrived with the headers, with nothing left uncaught', async () => {
    reply = respond('HTTP/1.1 404 Not Found\r\nContent-Length: 9', 'not found');
    const err = await expectCode(fetchImportUrl(`${ORIGIN}/gone`, opts()), 'HTTP_ERROR');
    expect(err.status).toBe(404);
    expect(err.message).toBe('The server answered HTTP 404.');
    await settle();
    expect(strays).toEqual([]);
  });

  it('refuses a redirect whose body arrived with the headers, with nothing left uncaught', async () => {
    reply = respond('HTTP/1.1 302 Found\r\nLocation: /final.pdf\r\nContent-Length: 5', 'moved');
    const err = await expectCode(fetchImportUrl(`${ORIGIN}/moved`, opts()), 'REDIRECT_REFUSED');
    expect(err.status).toBe(302);
    expect(err.message).toContain('https://files.example.com/final.pdf');
    await settle();
    expect(strays).toEqual([]);
  });

  it('refuses an over-limit Content-Length whose body arrived with the headers, with nothing left uncaught', async () => {
    reply = respond('HTTP/1.1 200 OK\r\nContent-Length: 64', 'x'.repeat(64));
    const err = await expectCode(fetchImportUrl(`${ORIGIN}/big`, opts()), 'TOO_LARGE');
    expect(err.message).toBe('The file is 64 bytes, over the 16-byte limit.');
    await settle();
    expect(strays).toEqual([]);
  });

  it('stops reading at the cap when the whole body arrived with the headers', async () => {
    const chunk = 'x'.repeat(32);
    reply = respond(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked',
      `20\r\n${chunk}\r\n20\r\n${chunk}\r\n0\r\n\r\n`
    );
    const res = await fetchImportUrl(`${ORIGIN}/over-cap`, opts());
    await expectCode(drain(res.body), 'TOO_LARGE');
    await settle();
    expect(strays).toEqual([]);
  });

  it('cancels a fetched but unread body with nothing left uncaught', async () => {
    reply = respond('HTTP/1.1 200 OK\r\nContent-Length: 4', 'tiny');
    const res = await fetchImportUrl(`${ORIGIN}/tiny`, opts());
    await res.cancel();
    await settle();
    expect(strays).toEqual([]);
  });

  it('closes the connection when an endless body is cancelled unread', async () => {
    let pump: NodeJS.Timeout | undefined;
    reply = socket => {
      socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n');
      pump = setInterval(() => socket.write('4\r\nmore\r\n'), 5);
    };
    try {
      const res = await fetchImportUrl(`${ORIGIN}/endless`, opts({ maxBytes: 1 << 20 }));
      await res.cancel();
      await settle();
      expect(sockets).toHaveLength(1);
      expect(sockets[0].destroyed).toBe(true);
      expect(strays).toEqual([]);
    } finally {
      clearInterval(pump);
    }
  });

  it('still reports a connection lost mid-body to the reader', async () => {
    reply = socket => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nhalf');
      setTimeout(() => socket.destroy(), 20);
    };
    const res = await fetchImportUrl(`${ORIGIN}/cut`, opts());
    await expectCode(drain(res.body), 'FETCH_FAILED');
    await settle();
    expect(strays).toEqual([]);
  });

  it.each([
    ['two lines, identity then gzip', 'Content-Encoding: identity\r\nContent-Encoding: gzip'],
    ['a list, identity then gzip', 'Content-Encoding: identity, gzip'],
    ['two lines in mixed case', 'Content-Encoding: Identity\r\nContent-Encoding: GZip'],
    ['a padded list across lines', 'Content-Encoding:  identity ,\r\nContent-Encoding: BR '],
  ])('refuses a compressed body whatever the header shape (%s)', async (_label, lines) => {
    reply = respond(`HTTP/1.1 200 OK\r\n${lines}\r\nContent-Length: 4`, 'zzzz');
    const err = await expectCode(fetchImportUrl(`${ORIGIN}/z`, opts()), 'UNSUPPORTED_ENCODING');
    expect(err.message).toMatch(/only uncompressed downloads/);
    await settle();
    expect(strays).toEqual([]);
  });

  it.each([
    ['one identity line', 'Content-Encoding: identity'],
    [
      'two identity lines in mixed case',
      'Content-Encoding: Identity\r\nContent-Encoding: IDENTITY',
    ],
    ['an identity list', 'Content-Encoding: identity, identity'],
  ])('accepts a body that is identity throughout (%s)', async (_label, lines) => {
    reply = respond(`HTTP/1.1 200 OK\r\n${lines}\r\nContent-Length: 4`, 'tiny');
    const res = await fetchImportUrl(`${ORIGIN}/plain`, opts());
    expect(await drain(res.body)).toBe(4);
  });

  it('fails a response with two Content-Length headers rather than reading either', async () => {
    reply = respond('HTTP/1.1 200 OK\r\nContent-Length: 4\r\nContent-Length: 999999', 'tiny');
    await expectCode(fetchImportUrl(`${ORIGIN}/twice`, opts()), 'FETCH_FAILED');
    await settle();
    expect(strays).toEqual([]);
  });

  it('streams a body that fits', async () => {
    reply = respond('HTTP/1.1 200 OK\r\nContent-Length: 4', 'tiny');
    const res = await fetchImportUrl(`${ORIGIN}/tiny`, opts());
    expect(await drain(res.body)).toBe(4);
    await settle();
    expect(strays).toEqual([]);
  });
});

describe('filenameFromContentDisposition', () => {
  it.each([
    ['attachment; filename="report.pdf"', 'report.pdf'],
    ['attachment; filename=report.pdf', 'report.pdf'],
    [`attachment; filename*=UTF-8''na%C3%AFve%20file.txt`, 'naïve file.txt'],
    ['attachment; filename="a\\"b.txt"', 'a"b.txt'],
    ['attachment; filename="..\\\\..\\\\win.ini"', 'win.ini'],
    ['attachment; filename="/etc/passwd"', 'passwd'],
    ['attachment; filename=".."', null],
    ['inline', null],
    [null, null],
  ])('%s → %s', (value, expected) => {
    expect(filenameFromContentDisposition(value)).toBe(expected);
  });
});
