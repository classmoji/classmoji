import { describe, expect, it, vi } from 'vitest';
import {
  clientIp,
  createMemoryLimiter,
  limiterKey,
  MAX_BODY_BYTES,
  overLimit,
  parseForm,
  readCappedBody,
  type RateLimitBinding,
} from './contactGuard';

const headers = (values: Record<string, string>) => new Headers(values);

describe('clientIp', () => {
  it('reads cf-connecting-ip on workerd and never the client-controlled headers or clientAddress', () => {
    const clientAddress = vi.fn(() => '10.0.0.1');
    const ip = clientIp(
      'workerd',
      headers({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1', 'fly-client-ip': '198.51.100.2' }),
      clientAddress,
    );
    expect(ip).toBe('203.0.113.7');
    expect(clientAddress).not.toHaveBeenCalled();
  });

  it("puts workerd requests without cf-connecting-ip in the 'unknown' bucket, ignoring X-Forwarded-For", () => {
    expect(clientIp('workerd', headers({ 'x-forwarded-for': '198.51.100.1' }), () => '10.0.0.1')).toBe('unknown');
  });

  it('reads fly-client-ip on Node, else the socket address', () => {
    expect(clientIp('node', headers({ 'fly-client-ip': '203.0.113.8' }), () => '10.0.0.1')).toBe('203.0.113.8');
    expect(clientIp('node', headers({ 'cf-connecting-ip': '203.0.113.9' }), () => '10.0.0.1')).toBe('10.0.0.1');
  });

  it("falls back to 'unknown' on Node when Astro has no address (its getter throws)", () => {
    expect(
      clientIp('node', headers({}), () => {
        throw new Error('clientAddress is not available');
      }),
    ).toBe('unknown');
  });
});

describe('limiterKey', () => {
  it('keeps IPv4 addresses as they are', () => {
    expect(limiterKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('keys IPv6 by its /64', () => {
    const key = limiterKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(key).toBe('2001:db8:1:2::/64');
    expect(limiterKey('2001:db8:1:2::1')).toBe(key);
    expect(limiterKey('2001:0DB8:0001:0002:0:0:0:ffff')).toBe(key);
    expect(limiterKey('[2001:db8:1:2::5]')).toBe(key);
    expect(limiterKey('2001:db8:1:2::5%eth0')).toBe(key);
  });

  it('gives different /64s different keys', () => {
    expect(limiterKey('2001:db8:1:3::1')).not.toBe(limiterKey('2001:db8:1:2::1'));
    expect(limiterKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(limiterKey('::1')).toBe('0:0:0:0::/64');
  });

  it('keys IPv4-mapped IPv6 as the IPv4 address', () => {
    expect(limiterKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(limiterKey('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('keeps unparseable values whole rather than merging them', () => {
    expect(limiterKey('not:an:address')).toBe('not:an:address');
    expect(limiterKey('')).toBe('unknown');
  });
});

describe('createMemoryLimiter', () => {
  it('allows max attempts per window per key, then refuses until the window passes', () => {
    let now = 0;
    const memory = createMemoryLimiter({ max: 5, windowMs: 1000, now: () => now });
    for (let i = 0; i < 5; i++) expect(memory.limited('a')).toBe(false);
    expect(memory.limited('a')).toBe(true);
    expect(memory.limited('b')).toBe(false);
    now = 1001;
    expect(memory.limited('a')).toBe(false);
  });
});

/** A rate-limit binding that allows `limit` calls per key. */
function fakeBinding(limit: number) {
  const counts = new Map<string, number>();
  const binding: RateLimitBinding & { keys: string[] } = {
    keys: [],
    async limit({ key }) {
      binding.keys.push(key);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= limit };
    },
  };
  return binding;
}

describe('overLimit', () => {
  const quiet = () => {};

  it('uses only the in-memory limit on Node, even with bindings present', async () => {
    const memory = createMemoryLimiter({ max: 5 });
    const perIp = fakeBinding(0);
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await overLimit({ runtime: 'node', key: 'k', memory, bindings: { CONTACT_RATE_LIMIT: perIp }, log: quiet }));
    }
    expect(results).toEqual([false, false, false, false, false, true]);
    expect(perIp.keys).toEqual([]);
  });

  it('on workerd applies the per-address binding by key and the global binding under "all"', async () => {
    const memory = createMemoryLimiter({ max: 5 });
    const perIp = fakeBinding(3);
    const global = fakeBinding(10);
    const bindings = { CONTACT_RATE_LIMIT: perIp, CONTACT_RATE_LIMIT_GLOBAL: global };
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await overLimit({ runtime: 'workerd', key: '2001:db8:1:2::/64', memory, bindings, log: quiet }));
    expect(results).toEqual([false, false, false, true]);
    expect(perIp.keys.every(k => k === '2001:db8:1:2::/64')).toBe(true);
    expect(global.keys).toEqual(['all', 'all', 'all']);
  });

  it('on workerd refuses once the global binding is spent, whatever the address', async () => {
    const memory = createMemoryLimiter({ max: 5 });
    const bindings = { CONTACT_RATE_LIMIT: fakeBinding(3), CONTACT_RATE_LIMIT_GLOBAL: fakeBinding(10) };
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await overLimit({ runtime: 'workerd', key: `198.51.100.${i}`, memory, bindings, log: quiet }));
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(results.slice(10)).toEqual([true, true]);
  });

  it('on workerd still applies the in-memory hourly limit', async () => {
    const memory = createMemoryLimiter({ max: 5 });
    const bindings = { CONTACT_RATE_LIMIT: fakeBinding(100), CONTACT_RATE_LIMIT_GLOBAL: fakeBinding(100) };
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await overLimit({ runtime: 'workerd', key: 'k', memory, bindings, log: quiet }));
    expect(results).toEqual([false, false, false, false, false, true]);
  });

  it('falls back to the in-memory limit (never unlimited) and logs when the bindings are missing', async () => {
    const memory = createMemoryLimiter({ max: 5 });
    const log = vi.fn();
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await overLimit({ runtime: 'workerd', key: 'k', memory, bindings: {}, log }));
    expect(results).toEqual([false, false, false, false, false, true]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('CONTACT_RATE_LIMIT binding is missing'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('CONTACT_RATE_LIMIT_GLOBAL binding is missing'));
  });

  it('treats a binding that throws like a missing one', async () => {
    const memory = createMemoryLimiter({ max: 5 });
    const log = vi.fn();
    const broken: RateLimitBinding = { limit: () => Promise.reject(new Error('unavailable')) };
    const global = fakeBinding(10);
    expect(
      await overLimit({ runtime: 'workerd', key: 'k', memory, bindings: { CONTACT_RATE_LIMIT: broken, CONTACT_RATE_LIMIT_GLOBAL: global }, log }),
    ).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('CONTACT_RATE_LIMIT binding failed'), expect.any(Error));
    expect(global.keys).toEqual(['all']);
  });

  it('does not consume the bindings once the in-memory limit refuses', async () => {
    const memory = createMemoryLimiter({ max: 1 });
    const perIp = fakeBinding(100);
    const bindings = { CONTACT_RATE_LIMIT: perIp, CONTACT_RATE_LIMIT_GLOBAL: fakeBinding(100) };
    await overLimit({ runtime: 'workerd', key: 'k', memory, bindings, log: quiet });
    expect(await overLimit({ runtime: 'workerd', key: 'k', memory, bindings, log: quiet })).toBe(true);
    expect(perIp.keys).toHaveLength(1);
  });
});

describe('readCappedBody', () => {
  const post = (body: BodyInit | null, extra: Record<string, string> = {}) =>
    new Request('https://site.staging.classmoji.io/api/contact', { method: 'POST', body, headers: extra });

  it('reads a body within the cap', async () => {
    const body = await readCappedBody(post('name=a&email=a%40b.co'));
    expect(body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(body as Uint8Array)).toBe('name=a&email=a%40b.co');
  });

  it('refuses a declared length over the cap without reading the body', async () => {
    const request = post('small', { 'content-length': String(MAX_BODY_BYTES + 1) });
    const reader = vi.spyOn(ReadableStream.prototype, 'getReader');
    expect(await readCappedBody(request)).toBe('too-large');
    expect(reader).not.toHaveBeenCalled();
    reader.mockRestore();
  });

  it('refuses a body over the cap that declares no length (chunked)', async () => {
    const chunk = new Uint8Array(16 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 5) controller.close();
        else {
          sent++;
          controller.enqueue(chunk);
        }
      },
    });
    const request = new Request('https://site.staging.classmoji.io/api/contact', {
      method: 'POST',
      body: stream,
      // @ts-expect-error Node's fetch needs duplex for a streamed body
      duplex: 'half',
    });
    expect(request.headers.get('content-length')).toBeNull();
    expect(await readCappedBody(request)).toBe('too-large');
  });

  it('refuses a body over the cap when its declared length is under it', async () => {
    const request = post('a'.repeat(MAX_BODY_BYTES + 10), { 'content-length': '10' });
    expect(await readCappedBody(request)).toBe('too-large');
  });

  it('accepts exactly the cap', async () => {
    const body = await readCappedBody(post('a'.repeat(MAX_BODY_BYTES)));
    expect((body as Uint8Array).byteLength).toBe(MAX_BODY_BYTES);
  });

  it('reads an empty body as empty', async () => {
    const body = await readCappedBody(post(null));
    expect((body as Uint8Array).byteLength).toBe(0);
  });
});

describe('parseForm', () => {
  it('parses url-encoded and multipart bodies like request.formData()', async () => {
    const encoded = new TextEncoder().encode('name=Ada&message=hi%0Athere');
    const form = await parseForm(encoded, 'application/x-www-form-urlencoded');
    expect(form.get('name')).toBe('Ada');
    expect(form.get('message')).toBe('hi\nthere');

    const multipart = new FormData();
    multipart.set('website', 'x');
    const request = new Request('https://example.test/', { method: 'POST', body: multipart });
    const bytes = new Uint8Array(await request.arrayBuffer());
    const parsed = await parseForm(bytes, request.headers.get('content-type'));
    expect(parsed.get('website')).toBe('x');
  });

  it('rejects a body with no form content type', async () => {
    await expect(parseForm(new TextEncoder().encode('name=a'), null)).rejects.toThrow();
  });
});
