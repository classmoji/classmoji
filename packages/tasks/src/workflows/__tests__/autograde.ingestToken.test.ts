/**
 * The ingest token committed into student workflows lives a year. Inside a
 * deployed task that holds a run token (TRIGGER_RUN_TOKEN), the Trigger.dev SDK
 * has public tokens minted by the server, which refuses lifetimes over 30 days.
 * The token must be signed locally with the environment's secret key instead.
 *
 * The real SDK runs here. Only the network (fetch) and our services are faked,
 * and the SDK is told it runs inside a task the way the worker tells it.
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generate: vi.fn() }));

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {},
  getGitProvider: vi.fn(),
  generateClassroomWorkflow: mocks.generate,
  generateGitlabCi: mocks.generate,
  signAutogradeRepoToken: () => 'repo-token',
  verifyAutogradeCallbackToken: vi.fn(),
}));

const { buildClassroomWorkflowYaml } = await import('../autograde.ts');

const SECRET_KEY = 'tr_prod_ingestTokenTestKey0123';
const CLAIMS_PATH = '/api/v1/auth/jwt/claims';
const PUBLIC_TOKENS_PATH = '/api/v1/auth/public-tokens';

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Shaped like the run token a deployed task holds; the SDK only decodes it. */
const runToken = () =>
  [
    b64url({ alg: 'HS256', typ: 'run+jwt' }),
    b64url({
      token_use: 'run',
      aud: 'trigger:api',
      exp: Math.floor(Date.now() / 1000) + 3600,
      scopes: ['admin'],
    }),
    'c2lnbmF0dXJl',
  ].join('.');

/** The SDK's global registry: a registered task context means "inside a task". */
const registry = (): Record<string, unknown> => {
  const scope = globalThis as unknown as Record<symbol, Record<string, unknown> | undefined>;
  const key = Symbol.for('dev.trigger.ts.api');
  scope[key] ??= {};
  return scope[key];
};

const ENV_KEYS = [
  'TRIGGER_SECRET_KEY',
  'TRIGGER_RUN_TOKEN',
  'TRIGGER_API_URL',
  'AUTOGRADE_CALLBACK_URL',
] as const;
let savedEnv: Record<string, string | undefined>;
let requests: { path: string; authorization: string | null }[];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  process.env.TRIGGER_SECRET_KEY = SECRET_KEY;
  process.env.TRIGGER_RUN_TOKEN = runToken();
  delete process.env.TRIGGER_API_URL;
  delete process.env.AUTOGRADE_CALLBACK_URL;
  registry()['task-context'] = {
    ctx: { environment: { type: 'PRODUCTION' }, run: { id: 'run_ingest_token_test' } },
    worker: {},
  };
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push({
        path: url.pathname,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      if (url.pathname === CLAIMS_PATH) return Response.json({ sub: 'env_test', pub: true });
      // What the server answers a public token asked for longer than 30 days.
      return Response.json({ error: 'expirationTime exceeds 30 days' }, { status: 400 });
    })
  );
  mocks.generate.mockReset().mockReturnValue('workflow-yaml');
});

afterEach(() => {
  delete registry()['task-context'];
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('the ingest token in a student workflow', () => {
  it('is signed locally with the secret key inside a task that holds a run token', async () => {
    await buildClassroomWorkflowYaml([], 'cs52-26f', 'GITHUB', 'cs52-26f/hw1-ada');

    // No server minting; the one request (the environment's claims) carries the
    // secret key, not the run token.
    expect(requests.map(request => request.path)).not.toContain(PUBLIC_TOKENS_PATH);
    expect(requests).toEqual([{ path: CLAIMS_PATH, authorization: `Bearer ${SECRET_KEY}` }]);

    const { triggerToken } = mocks.generate.mock.calls[0][1] as { triggerToken: string };
    const [header, payload, signature] = triggerToken.split('.');
    expect(
      createHmac('sha256', SECRET_KEY).update(`${header}.${payload}`).digest('base64url')
    ).toBe(signature);
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    expect(claims).toMatchObject({
      sub: 'env_test',
      otu: false,
      scopes: ['trigger:tasks:ingest_autograde_result'],
    });
    expect(claims.exp - claims.iat).toBeGreaterThan(360 * 24 * 60 * 60);
  });

  it('is not minted when workflows post to hook-station (AUTOGRADE_CALLBACK_URL)', async () => {
    process.env.AUTOGRADE_CALLBACK_URL = 'https://hooks.example.test/webhooks/callback/autograde';

    await buildClassroomWorkflowYaml([], 'cs52-26f', 'GITHUB', 'cs52-26f/hw1-ada');

    expect(requests).toEqual([]);
    expect(mocks.generate.mock.calls[0][1]).toMatchObject({
      triggerUrl: 'https://hooks.example.test/webhooks/callback/autograde',
      triggerToken: null,
    });
  });

  it('refuses to mint without the secret key instead of falling back to the run token', async () => {
    delete process.env.TRIGGER_SECRET_KEY;

    await expect(
      buildClassroomWorkflowYaml([], 'cs52-26f', 'GITHUB', 'cs52-26f/hw1-ada')
    ).rejects.toThrow(/TRIGGER_SECRET_KEY/);
    expect(requests).toEqual([]);
  });
});
