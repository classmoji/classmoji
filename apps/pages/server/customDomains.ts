/**
 * The custom-domain routing snapshot.
 *
 * A PRO instructor may point a hostname they own at their class site. The
 * request arrives with that hostname in `Host:` and nothing else — no
 * subdomain, no path prefix — so something has to turn `cs52.me` into the
 * tenant `cs52` before `server/siteHost.ts` can rewrite it onto
 * `/_site/cs52/...`. This module is that something.
 *
 * ## Why a whole-table snapshot and not a cache
 *
 * `Host` need not match SNI: anyone who completes a TLS handshake against any
 * valid hostname on this app may then send unlimited distinct `Host:` headers
 * down that same connection. A per-request lookup — even an LRU-backed one with
 * negative caching — therefore hands an unauthenticated caller one database
 * round trip per request on a path that today does zero I/O before routing. A
 * fixed-size LRU cannot negative-cache an unbounded key space; that is what it
 * means for the space to be unbounded.
 *
 * The other direction is what makes the fix cheap: `custom_domain` holds TENS
 * of rows, not millions. So the whole mapping fits in a `Map`, refreshed on a
 * timer, and a garbage `Host` costs one hash lookup and no I/O at all.
 *
 * ## What this map is, and what it is not
 *
 * It is a ROUTING HINT: it gets a request onto the right tenant subtree. Every
 * decision that matters — is this classroom still PRO, is the site enabled, has
 * the domain been re-pointed since this snapshot was taken — is made by
 * `getSiteByCustomDomain` inside the request, against the database. That second
 * read is not belt-and-braces; it is the only thing standing between a
 * re-pointed domain and up to `refreshMs` of serving the PREVIOUS classroom's
 * content. Propagation is per-machine either way: each Fly machine holds its
 * own copy and refreshes on its own schedule.
 *
 * Deliberately absent from the map: whether the site is currently servable.
 * Routing must reach the loader even for a lapsed or disabled domain — that
 * request needs a 302 to the canonical subdomain or a branded 404, and dropping
 * it here would flatten both into an edge 404. A map used only for routing has
 * no use for a field routing must ignore, and carrying one would be a third
 * copy of the PRO rule waiting to drift.
 *
 * ## Why its own Prisma client
 *
 * This file is loaded by bare node (`--experimental-strip-types`) in the
 * express layer, while the React Router app is a separate Vite bundle that
 * inlines `@classmoji/database` — verified against `build/server/index.js`.
 * Importing that package here would construct a SECOND extended client and, far
 * worse, install a second set of SIGINT/SIGTERM/uncaughtException handlers, two
 * process-exiting shutdown paths racing each other. So this talks to
 * `@prisma/client` directly, with a deliberately tiny connection pool: it runs
 * one narrow query per refresh interval and has no business holding the default
 * pool's worth of connections.
 */

/** custom hostname → tenant subdomain. */
export type CustomDomainMap = ReadonlyMap<string, string>;

export type CustomDomainSnapshot = {
  /** Synchronous lookup for `classifyHost`. Null when nobody claims the host. */
  resolve: (host: string) => string | null;
  /**
   * Re-read the table now. Never rejects; a failure keeps the last good map.
   *
   * This is the refresh-on-write hook, and its reach is honest about being
   * IN-PROCESS ONLY: `setCustomDomain` runs in the webapp, which is a different
   * process (and, in production, a different Fly app) from every pages machine,
   * so a claim made there cannot poke this. Cross-process propagation is the
   * timer, bounded by `refreshMs`. The hook exists for anything that writes
   * inside this process, and for tests.
   */
  refresh: () => Promise<void>;
  /** Stop the timer (tests, graceful shutdown). */
  stop: () => void;
  /** How many hostnames the current map holds — for logging and tests. */
  size: () => number;
};

export type CustomDomainSnapshotOptions = {
  /** Refresh cadence. 45s: a new claim goes live within a minute. */
  refreshMs?: number;
  /**
   * Load the map. Injected so the unit tests never touch a database — the
   * refresh/fail-closed behaviour is the part worth testing, and it is
   * independent of where the rows come from.
   */
  load?: () => Promise<Iterable<readonly [string, string]>>;
};

const DEFAULT_REFRESH_MS = 45_000;

/**
 * Read every claimed hostname straight from Postgres.
 *
 * Lazy on first call, and every failure mode is a degrade rather than a throw:
 * no DATABASE_URL, an unreachable database or a missing table all leave the
 * snapshot on its last good map (empty, at boot), which means custom domains
 * 404 while canonical and subdomain traffic is completely unaffected.
 */
function createDefaultLoader(): () => Promise<Array<readonly [string, string]>> {
  // Structurally typed to the ONE query this makes, rather than to
  // `PrismaClient`. That type comes from the generated client, which this file
  // deliberately does not depend on the shape of — and naming it here would
  // also mean importing `@prisma/client` eagerly, which is exactly what the
  // dynamic import below avoids.
  type RoutingClient = {
    classroomSite: {
      findMany: (
        args: unknown
      ) => Promise<Array<{ custom_domain: string | null; subdomain: string }>>;
    };
  };

  let clientPromise: Promise<RoutingClient | null> | null = null;

  const getClient = () => {
    if (!clientPromise) {
      clientPromise = (async (): Promise<RoutingClient | null> => {
        const url = (process.env.DATABASE_URL || '').trim();
        if (!url) return null;

        // A pool of two, not the default `num_cpus * 2 + 1`. One query every 45
        // seconds does not need connections, and this process already has the
        // app's own client alongside it.
        let datasourceUrl = url;
        try {
          const parsed = new URL(url);
          parsed.searchParams.set('connection_limit', '2');
          datasourceUrl = parsed.toString();
        } catch {
          // Prisma accepts shapes `new URL` does not; hand it the original
          // rather than refusing to route custom domains over a parse nit.
        }

        const { PrismaClient } = await import('@prisma/client');
        return new PrismaClient({ datasourceUrl }) as unknown as RoutingClient;
      })().catch(error => {
        console.error('[customDomains] could not initialize the routing database client', error);
        return null;
      });
    }
    return clientPromise;
  };

  return async () => {
    const client = await getClient();
    if (!client) return [];

    const rows = await client.classroomSite.findMany({
      where: { custom_domain: { not: null } },
      select: { custom_domain: true, subdomain: true },
    });

    return rows.flatMap(row =>
      row.custom_domain ? [[row.custom_domain, row.subdomain] as const] : []
    );
  };
}

/**
 * Build the snapshot and start refreshing it.
 *
 * The first refresh is kicked off immediately but NOT awaited — the server must
 * come up whether or not the database is reachable, and a `/health` probe that
 * waits on Postgres is a probe that reports the wrong thing. Custom domains
 * resolve as soon as that first load lands, typically within a second of boot.
 */
export function createCustomDomainSnapshot(
  options: CustomDomainSnapshotOptions = {}
): CustomDomainSnapshot {
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  const load = options.load ?? createDefaultLoader();

  // Starts empty, so an unclaimed hostname is refused until the first load
  // lands. Failing closed at boot is the right direction: the cost is a brief
  // 404 on a custom domain, and the alternative — serving on a map we have not
  // loaded — cannot happen at all.
  let map: Map<string, string> = new Map();
  let inFlight: Promise<void> | null = null;

  const refresh = async (): Promise<void> => {
    // Collapse concurrent refreshes. Nothing calls this in a tight loop today,
    // but a refresh-on-write poke plus the timer can coincide, and two
    // simultaneous full-table reads to install the same map is waste.
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const next = new Map<string, string>();
        for (const [domain, subdomain] of await load()) {
          // Normalize on the way IN, so the request path stays a bare lookup:
          // the Host header is already lowercased and dot-stripped by
          // `parseHostHeader`, and the two forms have to meet somewhere.
          const key = String(domain).trim().toLowerCase();
          if (key) next.set(key, subdomain);
        }
        map = next;
      } catch (error: unknown) {
        // FAIL CLOSED to the last good map. A database blip must not
        // un-route every custom domain at once — that would take every
        // instructor's site offline for a transient error the site itself
        // never depended on.
        console.error('[customDomains] refresh failed; keeping the previous map', error);
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  };

  void refresh();

  const timer = setInterval(() => {
    void refresh();
  }, refreshMs);
  // Never hold the process open for a routing cache.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    resolve: (host: string) => map.get(host) ?? null,
    refresh,
    stop: () => clearInterval(timer),
    size: () => map.size,
  };
}
