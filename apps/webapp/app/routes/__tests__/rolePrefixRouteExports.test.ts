/**
 * Coverage for the /teacher and /assistant route trees' re-exports.
 *
 * Almost every route under these prefixes is a one-line re-export of an
 * existing admin or student route. That makes them cheap to add and invisible
 * when they break: dropping `action` from one of these lines removes the
 * route's entire mutation surface, and nothing fails — the page still renders,
 * forms just silently do nothing (React Router matches a route with no action
 * and has nowhere to post). The whole unit suite stayed green through exactly
 * that.
 *
 * So the property pinned here is a relationship, not a hardcoded list: a
 * prefixed route must re-export `action` IF AND ONLY IF the route it
 * re-exports from has one. That way adding an action to a shared source route
 * cannot quietly leave a prefix behind, and removing one cannot leave a
 * dangling re-export.
 *
 * Both trees are checked, each with its OWN exemption table: they serve
 * different roles and withhold different surfaces, so a shared list would let
 * one prefix's deliberate omission excuse the other's accident.
 *
 * Deliberate exceptions are named in INTENTIONALLY_NO_ACTION with the reason.
 *
 * Read as SOURCE TEXT rather than by importing the modules: these files pull in
 * antd, icons and the whole component tree, and the question here is only which
 * names cross the boundary.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROUTES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Routes that deliberately expose NO action, per prefix, and why.
 *
 * These are read-only under their prefix on purpose — the underlying route has
 * an action, and not re-exporting it is how that surface is withheld.
 */
const INTENTIONALLY_NO_ACTION: Record<string, Record<string, string>> = {
  teacher: {
    'teacher.$class_.students':
      'roster mutation (add/remove students) stays on the owner-only /admin route',
    'teacher.$class_.staff':
      'staff mutation (add/update/remove teaching staff) stays on the owner-only /admin route',
  },
  assistant: {
    'assistant.$class_.students':
      'roster mutation (add/remove students) stays on the owner-only /admin route',
    'assistant.$class_.staff':
      'staff mutation (add/update/remove teaching staff) stays on the owner-only /admin route',
  },
};

/**
 * How many routes each tree must have, so a bad glob cannot pass by finding
 * nothing. Floors, not exact counts — the /assistant tree carries more routes
 * with implementations of their own, so it has proportionally fewer
 * re-exports than /teacher.
 */
const MINIMUM_ROUTES: Record<string, { total: number; reExports: number }> = {
  teacher: { total: 20, reExports: 18 },
  assistant: { total: 18, reExports: 12 },
};

interface PrefixedRoute {
  /** Route id, e.g. "teacher.$class_.quizzes". */
  name: string;
  /** The re-exported names, e.g. ['loader', 'action', 'default']. */
  exported: string[];
  /** Absolute path of the route module it re-exports from, if resolvable. */
  sourceFile: string | null;
  sourceSpecifier: string | null;
}

/** Every file under app/routes whose route id starts with the given prefix. */
const prefixedRouteFiles = (prefix: string): { name: string; file: string }[] => {
  const found: { name: string; file: string }[] = [];
  for (const entry of readdirSync(ROUTES_DIR)) {
    if (!entry.startsWith(prefix)) continue;
    const path = join(ROUTES_DIR, entry);
    if (statSync(path).isDirectory()) {
      const file = join(path, 'route.tsx');
      if (existsSync(file)) found.push({ name: entry, file });
    } else if (entry.endsWith('.tsx')) {
      found.push({ name: entry.replace(/\.tsx$/, ''), file: path });
    }
  }
  return found;
};

/** Resolve a re-export specifier to the file it names. */
const resolveSource = (fromFile: string, specifier: string): string | null => {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.tsx`, `${base}.ts`, join(base, 'route.tsx')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

const collectRoutes = (prefix: string): PrefixedRoute[] =>
  prefixedRouteFiles(prefix).map(({ name, file }) => {
    const text = readFileSync(file, 'utf-8');
    const reExport = text.match(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/);

    if (!reExport) {
      // A route with its own implementation (the layout shells).
      const own = [...text.matchAll(/^export\s+(?:const|async function|function)\s+(\w+)/gm)].map(
        m => m[1]
      );
      if (/^export default/m.test(text)) own.push('default');
      return { name, exported: own, sourceFile: null, sourceSpecifier: null };
    }

    return {
      name,
      exported: reExport[1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
      sourceFile: resolveSource(file, reExport[2]),
      sourceSpecifier: reExport[2],
    };
  });

/** Does this route module define an `action` export? */
const definesAction = (file: string): boolean => {
  const text = readFileSync(file, 'utf-8');
  if (/^export\s+(?:const|async function|function)\s+action\b/m.test(text)) return true;
  // Some routes re-export an action from a sibling action.ts, or re-export on.
  return /export\s*\{[^}]*\baction\b[^}]*\}\s*from/.test(text);
};

describe.each(['teacher', 'assistant'] as const)('the /%s route tree', prefix => {
  const ROUTES = collectRoutes(prefix);
  const reExports = ROUTES.filter(r => r.sourceSpecifier !== null);
  const exemptions = INTENTIONALLY_NO_ACTION[prefix];
  const minimum = MINIMUM_ROUTES[prefix];

  it('has routes to check, so this file cannot pass by finding nothing', () => {
    // A glob that silently matched zero files would make every it.each below
    // vacuous.
    expect(ROUTES.length).toBeGreaterThanOrEqual(minimum.total);
    expect(reExports.length).toBeGreaterThanOrEqual(minimum.reExports);
  });

  it('resolves every re-export target to a real file', () => {
    const unresolved = reExports.filter(r => r.sourceFile === null);
    expect(unresolved.map(r => `${r.name} -> ${r.sourceSpecifier}`)).toEqual([]);
  });

  it.each(ROUTES.map(r => [r.name, r] as const))('%s exports default', (_name, route) => {
    // Without `default` the prefix renders nothing at all.
    expect(route.exported).toContain('default');
  });

  it.each(reExports.map(r => [r.name, r] as const))('%s exports loader', (_name, route) => {
    // Asserted for the RE-EXPORTS specifically, because that is where the
    // authorization gate lives: these routes have no code of their own, so a
    // missing loader is not a page short of data, it is a page short of its
    // gate. The layout shells (<prefix>/, <prefix>.$class/) legitimately have
    // no loader of their own — both are pass-through Outlets — so they are not
    // held to this.
    expect(route.exported).toContain('loader');
  });

  describe('re-exports action exactly when its source has one', () => {
    it.each(reExports.map(r => [r.name, r] as const))('%s', (name, route) => {
      const sourceHasAction = definesAction(route.sourceFile!);
      const reExportsAction = route.exported.includes('action');
      const exemptReason = exemptions[name];

      if (exemptReason) {
        expect(
          reExportsAction,
          `${name} is listed as intentionally read-only (${exemptReason}) but re-exports an ` +
            `action. Remove it from INTENTIONALLY_NO_ACTION or drop the export.`
        ).toBe(false);
        return;
      }

      expect(
        reExportsAction,
        sourceHasAction
          ? `${name} re-exports from ${route.sourceSpecifier}, which HAS an action, but does not ` +
              `re-export it — every form on this page would post to a route with no action. Add ` +
              `it, or record the omission in INTENTIONALLY_NO_ACTION with a reason.`
          : `${name} re-exports an action that ${route.sourceSpecifier} does not define.`
      ).toBe(sourceHasAction);
    });
  });

  describe('the intended read-only routes', () => {
    it('names every exemption against a route that actually exists', () => {
      // A stale exemption would silently excuse a route from the check above.
      for (const name of Object.keys(exemptions)) {
        expect(
          ROUTES.some(r => r.name === name),
          `INTENTIONALLY_NO_ACTION names ${name}, which is not a /${prefix} route`
        ).toBe(true);
      }
    });

    it('keeps the students roster read-only', () => {
      // Called out explicitly rather than left to the table: this one is a
      // permission boundary, so it should break loudly if someone "fixes" it.
      const students = ROUTES.find(r => r.name === `${prefix}.$class_.students`);
      expect(students).toBeDefined();
      expect(students!.exported).not.toContain('action');
      expect(definesAction(students!.sourceFile!)).toBe(true);
    });
  });
});
