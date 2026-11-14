import { describe, expect, it, vi } from 'vitest';
import {
  INFISICAL_ENV_BY_TRIGGER_ENV,
  mergeImportedSecrets,
  syncInfisicalEnvVars,
} from '../infisicalSync.js';

const TOKEN = 'fake-access-token-do-not-log';
const SECRET_VALUE = 'fake-secret-value-do-not-log';
const ENV = {
  INFISICAL_CLIENT_ID: 'client-id',
  INFISICAL_CLIENT_SECRET: 'client-secret-do-not-log',
  INFISICAL_PROJECT_ID: 'project-1',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const secret = (secretKey: string, secretValue: string) => ({ secretKey, secretValue });

/** A fetch that answers the login, then the list, recording each call. */
function mockFetch({
  login = () => json(200, { accessToken: TOKEN, expiresIn: 7200, tokenType: 'Bearer' }),
  list = () => json(200, { secrets: [secret('A', SECRET_VALUE)] }),
}: { login?: () => Response; list?: () => Response } = {}) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/v1/auth/universal-auth/login') return login();
    if (path === '/api/v4/secrets') return list();
    throw new Error(`unexpected request to ${path}`);
  });
}

function logger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Everything written to any log channel, as one string. */
function logged(log: ReturnType<typeof logger>) {
  return [...log.log.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]
    .flat()
    .map(String)
    .join('\n');
}

const noSleep = async () => {};

describe('syncInfisicalEnvVars', () => {
  it('logs in, lists the mapped environment and returns name/value pairs', async () => {
    const fetchImpl = mockFetch({
      list: () => json(200, { secrets: [secret('A', SECRET_VALUE), secret('B', 'b')] }),
    });
    const log = logger();

    const result = await syncInfisicalEnvVars({
      triggerEnvironment: 'staging',
      env: { ...ENV, INFISICAL_HOST: 'https://infisical.example.test/' },
      fetchImpl,
      sleep: noSleep,
      logger: log,
    });

    expect(result).toEqual([
      { name: 'A', value: SECRET_VALUE },
      { name: 'B', value: 'b' },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [loginUrl, loginInit] = fetchImpl.mock.calls[0];
    expect(loginUrl).toBe('https://infisical.example.test/api/v1/auth/universal-auth/login');
    expect(loginInit?.method).toBe('POST');
    expect(JSON.parse(String(loginInit?.body))).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret-do-not-log',
    });

    const [listUrl, listInit] = fetchImpl.mock.calls[1];
    const url = new URL(String(listUrl));
    expect(url.origin + url.pathname).toBe('https://infisical.example.test/api/v4/secrets');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      projectId: 'project-1',
      environment: 'sta',
      secretPath: '/',
      includeImports: 'true',
      expandSecretReferences: 'true',
      viewSecretValue: 'true',
    });
    expect((listInit?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);

    expect(log.error).not.toHaveBeenCalled();
    expect(logged(log)).not.toContain(TOKEN);
    expect(logged(log)).not.toContain(SECRET_VALUE);
  });

  it('defaults the host to app.infisical.com', async () => {
    const fetchImpl = mockFetch();
    await syncInfisicalEnvVars({
      triggerEnvironment: 'prod',
      env: ENV,
      fetchImpl,
      sleep: noSleep,
      logger: logger(),
    });
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://app.infisical.com/api/v1/auth/universal-auth/login'
    );
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get('environment')).toBe(
      'prod'
    );
  });

  it('merges imports: own secrets win, then the last import that has the key', async () => {
    const fetchImpl = mockFetch({
      list: () =>
        json(200, {
          secrets: [secret('SHARED', 'own'), secret('OWN_ONLY', 'own-only')],
          imports: [
            {
              secretPath: '/first',
              environment: 'sta',
              secrets: [secret('SHARED', 'first-import'), secret('IMPORTED', 'first-import')],
            },
            {
              secretPath: '/second',
              environment: 'sta',
              secrets: [
                secret('SHARED', 'second-import'),
                secret('IMPORTED', 'second-import'),
                secret('SECOND_ONLY', 'second-only'),
              ],
            },
          ],
        }),
    });

    const result = await syncInfisicalEnvVars({
      triggerEnvironment: 'prod',
      env: ENV,
      fetchImpl,
      sleep: noSleep,
      logger: logger(),
    });

    expect(result).toEqual([
      { name: 'SHARED', value: 'own' },
      { name: 'OWN_ONLY', value: 'own-only' },
      { name: 'IMPORTED', value: 'second-import' },
      { name: 'SECOND_ONLY', value: 'second-only' },
    ]);
  });

  it('a failed login logs the status, returns {} and never lists', async () => {
    const fetchImpl = mockFetch({
      login: () => json(401, { message: `bad credentials ${SECRET_VALUE}` }),
    });
    const log = logger();

    const result = await syncInfisicalEnvVars({
      triggerEnvironment: 'prod',
      env: ENV,
      fetchImpl,
      sleep: noSleep,
      logger: log,
    });

    expect(result).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(logged(log)).toContain('HTTP 401');
    expect(logged(log)).not.toContain(SECRET_VALUE);
    expect(logged(log)).not.toContain('client-secret-do-not-log');
  });

  it('a failed list logs the status without the body or token and returns {}', async () => {
    const fetchImpl = mockFetch({
      list: () => json(403, { message: `denied for ${TOKEN}`, secret: SECRET_VALUE }),
    });
    const log = logger();

    const result = await syncInfisicalEnvVars({
      triggerEnvironment: 'preview',
      env: ENV,
      fetchImpl,
      sleep: noSleep,
      logger: log,
    });

    expect(result).toEqual({});
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(logged(log)).toContain('HTTP 403');
    expect(logged(log)).not.toContain(TOKEN);
    expect(logged(log)).not.toContain(SECRET_VALUE);
  });

  it('a list body that is not JSON fails without quoting it', async () => {
    const fetchImpl = mockFetch({
      list: () => new Response(`not json ${SECRET_VALUE}`, { status: 200 }),
    });
    const log = logger();

    const result = await syncInfisicalEnvVars({
      triggerEnvironment: 'prod',
      env: ENV,
      fetchImpl,
      sleep: noSleep,
      logger: log,
    });

    expect(result).toEqual({});
    expect(logged(log)).toContain('not JSON');
    expect(logged(log)).not.toContain(SECRET_VALUE);
  });

  it('retries a 429, then succeeds', async () => {
    let calls = 0;
    const fetchImpl = mockFetch({
      list: () => (++calls === 1 ? json(429, {}) : json(200, { secrets: [secret('A', 'a')] })),
    });
    const sleep = vi.fn(async () => {});

    const result = await syncInfisicalEnvVars({
      triggerEnvironment: 'prod',
      env: ENV,
      fetchImpl,
      sleep,
      logger: logger(),
    });

    expect(result).toEqual([{ name: 'A', value: 'a' }]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('gives up after four retries of a 429, waiting 1, 2, 4 and 8 s', async () => {
    const fetchImpl = mockFetch({ list: () => json(429, { message: SECRET_VALUE }) });
    const sleep = vi.fn(async (_ms: number) => {});
    const log = logger();

    const result = await syncInfisicalEnvVars({
      triggerEnvironment: 'prod',
      env: ENV,
      fetchImpl,
      sleep,
      logger: log,
    });

    expect(result).toEqual({});
    // One login, then five list attempts.
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000, 8000]);
    expect(logged(log)).toContain('HTTP 429');
    expect(logged(log)).not.toContain(SECRET_VALUE);
  });

  it('retries a network error, then fails with its name and code only', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`fetch failed for Bearer ${TOKEN}`, { cause: { code: 'ENOTFOUND' } });
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const log = logger();

    const result = await syncInfisicalEnvVars({
      triggerEnvironment: 'prod',
      env: ENV,
      fetchImpl,
      sleep,
      logger: log,
    });

    expect(result).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(logged(log)).toContain('TypeError ENOTFOUND');
    expect(logged(log)).not.toContain(TOKEN);
  });

  it('does not retry a 500', async () => {
    const fetchImpl = mockFetch({ list: () => json(500, {}) });
    const sleep = vi.fn(async (_ms: number) => {});
    const log = logger();

    const result = await syncInfisicalEnvVars({
      triggerEnvironment: 'prod',
      env: ENV,
      fetchImpl,
      sleep,
      logger: log,
    });

    expect(result).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
    expect(logged(log)).toContain('HTTP 500');
  });

  it('a login without an access token fails and never lists', async () => {
    const fetchImpl = mockFetch({ login: () => json(200, { tokenType: 'Bearer' }) });
    const log = logger();

    const result = await syncInfisicalEnvVars({
      triggerEnvironment: 'prod',
      env: ENV,
      fetchImpl,
      sleep: noSleep,
      logger: log,
    });

    expect(result).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(logged(log)).toContain('no access token');
  });

  it('a list without a secrets array fails', async () => {
    const fetchImpl = mockFetch({ list: () => json(200, { imports: [] }) });
    const log = logger();

    const result = await syncInfisicalEnvVars({
      triggerEnvironment: 'prod',
      env: ENV,
      fetchImpl,
      sleep: noSleep,
      logger: log,
    });

    expect(result).toEqual({});
    expect(logged(log)).toContain('no secrets array');
  });

  it.each([
    ['no client id', { ...ENV, INFISICAL_CLIENT_ID: undefined }],
    ['no client secret', { ...ENV, INFISICAL_CLIENT_SECRET: '' }],
  ])('%s: warns, returns {} and sends nothing', async (_label, env) => {
    const fetchImpl = mockFetch();
    const log = logger();

    const result = await syncInfisicalEnvVars({
      triggerEnvironment: 'prod',
      env,
      fetchImpl,
      sleep: noSleep,
      logger: log,
    });

    expect(result).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      '[Infisical] Credentials not found, skipping secret sync.'
    );
  });

  it.each(['development', 'production', 'toString', ''])(
    'an unmapped environment (%j) syncs nothing and sends nothing',
    async triggerEnvironment => {
      const fetchImpl = mockFetch();
      const log = logger();

      const result = await syncInfisicalEnvVars({
        triggerEnvironment,
        env: ENV,
        fetchImpl,
        sleep: noSleep,
        logger: log,
      });

      expect(result).toEqual({});
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledTimes(1);
    }
  );

  it('maps exactly prod, staging, preview and dev', () => {
    expect(INFISICAL_ENV_BY_TRIGGER_ENV).toEqual({
      prod: 'prod',
      staging: 'sta',
      preview: 'dev',
      dev: 'dev',
    });
  });

  it('a missing project id fails before any request', async () => {
    const fetchImpl = mockFetch();
    const log = logger();

    const result = await syncInfisicalEnvVars({
      triggerEnvironment: 'prod',
      env: { ...ENV, INFISICAL_PROJECT_ID: undefined },
      fetchImpl,
      sleep: noSleep,
      logger: log,
    });

    expect(result).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe('mergeImportedSecrets', () => {
  it('returns own secrets unchanged without imports', () => {
    expect(mergeImportedSecrets([secret('A', '1')], undefined)).toEqual([secret('A', '1')]);
  });
});
