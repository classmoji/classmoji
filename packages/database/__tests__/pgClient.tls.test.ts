/**
 * The factory owns the TLS decision: for every URL it accepts, what it decided
 * is what pg ends up using (read from pg's own Client, which does not connect),
 * and `channel_binding=require` is never accepted on a plaintext connection.
 * The combinations of sslmode, ssl, certificate files, uselibpqcompat,
 * sslnegotiation and channel_binding a review probed. Pure: no database.
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { pgPoolConfig } from '../pgClient.ts';

const B = 'postgresql://u:p@db.example.com:5432/db';
const CA = fileURLToPath(import.meta.url); // any readable file: pg reads it, nothing connects

const QUERIES = [
  'sslmode=require&channel_binding=require&connection_limit=30&pool_timeout=30&connect_timeout=15',
  '',
  'sslmode=require&ssl=0',
  'ssl=0&sslmode=require',
  'sslmode=disable&ssl=1',
  'ssl=1&sslmode=disable',
  'sslmode=no-verify&ssl=0',
  'ssl=0&channel_binding=require',
  'ssl=true',
  'ssl=false',
  'ssl=TRUE',
  'ssl=1',
  'ssl=0',
  'ssl=',
  'ssl=no-verify',
  'ssl=1&ssl=0',
  'ssl=0&ssl=1',
  'sslmode=require&sslmode=disable',
  'sslmode=disable&sslmode=require',
  'sslmode=REQUIRE&ssl=0',
  'SSLMODE=require',
  'SSL=1&channel_binding=require',
  `sslrootcert=${CA}`,
  `sslrootcert=${CA}&sslmode=require`,
  `sslrootcert=${CA}&sslmode=disable`,
  `sslrootcert=${CA}&ssl=0`,
  `sslrootcert=${CA}&sslmode=no-verify`,
  `sslrootcert=${CA}&channel_binding=require`,
  `sslcert=${CA}&sslkey=${CA}`,
  `sslcert=${CA}&sslkey=${CA}&ssl=0&channel_binding=require`,
  'uselibpqcompat=true',
  'uselibpqcompat=true&channel_binding=require',
  'uselibpqcompat=false&channel_binding=require',
  'uselibpqcompat=true&sslmode=require',
  'uselibpqcompat=true&sslmode=prefer&channel_binding=require',
  'uselibpqcompat=true&sslmode=disable&channel_binding=require',
  'uselibpqcompat=true&sslmode=no-verify',
  'sslnegotiation=direct',
  'sslnegotiation=direct&channel_binding=require',
  'sslmode=disable&sslnegotiation=direct',
  'sslmode=no-verify&sslnegotiation=direct',
  'sslmode=require&sslnegotiation=direct',
  'ssl=0&sslnegotiation=direct',
  'sslnegotiation=postgres&sslmode=require',
  'sslmode=allow&channel_binding=require',
  'sslmode=prefer',
  'sslmode=verify-ca',
  'sslmode=verify-full&channel_binding=prefer',
  'channel_binding=disable',
  'channel_binding=REQUIRE&ssl=1',
  'channel_binding=require&channel_binding=disable',
  'channel_binding=disable&channel_binding=require&sslmode=require',
  '%73slmode=require&ssl=0',
  'sslmode=require&%73sl=0',
  'ssl%6Dode=disable&ssl=1',
];

type FinalSsl = false | true | { rejectUnauthorized?: boolean } | undefined;

/** What pg's own Client settles on for this pool config (nothing connects). */
function pgFinalSsl(url: string): FinalSsl {
  const { Client: _client, ...options } = pgPoolConfig(url);
  const client = new pg.Client(options as pg.ClientConfig);
  return (client as unknown as { connectionParameters: { ssl: FinalSsl } }).connectionParameters
    .ssl;
}
const on = (ssl: FinalSsl) => Boolean(ssl);
const verified = (ssl: FinalSsl) =>
  on(ssl) && (ssl === true || (typeof ssl === 'object' && ssl.rejectUnauthorized !== false));

describe('the factory owns the TLS decision', () => {
  it('covers the 55 combinations', () => {
    expect(QUERIES).toHaveLength(55);
  });

  it.each(QUERIES.map(q => [q.replaceAll(CA, '<ca>') || '(no parameters)', q]))(
    '%s: refused at boot, or pg uses exactly the TLS the factory chose',
    (_label, query) => {
      const url = query ? `${B}?${query}` : B;
      let config: ReturnType<typeof pgPoolConfig>;
      try {
        config = pgPoolConfig(url);
      } catch (error) {
        // Refused at boot: a value with no meaning, or TLS asked for and absent.
        expect((error as Error).message).toMatch(/\[database\]/);
        return;
      }
      const final = pgFinalSsl(url);
      if (config.ssl !== undefined) {
        expect(on(final), 'TLS on/off').toBe(on(config.ssl));
        expect(verified(final), 'verification').toBe(verified(config.ssl));
      }
      // Binding asked for is never accepted without TLS.
      if (
        config.enableChannelBinding &&
        /channel_binding=require(?!.*channel_binding=)/i.test(query)
      ) {
        expect(on(final), 'channel_binding=require over TLS').toBe(true);
      }
    }
  );

  it('never says TLS where pg would connect in plaintext', () => {
    const plaintextAgainstIntent = QUERIES.filter(query => {
      try {
        const config = pgPoolConfig(`${B}?${query}`);
        return Boolean(config.ssl) && !on(pgFinalSsl(`${B}?${query}`));
      } catch {
        return false;
      }
    });
    expect(plaintextAgainstIntent).toEqual([]);
  });

  it('the factory decides wherever no certificate file hands it to pg', () => {
    const undecided = QUERIES.filter(query => {
      if (/ssl(?:rootcert|cert|key)=/.test(query)) return false;
      if (!/ssl(?:mode)?=|%73sl|ssl%6Dode/i.test(query)) return false;
      try {
        return pgPoolConfig(`${B}?${query}`).ssl === undefined;
      } catch {
        return false;
      }
    });
    // Upper-case keys (SSLMODE=, SSL=) are not TLS parameters to pg either.
    expect(undecided.filter(q => !/^SSL|&SSL/.test(q))).toEqual([]);
  });
});
