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
 *  - THE BYTE CAP. It must hold against a lying or absent Content-Length:
 *    the header is a claim, the stream is the fact.
 */

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { MockAgent, request } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
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
