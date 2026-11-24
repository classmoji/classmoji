#!/usr/bin/env node
// scripts/check-no-dom-runtime.mjs - fail when an app's server code would load
// jsdom or BlockNote's server editor at runtime.
//
// The pages service renders no page HTML on the server any more (the reader
// draws pages in the browser) and is meant to run where jsdom cannot, e.g.
// Cloudflare Workers. jsdom, `@blocknote/server-util` (which imports jsdom) and
// `@classmoji/page-schema/html` (which uses both) stay installed for tests, a
// Trigger task and scripts, so nothing stops a new import from pulling them back
// into the server: this does.
//
// It reads the BUILT server, not the sources, because that is where a
// transitive import (a workspace package, a dependency) shows up:
//   - every `.js` under <app>/build/server: an import, dynamic import or
//     require of a forbidden package (Vite leaves jsdom external, so even a
//     bundled `@blocknote/server-util` shows up as `from "jsdom"`);
//   - every `.map` there, IF the build kept them: a source file inside one of
//     the forbidden packages, which catches a bundled copy. A deploy build
//     with SENTRY_AUTH_TOKEN deletes the maps before this runs, so there only
//     the import half applies (a bundled server-util still imports jsdom);
//   - the server files Node runs unbundled (<app>/server.ts, <app>/server/**).
// Prose that merely names a package (a comment) is not an import and passes.
//
// Usage (from the repo root, after the app's build):
//   node scripts/check-no-dom-runtime.mjs apps/<app>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FORBIDDEN = ['jsdom', '@blocknote/server-util', '@classmoji/page-schema/html'];

/** Source paths (in a source map's `sources`) that only a forbidden package has. */
const FORBIDDEN_SOURCES = [
  /(^|\/)node_modules\/jsdom\//,
  /(^|\/)node_modules\/@blocknote\/server-util\//,
  /(^|\/)packages\/page-schema\/src\/(html|serverEditor)\.ts$/,
];

// The import shapes a bundle holds: a static import or re-export at the start
// of a line or right after a `;` or `}` (minified code puts several on one
// line; prose in a comment rarely starts that way), a dynamic import with a
// quoted or template-literal specifier, a require (Rolldown's CJS helper is
// `__require`).
const SPECIFIER_RES = [
  /(?:^|[;}])\s*(?:import|export)\b[^'"`;]*?\bfrom\s*["'`]([^"'`]+)["'`]/gm,
  /(?:^|[;}])\s*import\s*["'`]([^"'`]+)["'`]/gm,
  /\bimport\(\s*["'`]([^"'`$]+)["'`]\s*\)/g,
  /(?:^|[^\w$]|__)require\(\s*["'`]([^"'`$]+)["'`]\s*\)/g,
];

const isForbidden = spec => FORBIDDEN.some(name => spec === name || spec.startsWith(`${name}/`));

function* files(dir, test) {
  const st = fs.statSync(dir, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) {
    if (test(dir)) yield dir;
    return;
  }
  for (const entry of fs.readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    yield* files(path.join(dir, entry), test);
  }
}

/** Forbidden specifiers imported by `src`, deduplicated. */
export function forbiddenImports(src) {
  const found = new Set();
  for (const re of SPECIFIER_RES)
    for (const m of src.matchAll(re)) if (isForbidden(m[1])) found.add(m[1]);
  return [...found];
}

/**
 * Checks the app at `appDir` (relative to `root`). Returns the problems and how
 * much was read. Throws when the app has no built server: the check would pass
 * without checking anything.
 */
export function checkApp(root, appDir) {
  const app = path.join(root, appDir);
  const serverBuild = path.join(app, 'build', 'server');
  const built = [...files(serverBuild, f => /\.(m?js|cjs)$/.test(f))];
  if (!built.length)
    throw new Error(`${appDir}: no built server under build/server (build it first)`);
  const maps = [...files(serverBuild, f => f.endsWith('.map'))];
  const unbundled = [
    ...files(path.join(app, 'server.ts'), () => true),
    ...files(path.join(app, 'server'), f => /\.(m?[jt]s|cjs)$/.test(f) && !f.endsWith('.d.ts')),
  ];

  const problems = [];
  const rel = f => path.relative(root, f);
  for (const file of [...built, ...unbundled])
    for (const spec of forbiddenImports(fs.readFileSync(file, 'utf8')))
      problems.push(`${rel(file)} imports ${spec}`);
  for (const file of maps) {
    let sources = [];
    try {
      sources = JSON.parse(fs.readFileSync(file, 'utf8')).sources ?? [];
    } catch {
      continue;
    }
    const hits = sources.filter(s => FORBIDDEN_SOURCES.some(re => re.test(s.replace(/\\/g, '/'))));
    if (hits.length) problems.push(`${rel(file)} bundles ${hits.slice(0, 3).join(', ')}`);
  }
  return { problems, files: built.length + unbundled.length, maps: maps.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appDir = process.argv[2];
  if (!appDir) {
    console.error('usage: node scripts/check-no-dom-runtime.mjs apps/<app>');
    process.exit(2);
  }
  let result;
  try {
    result = checkApp(process.cwd(), appDir);
  } catch (error) {
    console.error(`check-no-dom-runtime: ${error.message}`);
    process.exit(2);
  }
  if (result.problems.length) {
    console.error(`check-no-dom-runtime: ${appDir}: the server loads a DOM at runtime:`);
    for (const p of result.problems) console.error(`  ${p}`);
    console.error(
      `Keep ${FORBIDDEN.join(', ')} out of the server: tests, Trigger tasks and scripts only.`
    );
    process.exit(1);
  }
  process.stdout.write(
    `check-no-dom-runtime: ${appDir}: no ${FORBIDDEN.join(', ')} in the server (${result.files} files, ${result.maps} source maps)\n`
  );
}
