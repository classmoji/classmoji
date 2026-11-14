// @ts-check
/**
 * Deploy-time secret sync from Infisical, for the `syncEnvVars` extension in
 * trigger.config.js. Plain fetch against Infisical's REST API (it replaced
 * `@infisical/sdk`, which this was the only user of).
 *
 * Plain JavaScript on purpose: trigger.config.js imports it, and the config is
 * loaded by the Trigger.dev CLI at deploy time, not by a TypeScript build.
 *
 * Two requests:
 *   POST {host}/api/v1/auth/universal-auth/login  {clientId, clientSecret} -> {accessToken}
 *   GET  {host}/api/v4/secrets?projectId&environment&includeImports&expandSecretReferences&viewSecretValue
 *        -> {secrets: [{secretKey, secretValue}], imports?: [{secretPath, environment, secrets: [...]}]}
 *
 * Names starting with `TRIGGER_` are dropped by the extension itself
 * (`stripUnsyncableEnvVars` in @trigger.dev/build), not here.
 *
 * Never put a response body, a secret value or the access token in a log line
 * or an error message: the config logs `error.message`.
 */

export const DEFAULT_INFISICAL_HOST = 'https://app.infisical.com';

/**
 * Trigger.dev environment -> Infisical environment slug. Preview deploys (e.g.
 * branch "dev") pull from Infisical's dev env.
 *
 * Never default to 'prod'. An unmapped environment must NOT pull production
 * secrets — doing so would put the prod Neon DATABASE_URL into a worker that
 * is not production's. Unknown env => sync nothing. (`trigger dev` never gets
 * here: the extension does not sync for the dev target.)
 *
 * @type {Readonly<Record<string, string>>}
 */
export const INFISICAL_ENV_BY_TRIGGER_ENV = Object.freeze({
  prod: 'prod',
  staging: 'sta',
  preview: 'dev',
  dev: 'dev',
});

const REQUEST_TIMEOUT_MS = 10_000;
// Same as the SDK this replaced: up to 4 retries on HTTP 429 or a network
// error, with exponential backoff from 1 s.
const MAX_RETRIES = 4;
const INITIAL_RETRY_DELAY_MS = 1_000;

/** @typedef {{ secretKey: string, secretValue: string }} InfisicalSecret */
/** @typedef {{ secretPath?: string, environment?: string, secrets: InfisicalSecret[] }} InfisicalImport */
/** @typedef {{ name: string, value: string }} EnvVar */
/** @typedef {{ log: (...args: unknown[]) => void, warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void }} Logger */

/** @param {number} ms */
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The environment's own secrets, then each imported secret whose key is not
 * already present. The environment's own secret wins over an imported one with
 * the same key. Between imports the LAST one in the response's `imports` array
 * wins: the API returns them in position order and Infisical treats the
 * bottom-most import as the effective one (its CLI, which the other deploy
 * jobs use, walks the array from the end). The SDK call this replaced
 * (`listSecrets`) returned imports without merging them, so before this module
 * only the environment's own secrets were synced.
 *
 * @param {InfisicalSecret[]} secrets
 * @param {InfisicalImport[] | undefined} imports
 * @returns {InfisicalSecret[]}
 */
export function mergeImportedSecrets(secrets, imports) {
  const merged = [...secrets];
  const seen = new Set(merged.map(secret => secret.secretKey));
  for (const imp of [...(imports ?? [])].reverse()) {
    for (const secret of imp.secrets ?? []) {
      if (seen.has(secret.secretKey)) continue;
      seen.add(secret.secretKey);
      merged.push(secret);
    }
  }
  return merged;
}

/**
 * An error's name and system code, never its message: fetch's own messages can
 * quote a header value or a URL.
 *
 * @param {unknown} error
 */
function describe(error) {
  if (!(error instanceof Error)) return 'unknown error';
  const cause = /** @type {{ code?: unknown } | undefined} */ (error.cause);
  const code = typeof cause?.code === 'string' ? ` ${cause.code}` : '';
  return `${error.name}${code}`;
}

/**
 * Drops an unread response body. A body that fails while being dropped is
 * ignored: the caller is already reporting the status.
 *
 * @param {Response} response
 */
async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {
    // nothing to do
  }
}

/**
 * fetch with a timeout, retrying a 429 or a network error.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} init
 * @param {(ms: number) => Promise<unknown>} sleep
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(fetchImpl, url, init, sleep) {
  for (let attempt = 0; ; attempt++) {
    const delay = INITIAL_RETRY_DELAY_MS * 2 ** attempt;
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        // Never follow a redirect: it would resend the login body (the
        // client secret) to another origin and trust what that origin answers.
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt >= MAX_RETRIES) throw new Error(`Infisical request failed: ${describe(error)}`);
      await sleep(delay);
      continue;
    }
    if (response.status >= 300 && response.status < 400) {
      await discard(response);
      throw new Error(
        `Infisical answered with a redirect, which is refused (HTTP ${response.status})`
      );
    }
    if (response.status !== 429 || attempt >= MAX_RETRIES) return response;
    await discard(response);
    await sleep(delay);
  }
}

/**
 * Reads a JSON body; a body that does not parse throws a fixed message, never
 * the parser's (which quotes the body).
 *
 * @param {Response} response
 * @param {string} what
 */
async function readJson(response, what) {
  try {
    return await response.json();
  } catch (error) {
    // The request's timeout also covers reading the body.
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(`${what} timed out while reading the response (HTTP ${response.status})`);
    }
    throw new Error(`${what} returned a body that is not JSON (HTTP ${response.status})`);
  }
}

/**
 * Fetches the secrets of one Infisical environment, imports merged in.
 * Throws on any failure, with the HTTP status and never a body.
 *
 * @param {{
 *   host: string,
 *   clientId: string,
 *   clientSecret: string,
 *   projectId: string,
 *   environment: string,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<unknown>,
 * }} options
 * @returns {Promise<{ secrets: InfisicalSecret[], ownCount: number }>}
 */
export async function fetchInfisicalSecrets({
  host,
  clientId,
  clientSecret,
  projectId,
  environment,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
}) {
  const base = host.replace(/\/+$/, '');

  const login = await fetchWithRetry(
    fetchImpl,
    `${base}/api/v1/auth/universal-auth/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
    },
    sleep
  );
  if (!login.ok) {
    await discard(login);
    throw new Error(`Infisical login failed: HTTP ${login.status}`);
  }
  const { accessToken } = (await readJson(login, 'Infisical login')) ?? {};
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('Infisical login response had no access token');
  }

  const query = new URLSearchParams({
    projectId,
    environment,
    secretPath: '/',
    includeImports: 'true',
    expandSecretReferences: 'true',
    viewSecretValue: 'true',
  });
  const list = await fetchWithRetry(
    fetchImpl,
    `${base}/api/v4/secrets?${query}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    },
    sleep
  );
  if (!list.ok) {
    await discard(list);
    throw new Error(`Infisical secrets list failed: HTTP ${list.status}`);
  }
  const body = await readJson(list, 'Infisical secrets list');
  if (!body || !Array.isArray(body.secrets)) {
    throw new Error('Infisical secrets list response had no secrets array');
  }
  const imports = Array.isArray(body.imports) ? body.imports : [];
  return { secrets: mergeImportedSecrets(body.secrets, imports), ownCount: body.secrets.length };
}

/**
 * The `syncEnvVars` callback's body: the env vars to sync for one Trigger.dev
 * environment, or `{}` to sync nothing (no credentials, an unmapped
 * environment, or any failure — the deploy then continues with the variables
 * the environment already has).
 *
 * @param {{
 *   triggerEnvironment: string,
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   logger?: Logger,
 * }} options
 * @returns {Promise<EnvVar[] | {}>}
 */
export async function syncInfisicalEnvVars({
  triggerEnvironment,
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  logger = console,
}) {
  // Skip sync if credentials not available (allows local dev without Infisical)
  if (!env.INFISICAL_CLIENT_ID || !env.INFISICAL_CLIENT_SECRET) {
    logger.warn('[Infisical] Credentials not found, skipping secret sync.');
    return {};
  }

  const infisicalEnv = Object.hasOwn(INFISICAL_ENV_BY_TRIGGER_ENV, triggerEnvironment)
    ? INFISICAL_ENV_BY_TRIGGER_ENV[triggerEnvironment]
    : undefined;
  if (!infisicalEnv) {
    logger.warn(
      `[Infisical] No Infisical env mapped for Trigger.dev env "${triggerEnvironment}", skipping secret sync.`
    );
    return {};
  }

  try {
    if (!env.INFISICAL_PROJECT_ID) throw new Error('INFISICAL_PROJECT_ID is not set');

    logger.log(
      `[Infisical] Syncing secrets from environment: ${infisicalEnv} (Trigger.dev env: ${triggerEnvironment})`
    );

    const { secrets, ownCount } = await fetchInfisicalSecrets({
      host: env.INFISICAL_HOST || DEFAULT_INFISICAL_HOST,
      clientId: env.INFISICAL_CLIENT_ID,
      clientSecret: env.INFISICAL_CLIENT_SECRET,
      projectId: env.INFISICAL_PROJECT_ID,
      environment: infisicalEnv,
      fetchImpl,
      sleep,
    });

    logger.log(
      `[Infisical] Successfully fetched ${secrets.length} secrets (${ownCount} own, ${secrets.length - ownCount} imported)`
    );

    // Tasks use the pooled DATABASE_URL, the same one the web apps use.
    // The direct endpoint is synced as DATABASE_URL_UNPOOLED like any other
    // secret, for the few places that need session state (a session-level
    // advisory lock, a session setting).
    return secrets.map(secret => ({ name: secret.secretKey, value: secret.secretValue }));
  } catch (error) {
    logger.error(
      '[Infisical] Failed to sync secrets:',
      error instanceof Error ? error.message : String(error)
    );
    // Return empty object to allow deployment to continue with existing vars
    return {};
  }
}
