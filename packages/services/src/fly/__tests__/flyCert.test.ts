/**
 * Unit tests for the Fly certificate client.
 *
 * `fetch` is stubbed, so what is under test is everything AROUND the network
 * call — which is where this module's value is:
 *
 *  - it refuses to run at all without both credentials, so a deployment
 *    without them degrades instead of crashing (five apps import
 *    `@classmoji/services`; one of them will ever have these secrets);
 *  - it never guesses the app, because staging and production share a
 *    `fly.toml` and a wrong guess writes a certificate onto the other one;
 *  - it is idempotent in both directions, because every caller can be retried.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  addCert,
  getCertStatus,
  removeCert,
  listCerts,
  isFlyCertsConfigured,
  FlyCertError,
  FLY_CERT_ERROR,
} = await import('../index.ts');

type FetchCall = { url: string; init: RequestInit };

/** The response shape the client actually reads: `ok`, `status`, `text()`. */
type StubResponse = { ok: boolean; status: number; text: () => Promise<string> };

let calls: FetchCall[] = [];
let fetchMock: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<StubResponse>>>;

/** Queue one response per expected call. */
const respond = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

beforeEach(() => {
  calls = [];
  process.env.FLY_CERTS_API_TOKEN = 'tok_test';
  process.env.FLY_PAGES_APP = 'classmoji-pages-staging';
  delete process.env.FLY_API_HOSTNAME;

  fetchMock = vi.fn();
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return fetchMock(url, init);
  });
});

afterEach(() => {
  delete process.env.FLY_CERTS_API_TOKEN;
  delete process.env.FLY_PAGES_APP;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('configuration', () => {
  it('is off until BOTH the token and the app are set', () => {
    expect(isFlyCertsConfigured()).toBe(true);

    delete process.env.FLY_PAGES_APP;
    expect(isFlyCertsConfigured()).toBe(false);

    process.env.FLY_PAGES_APP = 'classmoji-pages';
    delete process.env.FLY_CERTS_API_TOKEN;
    expect(isFlyCertsConfigured()).toBe(false);
  });

  it('REFUSES to call Fly when FLY_PAGES_APP is unset', async () => {
    // There is deliberately no default app. Staging and production share one
    // fly.toml, so a fallback would mean a staging click writing a certificate
    // onto the production app.
    delete process.env.FLY_PAGES_APP;

    const error = await addCert('cs52.me').catch(e => e);
    expect(error).toBeInstanceOf(FlyCertError);
    expect(error.code).toBe(FLY_CERT_ERROR.NOT_CONFIGURED);
    expect(calls).toHaveLength(0);
  });

  it('reads the token from FLY_CERTS_API_TOKEN, never FLY_API_TOKEN', async () => {
    // FLY_API_TOKEN is the name flyctl itself reads; a certificate credential
    // living there would silently re-authenticate local flyctl commands.
    delete process.env.FLY_CERTS_API_TOKEN;
    process.env.FLY_API_TOKEN = 'tok_flyctl';

    const error = await addCert('cs52.me').catch(e => e);
    expect(error.code).toBe(FLY_CERT_ERROR.NOT_CONFIGURED);

    delete process.env.FLY_API_TOKEN;
  });
});

describe('addCert', () => {
  it('POSTs the hostname to the app-scoped acme endpoint with a bearer token', async () => {
    fetchMock.mockResolvedValue(
      respond(201, { hostname: 'cs52.me', status: 'pending_validation', configured: false })
    );

    const result = await addCert('cs52.me');

    expect(calls[0].url).toBe(
      'https://api.machines.dev/v1/apps/classmoji-pages-staging/certificates/acme'
    );
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok_test');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ hostname: 'cs52.me' });
    expect(result.status).toBe('pending_validation');
    expect(result.configured).toBe(false);
  });

  it('is idempotent: a conflict resolves by reading the existing certificate', async () => {
    // setCustomDomain writes the row first, so a hard failure here would leave
    // a claimed domain the admin cannot provision without un-claiming it.
    fetchMock
      .mockResolvedValueOnce(respond(409, { error: 'already exists' }))
      .mockResolvedValueOnce(respond(200, { hostname: 'cs52.me', status: 'active' }));

    const result = await addCert('cs52.me');

    expect(result.status).toBe('active');
    expect(calls[1].url).toContain('/certificates/cs52.me');
    expect(calls[1].init.method).toBe('GET');
  });

  it('normalizes dns_requirements and keeps the raw payload alongside', async () => {
    // The A/AAAA addresses are PER APP, so the admin UI must render what Fly
    // returned rather than a constant pair of IPs.
    const payload = {
      hostname: 'cs52.me',
      status: 'pending_ownership',
      configured: false,
      validation: { dns_configured: false, ownership_txt_configured: false },
      dns_requirements: {
        a: ['66.241.125.9'],
        aaaa: ['2a09:8280:1::d4:1f04:0'],
        ownership: ['_fly-ownership.cs52.me TXT abc'],
      },
      validation_errors: [{ message: 'no AAAA record' }],
    };
    fetchMock.mockResolvedValue(respond(201, payload));

    const result = await addCert('cs52.me');

    expect(result.dnsRequirements.aaaa).toEqual(['2a09:8280:1::d4:1f04:0']);
    expect(result.dnsRequirements.ownership).toEqual(['_fly-ownership.cs52.me TXT abc']);
    expect(result.validationErrors).toHaveLength(1);
    expect(result.raw).toEqual(payload);
  });

  it('surfaces an auth failure as UNAUTHORIZED without retrying', async () => {
    // Retrying a bad token three times just makes the admin wait three times as
    // long for the same message.
    fetchMock.mockResolvedValue(respond(403, 'not authorized'));

    const error = await addCert('cs52.me').catch(e => e);
    expect(error.code).toBe(FLY_CERT_ERROR.UNAUTHORIZED);
    expect(calls).toHaveLength(1);
  });

  it('retries a 5xx and succeeds on a later attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(502, 'bad gateway'))
      .mockResolvedValueOnce(respond(201, { hostname: 'cs52.me', status: 'active' }));

    await expect(addCert('cs52.me')).resolves.toMatchObject({ status: 'active' });
    expect(calls).toHaveLength(2);
  });

  it('reports a rate limit as its own code once retries are exhausted', async () => {
    fetchMock.mockResolvedValue(respond(429, 'too many certificates'));

    const error = await addCert('cs52.me').catch(e => e);
    expect(error.code).toBe(FLY_CERT_ERROR.RATE_LIMITED);
    expect(calls).toHaveLength(3);
  });
});

describe('getCertStatus', () => {
  it('GETs by default', async () => {
    fetchMock.mockResolvedValue(respond(200, { hostname: 'cs52.me', status: 'active' }));
    await getCertStatus('cs52.me');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].url).toContain('/certificates/cs52.me');
  });

  it('POSTs to /check when asked to re-resolve DNS', async () => {
    fetchMock.mockResolvedValue(
      respond(200, {
        hostname: 'cs52.me',
        status: 'active',
        configured: true,
        dns_records: { a: ['66.241.125.9'] },
      })
    );

    const result = await getCertStatus('cs52.me', { check: true });

    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].url).toContain('/certificates/cs52.me/check');
    // The difference between "we asked for this record" and "this record is
    // live" is exactly what /check adds.
    expect(result.dnsRecords).toEqual({ a: ['66.241.125.9'] });
  });
});

describe('removeCert', () => {
  it('DELETEs and reports success', async () => {
    fetchMock.mockResolvedValue(respond(204, ''));
    await expect(removeCert('cs52.me')).resolves.toBe(true);
    expect(calls[0].init.method).toBe('DELETE');
  });

  it('treats a missing certificate as already removed', async () => {
    // Every caller is expressing "this hostname must not have a certificate".
    // A hostname that already has none satisfies that.
    fetchMock.mockResolvedValue(respond(404, 'not found'));
    await expect(removeCert('gone.example')).resolves.toBe(false);
  });

  describe('platform hostnames', () => {
    // This app carries the wildcard that terminates TLS for every
    // {subdomain}.classmoji.io class site, plus the canonical `pages.` host.
    // Neither can ever be a claim, so nothing legitimate reaches this — and a
    // handshake that fails has no HTTP status, so deleting one would be an
    // outage every health check reports as healthy.
    it.each([
      '*.classmoji.io',
      'classmoji.io',
      'pages.classmoji.io',
      '*.staging.classmoji.io',
      'classmoji-pages.fly.dev',
      'cs52.lvh.me',
      '  PAGES.CLASSMOJI.IO  ',
    ])('REFUSES to delete %s, without calling Fly at all', async hostname => {
      const error = await removeCert(hostname).catch(e => e);
      expect(error).toBeInstanceOf(FlyCertError);
      expect(error.code).toBe(FLY_CERT_ERROR.REFUSED);
      expect(calls).toHaveLength(0);
    });

    it('refuses before it even reads the config', async () => {
      // The refusal is ours, not Fly's, so an unconfigured deployment must not
      // report it as a configuration problem and mask what was attempted.
      delete process.env.FLY_CERTS_API_TOKEN;
      delete process.env.FLY_PAGES_APP;

      const error = await removeCert('*.classmoji.io').catch(e => e);
      expect(error.code).toBe(FLY_CERT_ERROR.REFUSED);
    });
  });
});

describe('listCerts', () => {
  it('reads a bare array of certificates', async () => {
    fetchMock.mockResolvedValue(
      respond(200, [{ hostname: 'cs52.me' }, { hostname: 'cs61.example' }])
    );
    await expect(listCerts()).resolves.toEqual(['cs52.me', 'cs61.example']);
  });

  it('tolerates a wrapped response shape', async () => {
    // The reconcile task DELETES based on this list, so mis-parsing it into an
    // empty array must not read as "nothing is claimed".
    fetchMock.mockResolvedValue(respond(200, { certificates: [{ hostname: 'cs52.me' }] }));
    await expect(listCerts()).resolves.toEqual(['cs52.me']);
  });

  it('drops rows with no usable hostname', async () => {
    fetchMock.mockResolvedValue(respond(200, [{ hostname: 'cs52.me' }, {}, { hostname: '' }]));
    await expect(listCerts()).resolves.toEqual(['cs52.me']);
  });
});
