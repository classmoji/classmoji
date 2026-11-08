/**
 * The transport the CIMD plugin fetches Client ID Metadata Documents with
 * (`@better-auth/cimd/node`, set in ../server.ts): it resolves the host
 * once, requires every address to be public, and pins the connection to
 * the address it checked.
 *
 * Here, in production mode, it is given loopback, private, link-local and
 * shared-space hosts, as literals and as a public-looking name whose DNS
 * answer is one of them, and a plain http URL. A TCP server on 127.0.0.1
 * counts the connections it gets: none. The transport has no setting that
 * allows a loopback host, so a document can't be served to it from this
 * machine; the real-database suite (oauth2.integration) swaps the transport
 * to serve one, and checks the server's own transport refuses there too.
 */

import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createServer, type Server } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// eslint's resolver misses this subpath export; TypeScript resolves it.
// eslint-disable-next-line import/no-unresolved
import { fetchClientMetadataResource } from '@better-auth/cimd/node';

const dns = createRequire(import.meta.url)('node:dns') as typeof import('node:dns');

/** Answers `hostname` with `addresses` (every other name as before) until restored. */
function answering(hostname: string, addresses: LookupAddress[]) {
  const original = dns.promises.lookup;
  const asked: string[] = [];
  dns.promises.lookup = (async (name: string, options: unknown) => {
    asked.push(name);
    return name === hostname ? addresses : original(name, options as never);
  }) as typeof dns.promises.lookup;
  syncBuiltinESMExports();
  return {
    asked,
    restore() {
      dns.promises.lookup = original;
      syncBuiltinESMExports();
    },
  };
}

describe('the CIMD metadata transport', () => {
  let server: Server;
  let port: number;
  let connections = 0;

  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    server = createServer(socket => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise(resolve => server.close(resolve));
  });

  const NOT_PUBLIC = /must resolve only to public-routable addresses/;
  it.each([
    ['127.0.0.1:PORT', 'loopback', NOT_PUBLIC],
    // The lookup is given the bracketed name, which resolves to nothing.
    ['[::1]:PORT', 'loopback (IPv6)', /ENOTFOUND/],
    ['localhost:PORT', 'the name localhost', NOT_PUBLIC],
    ['10.1.2.3', 'private', NOT_PUBLIC],
    ['192.168.0.10', 'private', NOT_PUBLIC],
    ['169.254.169.254', 'link-local (cloud metadata)', NOT_PUBLIC],
    ['100.64.0.1', 'shared address space', NOT_PUBLIC],
  ])('refuses %s (%s) without connecting', async (host, _kind, reason) => {
    const url = `https://${host.replace('PORT', String(port))}/oauth/client.json`;
    await expect(fetchClientMetadataResource(url)).rejects.toThrow(reason);
    expect(connections).toBe(0);
  });

  it.each([
    [[{ address: '127.0.0.1', family: 4 }]],
    [[{ address: '10.0.0.7', family: 4 }]],
    [[{ address: '::1', family: 6 }]],
    [
      [
        { address: '93.184.215.14', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    ],
  ])('refuses a public-looking name answered with %j, without connecting', async addresses => {
    const dnsAnswer = answering('cimd-client.example.org', addresses as LookupAddress[]);
    try {
      await expect(
        fetchClientMetadataResource(`https://cimd-client.example.org:${port}/oauth/client.json`)
      ).rejects.toThrow(/must resolve only to public-routable addresses/);
    } finally {
      dnsAnswer.restore();
    }
    expect(dnsAnswer.asked).toEqual(['cimd-client.example.org']);
    expect(connections).toBe(0);
  });

  it('refuses plain http', async () => {
    await expect(
      fetchClientMetadataResource(`http://127.0.0.1:${port}/oauth/client.json`)
    ).rejects.toThrow(/requires an HTTPS URL/);
    expect(connections).toBe(0);
  });
});
