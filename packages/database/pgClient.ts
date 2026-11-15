/**
 * Every Prisma client on Node goes through here: Prisma's pg driver adapter
 * (node-postgres), configured from the database URL.
 *
 * node-postgres reads the URL itself but ignores the parameters Prisma's own
 * engine honoured, so they are read here and passed to pg in code:
 *
 * | URL parameter       | Prisma 6 meant                     | here                                        |
 * |---------------------|------------------------------------|---------------------------------------------|
 * | `connection_limit`  | pool size                          | `max` (default 10, Prisma 7's)              |
 * | `connect_timeout`   | seconds to establish a connection  | the client's own connect timer (default 5 s) |
 * | `pool_timeout`      | seconds to wait for a free one     | the pool's wait, `connectionTimeoutMillis` (default 10 s) |
 * | `pgbouncer`         | no prepared statements             | dropped: the adapter's are unnamed          |
 * | `schema`            | the search path                    | the adapter's `schema` option for model queries (`public`: nothing); raw SQL keeps the session's search path |
 * | `sslmode`           | TLS                                | an explicit `ssl` option (see below)        |
 * | `channel_binding`   | SCRAM channel binding              | `enableChannelBinding`                      |
 *
 * The two timeouts are kept apart: the pool's `connectionTimeoutMillis` is the
 * wait for a free pooled connection, and every connection the pool opens is a
 * `Client` subclass carrying `connect_timeout` as its own connect timer (its
 * failure reads `timeout expired`). `0` turns off only its own wait. pg-pool
 * also bounds a NEW connection by its wait, so a connect gives up after the
 * SHORTER of the two (with `connect_timeout=0`, after `pool_timeout`, unless
 * that is 0 too). These
 * parameters are removed from the string handed to pg. A parameter given
 * twice takes its last value, as pg and Prisma 6 read it.
 *
 * The same subclass listens for `'error'` from the moment it exists. pg emits
 * one when the server ends a session as it opens (a backend terminated during
 * startup); the adapter attaches its own listener only after the pool hands
 * the connection over, and an `'error'` with no listener ends the process.
 * The failure still reaches the query, as a rejected connect.
 *
 * TLS: the factory decides it, unless the URL names certificate files
 * (`sslrootcert`, `sslcert`, `sslkey`), which pg reads and decides with.
 * `sslmode=require` (and `prefer`, `allow`, `verify-ca`) means FULL
 * verification (chain and host name), as it does in pg 8.x, `no-verify` TLS
 * without verification, `disable` no TLS. With no `sslmode`, `ssl=` decides:
 * `0`, `false` or empty is off, `1` or `true` verified TLS, `no-verify` TLS
 * without verification; any other value is refused. The decision is passed as
 * an explicit `ssl` option and is the only source of the TLS setting: `sslmode`
 * and `ssl` are removed from the string (pg's deprecation warning for
 * `sslmode=require` is not triggered), and `sslnegotiation` is passed as an
 * option too (`direct` needs TLS). A URL with none of these connects WITHOUT
 * TLS. A provider whose certificate is signed by a private CA needs
 * `sslrootcert=` or `sslmode=no-verify`. Values compare case-insensitively.
 *
 * Channel binding: `channel_binding=require|prefer` sets `enableChannelBinding`,
 * so pg authenticates with SCRAM-SHA-256-PLUS when the server offers it, and
 * otherwise tells the server it supports binding, which a server that does
 * offer it treats as a downgrade and refuses. Like libpq, `require` without TLS
 * is refused here, judged on what pg itself will use (`pgWillUseTls`: a pg
 * Client built from the final config, which does not connect). Unlike libpq's
 * `require`, a TLS server that offers no binding at all is not refused.
 *
 * Refused at boot, as values that cannot mean anything: a pool size or a
 * timeout that is not a whole number (or a pool of 0), an unknown `sslmode`,
 * `ssl`, `sslnegotiation` or `channel_binding`, and `channel_binding=require`
 * or `sslnegotiation=direct` without TLS.
 *
 * `keepAlive` is always on with a 10 s initial delay (the OS default is about
 * two hours on Linux), so a connection the network dropped is noticed, and
 * `allowExitOnIdle` too (an idle pool never keeps Node alive, so a script that
 * forgets `$disconnect()` still exits).
 *
 * Importing this opens nothing; nothing connects until the first query.
 */
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

export const DEFAULT_POOL_SIZE = 10;
export const DEFAULT_CONNECT_TIMEOUT_S = 5;
export const DEFAULT_POOL_TIMEOUT_S = 10;
export const KEEPALIVE_INITIAL_DELAY_MS = 10_000;

/** A pg `Client` that opens with its own connect timeout and never emits an unheard `'error'`. */
export type PgClientClass = typeof pg.Client & { readonly connectTimeoutMillis: number };

/** The `Client` class the pool opens connections with: `connect_timeout`, and an `'error'` listener. */
export function clientWithConnectTimeout(connectTimeoutMillis: number): PgClientClass {
  class TimedClient extends pg.Client {
    static readonly connectTimeoutMillis = connectTimeoutMillis;
    constructor(config?: string | pg.ClientConfig) {
      const base = typeof config === 'string' ? { connectionString: config } : (config ?? {});
      // pg-pool hands its options over with `password` made non-enumerable (so
      // it stays out of stack traces); a spread would drop it, so copy it.
      const password = 'password' in base ? { password: base.password } : {};
      super({ ...base, ...password, connectionTimeoutMillis: connectTimeoutMillis });
      // Errors also reach the pending connect or query; this only keeps one
      // raised before anyone else listens from ending the process.
      this.on('error', () => {});
    }

  }
  return TimedClient;
}


/** The node-postgres pool options this module sets (a subset of pg's `PoolConfig`). */
export interface PgPoolConfig {
  connectionString: string | undefined;
  max: number;
  /** The pool's wait for a free connection (`pool_timeout`). */
  connectionTimeoutMillis: number;
  /** Opens every connection with `connect_timeout`. */
  Client: PgClientClass;
  keepAlive: boolean;
  keepAliveInitialDelayMillis: number;
  allowExitOnIdle: boolean;
  idleTimeoutMillis?: number;
  ssl?: false | { rejectUnauthorized: boolean };
  sslnegotiation?: 'postgres' | 'direct';
  enableChannelBinding?: boolean;
  options?: string;
}

/** What the URL asks for, as pg options, and the string pg should read. */
export interface PgUrlConfig {
  connectionString: string | undefined;
  max: number;
  connectTimeoutMillis: number;
  poolTimeoutMillis: number;
  ssl?: false | { rejectUnauthorized: boolean };
  /** `sslnegotiation`, moved out of the string when the factory decides TLS. */
  sslnegotiation?: 'postgres' | 'direct';
  enableChannelBinding?: boolean;
  /** The schema the adapter qualifies its queries with (absent: `public`). */
  schema?: string;
}

const PRISMA_ONLY = ['connection_limit', 'pool_timeout', 'connect_timeout', 'pgbouncer', 'schema'];

/** The parameter's LAST value, as pg and Prisma 6 read a repeated one; null when absent. */
function last(params: URLSearchParams, name: string): string | null {
  const all = params.getAll(name);
  return all.length ? all[all.length - 1] : null;
}

/** A non-negative whole number of seconds, or undefined when absent. */
function seconds(params: URLSearchParams, name: string): number | undefined {
  const raw = last(params, name);
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(
      `[database] ${name}=${raw} in the database URL is not a whole number of seconds`
    );
  }
  return Number(raw);
}

/**
 * Read the database URL into pg options (see the top of this file). Throws on
 * a value that cannot mean anything (a pool of 0, a timeout of "abc", an
 * unknown TLS mode).
 */
export function pgConfigFromUrl(url: string | undefined): PgUrlConfig {
  const defaults: PgUrlConfig = {
    connectionString: url,
    max: DEFAULT_POOL_SIZE,
    connectTimeoutMillis: DEFAULT_CONNECT_TIMEOUT_S * 1000,
    poolTimeoutMillis: DEFAULT_POOL_TIMEOUT_S * 1000,
  };
  if (!url) return defaults;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL pg can read either; let the first query report it.
    return defaults;
  }
  const params = parsed.searchParams;

  const limitRaw = last(params, 'connection_limit');
  let max = DEFAULT_POOL_SIZE;
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw.trim()) || Number(limitRaw) < 1) {
      throw new Error(
        `[database] connection_limit=${limitRaw} in the database URL is not a pool size of 1 or more`
      );
    }
    max = Number(limitRaw);
  }
  // 0 = no timeout for that wait (Prisma 6's meaning, and pg's).
  const connect = seconds(params, 'connect_timeout') ?? DEFAULT_CONNECT_TIMEOUT_S;
  const pool = seconds(params, 'pool_timeout') ?? DEFAULT_POOL_TIMEOUT_S;
  const schema = last(params, 'schema');

  const config: PgUrlConfig = {
    connectionString: url,
    max,
    connectTimeoutMillis: connect * 1000,
    poolTimeoutMillis: pool * 1000,
  };
  if (schema !== null && schema !== '' && schema !== 'public') config.schema = schema;
  for (const name of PRISMA_ONLY) params.delete(name);

  // Only certificate files hand the TLS decision to pg (it reads them).
  const ownCertificates = ['sslrootcert', 'sslcert', 'sslkey'].some(p => params.has(p));
  if (!ownCertificates) {
    const sslmode = last(params, 'sslmode')?.toLowerCase() ?? null;
    const ssl = last(params, 'ssl');
    if (sslmode !== null) config.ssl = tlsFromSslmode(sslmode);
    else if (ssl !== null) config.ssl = tlsFromSsl(ssl);
    if (config.ssl !== undefined) {
      // `sslmode` (else `ssl`) is the only source of the TLS setting: both are
      // removed from the string, and so is `sslnegotiation`, which pg would
      // read as a TLS setting of its own; it is passed as an option instead.
      params.delete('sslmode');
      params.delete('ssl');
      const negotiation = last(params, 'sslnegotiation');
      if (negotiation !== null) {
        if (negotiation !== 'direct' && negotiation !== 'postgres') {
          throw new Error(
            `[database] sslnegotiation=${negotiation} in the database URL is not a known value`
          );
        }
        if (negotiation === 'direct' && !config.ssl) {
          throw new Error('[database] sslnegotiation=direct in the database URL needs TLS');
        }
        config.sslnegotiation = negotiation;
        params.delete('sslnegotiation');
      }
    }
  }
  const channelBinding = last(params, 'channel_binding')?.toLowerCase() ?? null;
  if (channelBinding !== null) {
    if (!['require', 'prefer', 'disable'].includes(channelBinding)) {
      throw new Error(
        `[database] channel_binding=${channelBinding} in the database URL is not a known mode`
      );
    }
    config.enableChannelBinding = channelBinding !== 'disable';
    params.delete('channel_binding');
  }
  config.connectionString = parsed.toString();
  // Binding needs TLS: libpq refuses `require` on a connection without it, and
  // pg would authenticate without binding. Judged on the TLS pg itself will use
  // with this exact config (a Client is built, nothing connects).
  if (channelBinding === 'require' && !pgWillUseTls(config)) {
    throw new Error(
      '[database] channel_binding=require in the database URL needs TLS (sslmode=require or verify-full)'
    );
  }
  return config;
}

/** The TLS option an `sslmode` asks for; an unknown mode is refused. */
function tlsFromSslmode(sslmode: string): false | { rejectUnauthorized: boolean } {
  switch (sslmode) {
    case 'disable':
      return false;
    case 'no-verify':
      return { rejectUnauthorized: false };
    case 'allow':
    case 'prefer':
    case 'require':
    case 'verify-ca':
    case 'verify-full':
      return { rejectUnauthorized: true };
    default:
      throw new Error(`[database] sslmode=${sslmode} in the database URL is not a known mode`);
  }
}

/**
 * The TLS option an `ssl=` asks for when there is no `sslmode`: `0`, `false`
 * or empty is off, `1` or `true` verified TLS, `no-verify` TLS without
 * verification (any case); anything else is refused.
 */
function tlsFromSsl(raw: string): false | { rejectUnauthorized: boolean } {
  switch (raw.toLowerCase()) {
    case '':
    case '0':
    case 'false':
      return false;
    case '1':
    case 'true':
      return { rejectUnauthorized: true };
    case 'no-verify':
      return { rejectUnauthorized: false };
    default:
      throw new Error(`[database] ssl=${raw} in the database URL is not a known value`);
  }
}

/** Whether pg opens TLS for this config: what its own ConnectionParameters settle on. */
function pgWillUseTls(config: PgUrlConfig): boolean {
  const client = new pg.Client({
    connectionString: config.connectionString,
    ...(config.ssl !== undefined ? { ssl: config.ssl } : {}),
    ...(config.sslnegotiation !== undefined ? { sslnegotiation: config.sslnegotiation } : {}),
  } as pg.ClientConfig);
  return Boolean(
    (client as unknown as { connectionParameters: { ssl?: unknown } }).connectionParameters.ssl
  );
}

export interface PgClientOptions {
  /** Pool size, overriding `connection_limit` (a dedicated client's own). */
  max?: number;
  /**
   * One session, kept: never close an idle connection (pg would after 10 s
   * idle and run the next query on a NEW session, dropping a session lock or
   * setting held across a pause). For advisory locks and read-only sessions,
   * with `max: 1`.
   */
  keepIdle?: boolean;
  /**
   * Startup parameters every connection (replacements included) starts with,
   * e.g. `-c default_transaction_read_only=on`. Refused when the URL has its
   * own `options=`, which would override them in pg.
   */
  options?: string;
  /**
   * Milliseconds after which a query is abandoned client-side (pg's
   * `query_timeout`); for a dedicated client that must not hang on a
   * connection that stopped answering. Unset: no limit.
   */
  queryTimeoutMillis?: number;
}

/** The pg pool config for `url` with these client options. */
export function pgPoolConfig(url: string | undefined, client: PgClientOptions = {}): PgPoolConfig {
  const fromUrl = pgConfigFromUrl(url);
  if (client.options && fromUrl.connectionString && /[?&]options=/.test(fromUrl.connectionString)) {
    throw new Error(
      '[database] the database URL has options=, which would override the startup options this client needs'
    );
  }
  return {
    connectionString: fromUrl.connectionString,
    max: client.max ?? fromUrl.max,
    connectionTimeoutMillis: fromUrl.poolTimeoutMillis,
    Client: clientWithConnectTimeout(fromUrl.connectTimeoutMillis),
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
    allowExitOnIdle: true,
    ...(client.keepIdle ? { idleTimeoutMillis: 0 } : {}),
    ...(fromUrl.ssl !== undefined ? { ssl: fromUrl.ssl } : {}),
    ...(fromUrl.sslnegotiation !== undefined ? { sslnegotiation: fromUrl.sslnegotiation } : {}),
    ...(fromUrl.enableChannelBinding !== undefined
      ? { enableChannelBinding: fromUrl.enableChannelBinding }
      : {}),
    ...(client.options ? { options: client.options } : {}),
    ...(client.queryTimeoutMillis ? { query_timeout: client.queryTimeoutMillis } : {}),
  };
}

/** The pg driver adapter for `url` (with the URL's `schema=`, when not `public`). */
export function createPgAdapter(url: string | undefined, client: PgClientOptions = {}): PrismaPg {
  const { schema } = pgConfigFromUrl(url);
  return new PrismaPg(
    pgPoolConfig(url, client) as ConstructorParameters<typeof PrismaPg>[0],
    schema ? { schema } : undefined
  );
}

/**
 * A plain (unextended) client on its own pool. The shared client is
 * `getPrisma()` from `@classmoji/database`; this is for scripts, tests and the
 * few places that need their own session (`{ max: 1, keepIdle: true }`). The
 * caller `$disconnect()`s it.
 */
export function createPgPrismaClient(
  url: string | undefined,
  client: PgClientOptions = {}
): PrismaClient {
  return new PrismaClient({ adapter: createPgAdapter(url, client) } as never);
}
