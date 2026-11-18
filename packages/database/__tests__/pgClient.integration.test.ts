/**
 * The pg-adapter client factory (pgClient.ts) on a real database: the URL's
 * pool settings are honoured, an exhausted pool and a connect that never
 * answers fail on time with errors the retry and 503 rules recognise, a
 * session the server ends is replaced without crashing the process, and a
 * single-session client really is one session.
 *
 * The real-database part is skipped unless DATABASE_URL names a LOCAL,
 * non-shared database; the blackholed connect needs none.
 */
import { spawnSync } from 'node:child_process';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@classmoji/database/client';
import { createPgPrismaClient, type PgClientOptions } from '../pgClient.ts';
import { isTransientDatabaseError } from '../../tasks/src/helpers/databaseRetry.ts';
import { isTokenStoreUnavailable } from '../../../apps/mcp/src/auth/tokenStoreErrors.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const withParams = (query: string) =>
  `${DATABASE_URL}${DATABASE_URL.includes('?') ? '&' : '?'}${query}`;

const CONCURRENT = 8;
const pidAndNap = (client: PrismaClient) =>
  client.$queryRaw<
    { pid: number }[]
  >`SELECT pg_backend_pid() AS pid, pg_sleep(0.05)::text AS slept`;
async function backendPids(client: PrismaClient): Promise<Set<number>> {
  const rows = await Promise.all(Array.from({ length: CONCURRENT }, () => pidAndNap(client)));
  return new Set(rows.map(([row]) => row.pid));
}

/** Poll `read` until `done` holds (the pool drops a dead connection when the server's notice lands). */
async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms = 5_000
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined && done(value)) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/**
 * A child process that runs one `$transaction` through a proxy which ends the
 * first session with FATAL 57P01 in the same packet as its startup
 * ReadyForQuery (a backend terminated just as it finished starting). `plain`
 * builds the adapter without the factory's Client subclass: the control.
 */
const startupFatalScript = (databaseUrl: string, mode: 'factory' | 'plain') => `
import net from 'node:net';
import { PrismaClient } from '@classmoji/database/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createPgPrismaClient } from './packages/database/pgClient.ts';
const upstreamUrl = new URL(${JSON.stringify(databaseUrl)});
const fatal = (() => {
  const fields = Buffer.concat([Buffer.from('SFATAL\\0VFATAL\\0C57P01\\0Mterminating connection due to administrator command\\0\\0')]);
  const len = Buffer.alloc(4); len.writeInt32BE(fields.length + 4);
  return Buffer.concat([Buffer.from('E'), len, fields]);
})();
let injected = false;
const proxy = net.createServer(client => {
  const upstream = net.connect(Number(upstreamUrl.port), upstreamUrl.hostname);
  let first = !injected;
  client.on('data', d => upstream.write(d));
  upstream.on('data', d => {
    const i = first ? d.indexOf(Buffer.from([0x5a, 0, 0, 0, 5])) : -1;
    if (i >= 0) {
      first = false; injected = true;
      client.end(Buffer.concat([d.subarray(0, i + 6), fatal]));
      upstream.destroy();
      return;
    }
    client.write(d);
  });
  for (const s of [client, upstream]) s.on('error', () => {});
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
});
await new Promise(r => proxy.listen(0, '127.0.0.1', r));
const url = new URL(upstreamUrl); url.hostname = '127.0.0.1'; url.port = String(proxy.address().port);
const prisma = ${JSON.stringify(mode)} === 'factory'
  ? createPgPrismaClient(url.toString(), { max: 2 })
  : new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString(), max: 2 }) });
const outcome = await prisma.$transaction(async tx => tx.$queryRaw\`SELECT 1 AS one\`).then(() => 'ok', e => 'rejected: ' + e.message.split('\\n').filter(Boolean).pop());
await new Promise(r => setTimeout(r, 200));
console.log('injected', injected, outcome, 'then', JSON.stringify(await prisma.$queryRaw\`SELECT 2 AS two\`));
await prisma.$disconnect();
proxy.close();
`;

describe.skipIf(!RUN)('createPgPrismaClient (real database)', () => {
  const clients: PrismaClient[] = [];
  const open = (url: string, options?: PgClientOptions) => {
    const client = createPgPrismaClient(url, options);
    clients.push(client);
    return client;
  };
  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.$disconnect().catch(() => {})));
  });

  it('honours connection_limit from the URL', async () => {
    const pids = await backendPids(open(withParams('connection_limit=2')));
    expect(pids.size).toBeGreaterThanOrEqual(1);
    expect(pids.size).toBeLessThanOrEqual(2);
    expect((await backendPids(open(withParams('connection_limit=4')))).size).toBeGreaterThan(2);
  });

  it('an exhausted pool fails after pool_timeout, with an error both rules recognise', async () => {
    const client = open(withParams('connection_limit=1&pool_timeout=2&connect_timeout=1'));
    const holder = client.$queryRaw`SELECT pg_sleep(4)::text AS slept`.then(
      () => 'done',
      () => 'failed'
    );
    await new Promise(resolve => setTimeout(resolve, 300));
    const started = Date.now();
    const failure = await client.$queryRaw`SELECT 1 AS one`.catch((error: unknown) => error);
    const waited = Date.now() - started;
    expect(failure).toBeInstanceOf(Error);
    expect(waited).toBeGreaterThanOrEqual(1_500);
    expect(waited).toBeLessThan(3_500);
    expect(isTransientDatabaseError(failure), 'retry rule').toBe(true);
    expect(isTokenStoreUnavailable(failure), 'MCP 503 rule').toBe(true);
    expect(await holder).toBe('done');
  }, 15_000);

  it('a session the server ended is replaced, and the process does not crash', async () => {
    const client = open(DATABASE_URL, { max: 1 });
    const killer = open(DATABASE_URL, { max: 1 });
    const pid = async () =>
      (await client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
    const before = await pid();
    await killer.$executeRawUnsafe(`SELECT pg_terminate_backend(${Number(before)})`);
    // The pool drops the dead idle connection when the server's notice
    // arrives (its 'error' listener; without one Node would crash here).
    expect(await until(pid, after => after !== before)).not.toBe(before);
  });

  it('a session the server ends as it opens never crashes the process (the Client listens from the start)', () => {
    const run = (mode: 'factory' | 'plain') =>
      spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--no-warnings',
          '--input-type=module',
          '-e',
          startupFatalScript(DATABASE_URL, mode),
        ],
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 }
      );
    // The control: without the factory's Client, the same packet ends the process.
    const plain = run('plain');
    expect(plain.status, plain.stdout).not.toBe(0);
    expect(plain.stderr).toMatch(/Unhandled 'error' event|terminating connection/);
    // Through the factory: the transaction fails or succeeds, and the client goes on.
    const factory = run('factory');
    expect(factory.stderr).not.toMatch(/Unhandled 'error' event/);
    expect(factory.status, factory.stderr).toBe(0);
    expect(factory.stdout).toMatch(/^injected true /);
    expect(factory.stdout).toContain('then [{"two":2}]');
  }, 70_000);

  it('{ max: 1, keepIdle } is ONE session: concurrent queries, a session setting, an 11 s idle pause', async () => {
    const client = open(DATABASE_URL, { max: 1, keepIdle: true });
    expect((await backendPids(client)).size).toBe(1);
    await client.$executeRawUnsafe('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    const pid = async () =>
      (
        await client.$queryRawUnsafe<{ pid: number; ro: string }[]>(
          "SELECT pg_backend_pid() AS pid, current_setting('transaction_read_only') AS ro"
        )
      )[0];
    const before = await pid();
    expect(before.ro).toBe('on');
    // pg closes an idle connection after 10 s by default; keepIdle must not.
    await new Promise(resolve => setTimeout(resolve, 11_000));
    expect(await pid()).toEqual(before);
  }, 25_000);

  it('a startup option holds for every session, replacements included', async () => {
    const client = open(DATABASE_URL, {
      max: 1,
      keepIdle: true,
      options: '-c default_transaction_read_only=on',
    });
    const killer = open(DATABASE_URL, { max: 1 });
    const read = async () =>
      (
        await client.$queryRawUnsafe<{ pid: number; ro: string }[]>(
          "SELECT pg_backend_pid() AS pid, current_setting('transaction_read_only') AS ro"
        )
      )[0];
    const before = await read();
    expect(before.ro).toBe('on');
    await killer.$executeRawUnsafe(`SELECT pg_terminate_backend(${Number(before.pid)})`);
    const after = await until(read, row => row.pid !== before.pid);
    expect(after.pid).not.toBe(before.pid);
    expect(after.ro).toBe('on');
  });

  it('lets Node exit with an idle pool and no $disconnect (allowExitOnIdle)', () => {
    const script = [
      "import { createPgPrismaClient } from './packages/database/pgClient.ts';",
      `const c = createPgPrismaClient(${JSON.stringify(DATABASE_URL)});`,
      'await c.$queryRaw`SELECT 1`;',
      "console.log('queried, not disconnecting');",
    ].join('\n');
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 20_000 }
    );
    expect(result.error, 'the process did not exit by itself').toBeUndefined();
    expect(result.stdout).toContain('queried, not disconnecting');
    expect(result.status).toBe(0);
  }, 30_000);
});

describe('createPgPrismaClient: a connect that never answers', () => {
  let server: Server | undefined;
  const sockets: Socket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
    server = undefined;
  });

  // A peer that accepts the TCP connection and never says a word.
  const blackhole = async () => {
    server = createServer(socket => sockets.push(socket));
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    return (server.address() as AddressInfo).port;
  };
  const timed = async (url: string) => {
    const client = createPgPrismaClient(url);
    const started = Date.now();
    try {
      const failure = await client.$queryRaw`SELECT 1`.catch((error: unknown) => error);
      return { failure, elapsed: Date.now() - started };
    } finally {
      await client.$disconnect().catch(() => {});
    }
  };

  it('gives up after connect_timeout, not the longer pool wait, with an error both rules recognise', async () => {
    const port = await blackhole();
    const { failure, elapsed } = await timed(
      `postgresql://u:p@127.0.0.1:${port}/db?connect_timeout=1&pool_timeout=10`
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('timeout expired');
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(3_000);
    expect(isTransientDatabaseError(failure), 'retry rule').toBe(true);
    expect(isTokenStoreUnavailable(failure), 'MCP 503 rule').toBe(true);
  }, 15_000);

  it('with no parameters a connect gives up after 5 s (the default), not 10', async () => {
    const port = await blackhole();
    const { failure, elapsed } = await timed(`postgresql://u:p@127.0.0.1:${port}/db`);
    expect((failure as Error).message).toBe('timeout expired');
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(7_500);
  }, 20_000);

  it('connect_timeout=0 turns off only the connect timer; pg-pool still bounds a new connection by its wait', async () => {
    const port = await blackhole();
    const { failure, elapsed } = await timed(
      `postgresql://u:p@127.0.0.1:${port}/db?connect_timeout=0&pool_timeout=2`
    );
    expect((failure as Error).message).toBe('Connection terminated due to connection timeout');
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(4_000);
    expect(isTransientDatabaseError(failure), 'retry rule').toBe(true);
  }, 15_000);
});
