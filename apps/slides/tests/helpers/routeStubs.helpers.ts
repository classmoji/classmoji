import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { importWithStubs, stubModule } from './dataRequest.helpers.ts';

/**
 * Run a route module's real action with every import it makes replaced by a
 * recording stub, except the ones named in `keep`.
 *
 * Each stubbed import is a "deep stub": any property chain on it is a function
 * that records its call (`calls`) and returns what `returns` holds for that
 * call path (`'getPrisma().slide.findUnique'`, `'ContentService.put'`,
 * `'assertSlideAccess'`), or another deep stub. A path names the import as the
 * route spells it (a default import by its local name), then each property,
 * with `()` after a call. A value in `returns` that is a function is called
 * with the arguments; anything else is returned as is.
 *
 * So a test can tell whether the route reached a write (`ContentService.*`,
 * `getPrisma().slide.update`) without Postgres, a content repository or a
 * session: what the route did is in `calls`.
 */
export interface RouteStubs {
  calls: Array<{ path: string; args: unknown[] }>;
  returns: Record<string, unknown>;
}

const state = (): RouteStubs =>
  ((globalThis as unknown as { __routeStubs?: RouteStubs }).__routeStubs ??= {
    calls: [],
    returns: {},
  });

/** Reset what the stubs recorded and what they return. */
export const resetRouteStubs = (returns: Record<string, unknown> = {}): RouteStubs => {
  const s = state();
  s.calls.length = 0;
  s.returns = returns;
  return s;
};

/** The recorded calls whose path starts with one of `prefixes`. */
export const callsTo = (...prefixes: string[]) =>
  state().calls.filter(call => prefixes.some(prefix => call.path.startsWith(prefix)));

const DEEP_STUB = `
const s = (globalThis.__routeStubs ??= { calls: [], returns: {} });
export const make = path =>
  new Proxy(function () {}, {
    get(_t, key) {
      if (key === Symbol.toPrimitive) return hint => (hint === 'number' ? 0 : '');
      if (typeof key === 'symbol' || key === 'then') return undefined;
      return make(path + '.' + key);
    },
    apply(_t, _this, args) {
      s.calls.push({ path, args });
      const r = s.returns[path];
      if (typeof r === 'function') return r(...args);
      if (r !== undefined) return r;
      return make(path + '()');
    },
    construct(_t, args) {
      s.calls.push({ path: 'new ' + path, args });
      return make('new ' + path);
    },
  });
`;
const deepStubUrl = stubModule(DEEP_STUB);

/** The names a module's import statements bind, per specifier. */
function importsOf(source: string): Map<string, { defaultName?: string; named: Set<string> }> {
  const out = new Map<string, { defaultName?: string; named: Set<string> }>();
  const re = /^import\s+(?!type\s)([\s\S]*?)\s+from\s+'([^']+)';/gm;
  for (const match of source.matchAll(re)) {
    const [, clause, specifier] = match;
    const entry = out.get(specifier) ?? { named: new Set<string>() };
    const braces = clause.match(/\{([\s\S]*)\}/);
    const outside = clause
      .replace(/\{[\s\S]*\}/, '')
      .replace(/,/g, ' ')
      .trim();
    if (outside && !outside.startsWith('*')) entry.defaultName = outside.split(/\s+/)[0];
    const namespace = clause.match(/\*\s+as\s+(\w+)/);
    if (namespace) entry.defaultName = entry.defaultName ?? namespace[1];
    if (braces) {
      for (const part of braces[1].split(',')) {
        const name = part.trim().replace(/^type\s+/, '');
        if (!name || part.trim().startsWith('type ')) continue;
        entry.named.add(name.split(/\s+as\s+/)[0].trim());
      }
    }
    out.set(specifier, entry);
  }
  return out;
}

/**
 * Import `moduleUrl` with every import stubbed (see above) except the
 * specifiers in `keep`, which load for real.
 */
export async function importRouteWithStubs<T>(moduleUrl: URL, keep: string[] = []): Promise<T> {
  const source = readFileSync(fileURLToPath(moduleUrl), 'utf8');
  const stubs: Record<string, string> = { '.css': stubModule('export default {};') };
  for (const [specifier, { defaultName, named }] of importsOf(source)) {
    if (keep.includes(specifier)) continue;
    const lines = [`import { make } from ${JSON.stringify(deepStubUrl)};`];
    if (defaultName) lines.push(`export default make('${defaultName}');`);
    for (const name of named) lines.push(`export const ${name} = make('${name}');`);
    stubs[specifier] = stubModule(lines.join('\n'));
  }
  // Its own instance: another spec in this worker may hold the module stubbed
  // differently under `importWithStubs`' own marker.
  return importWithStubs<T>(new URL(`${moduleUrl.href}?routestubs`), stubs);
}
