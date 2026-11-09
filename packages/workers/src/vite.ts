/**
 * Vite plugin for Cloudflare Workers builds of classmoji's React Router apps:
 * in the Worker's environment (`ssr`), swap modules that can't run on workerd
 * for ones that can. The client environment, and every non-Workers build, are
 * untouched (the plugin is only added when BUILD_TARGET=cloudflare).
 *
 * Swaps:
 * - `@prisma/client` → `@classmoji/database/worker-client`, the client
 *   schema.prisma's `workerClient` generator emits (no engine binary; a driver
 *   adapter per request). Run `npm run db:generate` first.
 * - `@better-auth/cimd/node` → `@classmoji/auth/cimd-worker`, a fetch()
 *   transport with the same contract (the Node one loads node:dns/https/net).
 *
 * Stubs: modules an app imports but never calls on Workers can be replaced by
 * a stand-in whose every function throws `[workers] <name> is not available
 * on Workers`, so a route that does reach one fails loudly. Name the
 * module's named imports in `exports` (ESM needs them statically).
 */
import type { Plugin } from 'vite';

export const WORKER_SWAPS: Readonly<Record<string, string>> = {
  '@prisma/client': '@classmoji/database/worker-client',
  '@better-auth/cimd/node': '@classmoji/auth/cimd-worker',
};

export interface WorkerStub {
  /** The module specifier to replace, exactly as imported. */
  id: string;
  /** Named exports importers use; each throws when called. */
  exports?: string[];
}

export interface ClassmojiWorkerSwapsOptions {
  /** Modules to replace with throwing stand-ins (see above). */
  stubs?: Array<string | WorkerStub>;
  /** The Vite environment the Worker is built in. Default `ssr`. */
  environment?: string;
}

const STUB_PREFIX = '\0classmoji-worker-stub:';
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Source of the stand-in for `id`: a default export and the named ones. */
export function stubModuleSource(id: string, exportNames: string[] = []): string {
  for (const name of exportNames) {
    if (!IDENTIFIER.test(name) || name === 'default') {
      throw new Error(`[workers] stub ${id}: "${name}" is not a valid export name`);
    }
  }
  const message = JSON.stringify(`[workers] ${id} is not available on Workers`);
  return [
    `const fail = () => { throw new Error(${message}); };`,
    'const stub = new Proxy(function () {}, {',
    "  get: (_t, prop) => (prop === '__esModule' ? true : prop === 'then' ? undefined : fail),",
    '  apply: fail,',
    '  construct: fail,',
    '});',
    'export default stub;',
    ...exportNames.map(name => `export const ${name} = fail;`),
    '',
  ].join('\n');
}

export function classmojiWorkerSwaps(options: ClassmojiWorkerSwapsOptions = {}): Plugin {
  const environment = options.environment ?? 'ssr';
  const stubs = new Map<string, string[]>();
  for (const stub of options.stubs ?? []) {
    const { id, exports = [] } = typeof stub === 'string' ? { id: stub } : stub;
    stubModuleSource(id, exports); // validates the names up front
    stubs.set(id, exports);
  }
  let root = process.cwd();

  return {
    name: 'classmoji-worker-swaps',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
    },
    async resolveId(source, importer, resolveOptions) {
      if (this.environment?.name !== environment) return null;
      const target = WORKER_SWAPS[source];
      if (target) {
        // Resolve from the app (the importer may sit anywhere in the tree).
        const resolved = await this.resolve(target, importer ?? `${root}/index.html`, {
          ...resolveOptions,
          skipSelf: true,
        });
        if (!resolved) {
          this.error(
            `[workers] cannot resolve ${target} (swapped in for ${source}).` +
              (source === '@prisma/client'
                ? ' Generate the Workers Prisma client first: npm run db:generate.'
                : '')
          );
        }
        return resolved;
      }
      if (stubs.has(source)) return `${STUB_PREFIX}${source}`;
      return null;
    },
    load(id) {
      if (!id.startsWith(STUB_PREFIX)) return null;
      const source = id.slice(STUB_PREFIX.length);
      return stubModuleSource(source, stubs.get(source));
    },
  };
}
