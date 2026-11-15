/**
 * The database URL → node-postgres pool config mapping (pgClient.ts). Pure:
 * no database.
 */
import { createRequire } from 'node:module';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { parse } from 'pg-connection-string';
import {
  CONNECT_FAILURE_MESSAGE,
  clientWithConnectTimeout,
  createPgAdapter,
  pgConfigFromUrl,
  pgPoolConfig,
} from '../pgClient.ts';

// pg's own merge of a config object and its connection string (internal, not typed).
const ConnectionParameters = createRequire(import.meta.url)('pg/lib/connection-parameters') as new (
  config: object
) => { ssl: unknown };

const BASE = 'postgresql://u:p@db.example.test:5432/app';

// pg reads a URL's certificate files when it builds its parameters (nothing
// connects); any readable file does for these tests.
const CERT_FILE = fileURLToPath(import.meta.url);
const params = (s: string | undefined) => new URL(s!).searchParams;

describe('pgConfigFromUrl', () => {
  it('without parameters: pool 10, connect 5 s, pool wait 10 s, no TLS options', () => {
    expect(pgConfigFromUrl(BASE)).toEqual({
      connectionString: BASE,
      max: 10,
      connectTimeoutMillis: 5_000,
      poolTimeoutMillis: 10_000,
    });
  });

  it('with no URL at all, the same defaults (in milliseconds)', () => {
    expect(pgConfigFromUrl(undefined)).toEqual({
      connectionString: undefined,
      max: 10,
      connectTimeoutMillis: 5_000,
      poolTimeoutMillis: 10_000,
    });
    expect(pgConfigFromUrl('not a url')).toMatchObject({
      connectTimeoutMillis: 5_000,
      poolTimeoutMillis: 10_000,
    });
  });

  it("production's pooled URL: pool 30, connect 15 s, wait 30 s, verified TLS, binding, string cleaned", () => {
    const config = pgConfigFromUrl(
      `${BASE}?sslmode=require&channel_binding=require&connection_limit=30&pool_timeout=30&connect_timeout=15`
    );
    expect(config).toMatchObject({
      max: 30,
      connectTimeoutMillis: 15_000,
      poolTimeoutMillis: 30_000,
      ssl: { rejectUnauthorized: true },
      enableChannelBinding: true,
    });
    expect([...params(config.connectionString).keys()]).toEqual([]);
  });

  it("staging's URL (TLS and channel binding only): the defaults for the pool", () => {
    expect(pgConfigFromUrl(`${BASE}?sslmode=require&channel_binding=require`)).toMatchObject({
      max: 10,
      connectTimeoutMillis: 5_000,
      poolTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: true },
      enableChannelBinding: true,
    });
  });

  it('keeps connect_timeout and pool_timeout apart, in seconds', () => {
    expect(pgConfigFromUrl(`${BASE}?connect_timeout=20`)).toMatchObject({
      connectTimeoutMillis: 20_000,
      poolTimeoutMillis: 10_000,
    });
    expect(pgConfigFromUrl(`${BASE}?pool_timeout=2`)).toMatchObject({
      connectTimeoutMillis: 5_000,
      poolTimeoutMillis: 2_000,
    });
    expect(pgConfigFromUrl(`${BASE}?pool_timeout=2&connect_timeout=1`)).toMatchObject({
      connectTimeoutMillis: 1_000,
      poolTimeoutMillis: 2_000,
    });
  });

  it('0 turns off only its own wait', () => {
    expect(pgConfigFromUrl(`${BASE}?pool_timeout=0`)).toMatchObject({
      connectTimeoutMillis: 5_000,
      poolTimeoutMillis: 0,
    });
    expect(pgConfigFromUrl(`${BASE}?connect_timeout=0&pool_timeout=30`)).toMatchObject({
      connectTimeoutMillis: 0,
      poolTimeoutMillis: 30_000,
    });
  });

  it('a repeated parameter takes its last value, as pg and Prisma 6 do', () => {
    expect(
      pgConfigFromUrl(
        `${BASE}?connection_limit=3&connection_limit=7&connect_timeout=1&connect_timeout=2`
      )
    ).toMatchObject({ max: 7, connectTimeoutMillis: 2_000 });
    expect(pgConfigFromUrl(`${BASE}?sslmode=disable&sslmode=require`).ssl).toEqual({
      rejectUnauthorized: true,
    });
    const cleaned = params(
      pgConfigFromUrl(`${BASE}?sslmode=disable&sslmode=require`).connectionString
    );
    expect(cleaned.has('sslmode')).toBe(false);
  });

  it.each([
    'connection_limit=0',
    'connection_limit=-1',
    'connection_limit=1.5',
    'connection_limit=abc',
    'connection_limit=',
    'pool_timeout=abc',
    'pool_timeout=-2',
    'pool_timeout=1.5',
    'connect_timeout=x',
  ])('refuses %s', query => {
    expect(() => pgConfigFromUrl(`${BASE}?${query}`)).toThrow(/database URL/);
  });

  it('drops pgbouncer (the adapter prepares unnamed statements, which a transaction pooler accepts)', () => {
    expect(
      params(pgConfigFromUrl(`${BASE}?pgbouncer=true`).connectionString).has('pgbouncer')
    ).toBe(false);
  });

  it('schema=public is a no-op; another schema goes to the adapter', () => {
    const pub = pgConfigFromUrl(`${BASE}?schema=public`);
    expect(pub.schema).toBeUndefined();
    expect(params(pub.connectionString).has('schema')).toBe(false);
    const other = pgConfigFromUrl(`${BASE}?schema=tenant_a`);
    expect(other.schema).toBe('tenant_a');
    expect(params(other.connectionString).has('schema')).toBe(false);
    expect(pgConfigFromUrl(`${BASE}?schema=a&schema=b`).schema).toBe('b');
  });

  it('passes the schema to the adapter as its schema option', () => {
    const adapter = createPgAdapter(`${BASE}?schema=tenant_a`) as unknown as {
      options?: { schema?: string };
    };
    expect(adapter.options?.schema).toBe('tenant_a');
    const plain = createPgAdapter(`${BASE}?schema=public`) as unknown as { options?: unknown };
    expect(plain.options).toBeUndefined();
  });

  it.each([
    ['disable', false],
    ['no-verify', { rejectUnauthorized: false }],
    ['allow', { rejectUnauthorized: true }],
    ['prefer', { rejectUnauthorized: true }],
    ['require', { rejectUnauthorized: true }],
    ['verify-ca', { rejectUnauthorized: true }],
    ['verify-full', { rejectUnauthorized: true }],
    ['REQUIRE', { rejectUnauthorized: true }],
    ['Disable', false],
  ])('sslmode=%s', (mode, ssl) => {
    const config = pgConfigFromUrl(`${BASE}?sslmode=${mode}`);
    expect(config.ssl).toEqual(ssl);
    // pg no longer sees sslmode, so it neither re-derives TLS nor warns.
    expect(parse(config.connectionString!).sslmode).toBeUndefined();
  });

  it('leaves TLS to pg when the URL brings its own certificates', () => {
    const config = pgConfigFromUrl(`${BASE}?sslmode=verify-full&sslrootcert=${CERT_FILE}`);
    expect(config.ssl).toBeUndefined();
    expect(params(config.connectionString).get('sslmode')).toBe('verify-full');
  });

  it('refuses an unknown sslmode or channel_binding', () => {
    expect(() => pgConfigFromUrl(`${BASE}?sslmode=sometimes`)).toThrow(/sslmode/);
    expect(() => pgConfigFromUrl(`${BASE}?channel_binding=maybe`)).toThrow(/channel_binding/);
  });

  it('channel_binding=disable turns binding off; prefer and require turn it on, in any case', () => {
    expect(pgConfigFromUrl(`${BASE}?channel_binding=disable`).enableChannelBinding).toBe(false);
    expect(pgConfigFromUrl(`${BASE}?channel_binding=prefer`).enableChannelBinding).toBe(true);
    expect(
      pgConfigFromUrl(`${BASE}?sslmode=require&channel_binding=REQUIRE`).enableChannelBinding
    ).toBe(true);
    expect(pgConfigFromUrl(`${BASE}?channel_binding=Disable`).enableChannelBinding).toBe(false);
  });

  it('refuses channel_binding=require without TLS, as libpq does', () => {
    for (const query of [
      'channel_binding=require',
      'sslmode=disable&channel_binding=require',
      'ssl=0&channel_binding=require',
      'ssl=false&channel_binding=require',
      'ssl=&channel_binding=require',
      // sslmode decides, and an ssl= beside it is dropped, in either order.
      'sslmode=disable&ssl=1&channel_binding=require',
      'ssl=1&sslmode=disable&channel_binding=require',
      `sslmode=disable&sslrootcert=${CERT_FILE}&channel_binding=require`,
      // uselibpqcompat alone does not hand the decision to pg, nor turn TLS on.
      'uselibpqcompat=true&channel_binding=require',
    ]) {
      expect(() => pgConfigFromUrl(`${BASE}?${query}`), query).toThrow(/needs TLS/);
    }
    // TLS asked for in any of its spellings, or left to pg with the URL's own certificates.
    for (const query of [
      'sslmode=no-verify&channel_binding=require',
      'sslmode=allow&channel_binding=require',
      'ssl=true&channel_binding=require',
      'ssl=1&channel_binding=require',
      'ssl=no-verify&channel_binding=require',
      `sslmode=verify-full&sslrootcert=${CERT_FILE}&channel_binding=require`,
      `sslrootcert=${CERT_FILE}&channel_binding=require`,
      'sslmode=require&ssl=0&channel_binding=require',
      'ssl=0&sslmode=require&channel_binding=require',
      'sslnegotiation=direct&channel_binding=require',
    ]) {
      expect(pgConfigFromUrl(`${BASE}?${query}`).enableChannelBinding, query).toBe(true);
    }
  });

  it.each([
    ['0', false],
    ['false', false],
    ['FALSE', false],
    ['', false],
    ['1', { rejectUnauthorized: true }],
    ['true', { rejectUnauthorized: true }],
    ['TRUE', { rejectUnauthorized: true }],
    ['no-verify', { rejectUnauthorized: false }],
  ])(
    'with no sslmode, ssl=%s is the factory’s TLS setting, and ssl leaves the string',
    (value, ssl) => {
      const config = pgConfigFromUrl(`${BASE}?ssl=${value}`);
      expect(config.ssl).toEqual(ssl);
      expect(params(config.connectionString).has('ssl')).toBe(false);
    }
  );

  it('refuses an ssl= value it cannot read (pg would fail on it at connect)', () => {
    for (const value of ['yes', 'on', '2', 'verify-full']) {
      expect(() => pgConfigFromUrl(`${BASE}?ssl=${value}`), value).toThrow(
        /ssl=.*not a known value/
      );
    }
  });

  it('sslnegotiation=direct keeps the TLS setting the factory chose, and needs TLS', () => {
    const noVerify = pgPoolConfig(`${BASE}?sslmode=no-verify&sslnegotiation=direct`);
    expect(noVerify.ssl).toEqual({ rejectUnauthorized: false });
    expect(noVerify.sslnegotiation).toBe('direct');
    expect(params(noVerify.connectionString).has('sslnegotiation')).toBe(false);
    expect(new ConnectionParameters(noVerify).ssl).toEqual({ rejectUnauthorized: false });
    expect(() => pgConfigFromUrl(`${BASE}?sslmode=disable&sslnegotiation=direct`)).toThrow(
      /sslnegotiation=direct .* needs TLS/
    );
    expect(() => pgConfigFromUrl(`${BASE}?ssl=0&sslnegotiation=direct`)).toThrow(/needs TLS/);
    expect(() => pgConfigFromUrl(`${BASE}?sslmode=require&sslnegotiation=sideways`)).toThrow(
      /sslnegotiation=sideways/
    );
  });

  it('keeps the parameters pg itself reads', () => {
    const cs = pgConfigFromUrl(`${BASE}?application_name=app&connection_limit=3`).connectionString;
    expect(params(cs).get('application_name')).toBe('app');
  });

  it('no URL, or one that does not parse, is handed on unchanged', () => {
    expect(pgConfigFromUrl(undefined).connectionString).toBeUndefined();
    expect(pgConfigFromUrl('not a url').connectionString).toBe('not a url');
  });
});

describe('pgPoolConfig', () => {
  it('always keeps TCP alive (probing after 10 s) and lets an idle pool exit', () => {
    expect(pgPoolConfig(BASE)).toMatchObject({
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      allowExitOnIdle: true,
      max: 10,
    });
    expect(pgPoolConfig(BASE)).not.toHaveProperty('idleTimeoutMillis');
  });

  it('the pool waits pool_timeout; its connections connect within connect_timeout', () => {
    const config = pgPoolConfig(`${BASE}?connect_timeout=3&pool_timeout=20`);
    expect(config.connectionTimeoutMillis).toBe(20_000);
    expect(config.Client.connectTimeoutMillis).toBe(3_000);
    // The pool hands its own options to each Client; the subclass replaces the timeout.
    const client = new config.Client({ connectionString: BASE, connectionTimeoutMillis: 20_000 });
    expect(
      (client as unknown as { _connectionTimeoutMillis: number })._connectionTimeoutMillis
    ).toBe(3_000);
    expect(pgPoolConfig(BASE).Client.connectTimeoutMillis).toBe(5_000);
  });

  it("each connection listens for 'error' from the start (one before the adapter's never ends the process)", () => {
    const Client = clientWithConnectTimeout(1_000);
    const client = new Client({ connectionString: BASE });
    expect(client.listenerCount('error')).toBe(1);
    expect(() => client.emit('error', new Error('terminated during startup'))).not.toThrow();
  });

  /** A client exactly as pg-pool builds one: `new Client(pool.options)`. */
  const pooledClient = (url: string | undefined, options?: Parameters<typeof pgPoolConfig>[1]) => {
    const pool = new pg.Pool({ ...pgPoolConfig(url, options), password: 'from-config' });
    const Client = pool.options.Client as typeof pg.Client;
    return { pool, client: new Client(pool.options) as pg.Client & Record<string, unknown> };
  };

  it('a pooled client keeps listening after the first error (on, not once)', async () => {
    const { pool, client } = pooledClient(BASE);
    expect(() => client.emit('error', new Error('first'))).not.toThrow();
    expect(() => client.emit('error', new Error('second'))).not.toThrow();
    await pool.end();
  });

  it('a pooled client keeps TLS, keepalive and the hidden password through the subclass', async () => {
    // No password in the URL (one there would win over the config's).
    const { pool, client } = pooledClient(
      'postgresql://u@db.example.test:5432/app?sslmode=require'
    );
    expect(client.ssl).toEqual({ rejectUnauthorized: true });
    // The Connection is what calls setKeepAlive on the socket.
    const connection = client.connection as unknown as Record<string, unknown>;
    expect(connection._keepAlive).toBe(true);
    expect(connection._keepAliveInitialDelayMillis).toBe(10_000);
    await pool.end();
  });

  it("a pooled client keeps pg-pool's hidden password (a config without a URL)", async () => {
    // With a connection string, pg takes the password from the URL whatever
    // the config says; without one, the config's password is the one used.
    const { pool, client } = pooledClient(undefined);
    // pg-pool makes `password` non-enumerable; a spread would have lost it.
    expect(Object.keys(pool.options)).not.toContain('password');
    expect(client.password).toBe('from-config');
    await pool.end();
  });

  it.each([
    ['sslmode=require&ssl=0', { rejectUnauthorized: true }],
    ['ssl=0&sslmode=require', { rejectUnauthorized: true }],
    ['sslmode=disable&ssl=1', false],
    ['sslmode=no-verify&ssl=0', { rejectUnauthorized: false }],
  ])('%s: pg ends with the TLS the factory chose', (query, ssl) => {
    const config = pgPoolConfig(`${BASE}?${query}`);
    // What pg itself computes from the options plus the string it is handed.
    const parameters = new ConnectionParameters(config);
    expect(parameters.ssl).toEqual(ssl);
  });

  it("a dedicated client's own max wins over connection_limit", () => {
    expect(pgPoolConfig(`${BASE}?connection_limit=30`, { max: 1 }).max).toBe(1);
  });

  it('keepIdle never closes an idle connection', () => {
    expect(pgPoolConfig(BASE, { max: 1, keepIdle: true }).idleTimeoutMillis).toBe(0);
  });

  it('a query timeout only when asked for', () => {
    expect(pgPoolConfig(BASE)).not.toHaveProperty('query_timeout');
    expect(pgPoolConfig(BASE, { queryTimeoutMillis: 7_000 })).toMatchObject({
      query_timeout: 7_000,
    });
  });

  it('passes startup options, and refuses a URL whose options= would override them', () => {
    expect(pgPoolConfig(BASE, { options: '-c x=1' }).options).toBe('-c x=1');
    expect(() => pgPoolConfig(`${BASE}?options=-c%20x%3D2`, { options: '-c x=1' })).toThrow(
      /options=/
    );
  });
});

describe('the Client tags a failure while connecting', () => {
  /** A peer that answers the startup packet with `respond`, or never answers. */
  async function peer(respond?: (socket: Socket) => void) {
    const sockets: Socket[] = [];
    const server = createServer(socket => {
      sockets.push(socket);
      socket.on('error', () => {});
      if (respond) socket.once('data', () => respond(socket));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const url = `postgresql://u:p@127.0.0.1:${(server.address() as AddressInfo).port}/db`;
    const close = () => {
      for (const socket of sockets) socket.destroy();
      return new Promise(resolve => server.close(resolve));
    };
    return { url, close };
  }
  /** A Postgres ErrorResponse: what a server sends to refuse a session. */
  const errorResponse = (code: string, message: string) => {
    const fields = Buffer.from(`SFATAL\0VFATAL\0C${code}\0M${message}\0\0`);
    const length = Buffer.alloc(4);
    length.writeInt32BE(fields.length + 4);
    return Buffer.concat([Buffer.from('E'), length, fields]);
  };
  const clientFor = (url: string, connectTimeoutMillis = 2_000) => {
    const Client = clientWithConnectTimeout(connectTimeoutMillis);
    return new Client({ connectionString: url });
  };

  it.each([
    ['closes (FIN)', (s: Socket) => s.end()],
    ['resets (RST)', (s: Socket) => s.resetAndDestroy()],
  ])(
    'a peer that %s during startup: the promise form rejects with the tagged error',
    async (_label, respond) => {
      const { url, close } = await peer(respond);
      try {
        const failure = await clientFor(url)
          .connect()
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(CONNECT_FAILURE_MESSAGE);
        expect((failure as Error).cause).toBeInstanceOf(Error);
      } finally {
        await close();
      }
    }
  );

  it("pg-pool's callback form: called once, with the tagged error, and no unhandled rejection", async () => {
    const { url, close } = await peer(s => s.end());
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const calls: unknown[] = [];
      await new Promise<void>(resolve => {
        clientFor(url).connect((error: Error) => {
          calls.push(error);
          resolve();
        });
      });
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(calls).toHaveLength(1);
      expect((calls[0] as Error).message).toBe(CONNECT_FAILURE_MESSAGE);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await close();
    }
  });

  it.each([
    ['28P01', 'password authentication failed for user "u"'],
    ['3D000', 'database "db" does not exist'],
    ['57P03', 'the database system is starting up'],
  ])('a server error with a severity (%s) is left as it is', async (code, message) => {
    const { url, close } = await peer(s => s.end(errorResponse(code, message)));
    try {
      const failure = (await clientFor(url)
        .connect()
        .catch((error: unknown) => error)) as Error & { code?: string; severity?: string };
      expect(failure.message).toBe(message);
      expect(failure.code).toBe(code);
      expect(failure.severity).toBe('FATAL');
    } finally {
      await close();
    }
  });

  it("the client's own connect timer keeps its message (`timeout expired`)", async () => {
    const { url, close } = await peer(); // never answers
    try {
      const failure = await clientFor(url, 300)
        .connect()
        .catch((error: unknown) => error);
      expect((failure as Error).message).toBe('timeout expired');
    } finally {
      await close();
    }
  });
});
