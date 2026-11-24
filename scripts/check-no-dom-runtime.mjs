#!/usr/bin/env node
// scripts/check-no-dom-runtime.mjs - fail when an app's server code would load
// jsdom or BlockNote's server editor at runtime.
//
// The pages service renders no page HTML on the server any more (the reader
// draws pages in the browser) and is meant to run where jsdom cannot, e.g.
// Cloudflare Workers. The collab server converts no legacy page any more (they
// are converted by an operator script). jsdom, `@blocknote/server-util` (which
// imports jsdom) and `@classmoji/page-schema/html` (which uses both) stay
// installed for tests, a Trigger task and scripts, so nothing stops a new
// import from pulling them back into either server: this does.
//
// Two modes.
//
// A BUILT app (pages): `node scripts/check-no-dom-runtime.mjs apps/<app>`, after
// the app's build. It reads the built server, not the sources, because that is
// where a transitive import (a workspace package, a dependency) shows up:
//   - every `.js` under <app>/build/server: an import, dynamic import or
//     require of a forbidden package (Vite leaves jsdom external, so even a
//     bundled `@blocknote/server-util` shows up as `from "jsdom"`);
//   - every `.map` there, IF the build kept them: a source file inside one of
//     the forbidden packages, which catches a bundled copy. A deploy build
//     with SENTRY_AUTH_TOKEN deletes the maps before this runs, so there only
//     the import half applies (a bundled server-util still imports jsdom);
//   - the server files Node runs unbundled (<app>/server.ts, <app>/server/**).
//
// An UNBUNDLED server (collab runs its TypeScript directly):
// `node scripts/check-no-dom-runtime.mjs --entry apps/collab/src/index.ts`. It
// follows the real import graph from the entry: every static import and
// re-export, every `import('literal')` (a lazy load counts: it is still a
// runtime load) and every `require('literal')`, resolved the way Node resolves
// them at runtime (`import.meta.resolve` with the importing file as parent;
// the script re-runs itself with --experimental-import-meta-resolve for that),
// through workspace packages and node_modules. TypeScript is read the way Node
// runs it (`stripTypeScriptTypes`), so a type-only import is not a load. It
// fails on a forbidden specifier, on a resolved file inside a forbidden package
// or `packages/page-schema/src/{html,serverEditor}.ts`, on a relative import
// that does not resolve, and on a walk that reached almost nothing. A dynamic
// import with a computed specifier cannot be followed: those in first-party
// code are listed.
//
// Prose that merely names a package (a comment) is not an import and passes.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
// A namespace import: `stripTypeScriptTypes` is missing before Node 22.13, and
// a named import of it would break the built-app mode there too.
import * as nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const STATIC_RES = [
  /(?:^|[;}])\s*(?:import|export)\b[^'"`;]*?\bfrom\s*["'`]([^"'`]+)["'`]/gm,
  /(?:^|[;}])\s*import\s*["'`]([^"'`]+)["'`]/gm,
];
const DYNAMIC_RE = /\bimport\(\s*["'`]([^"'`$]+)["'`]\s*\)/g;
const REQUIRE_RE = /(?:^|[^\w$]|__)require\(\s*["'`]([^"'`$]+)["'`]\s*\)/g;
const SPECIFIER_RES = [...STATIC_RES, DYNAMIC_RE, REQUIRE_RE];
/**
 * `import(` whose argument is not one plain string literal (not `obj.import(`,
 * and not the bare `import()` prose writes).
 */
const NON_LITERAL_IMPORT_RE = /(?<![\w$.])import\(\s*(?!\)|["'][^"'`$]*["']\s*\)|`[^`$]*`\s*\))/g;

const isForbidden = spec => FORBIDDEN.some(name => spec === name || spec.startsWith(`${name}/`));
const isForbiddenFile = file => FORBIDDEN_SOURCES.some(re => re.test(file.replace(/\\/g, '/')));

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
    const hits = sources.filter(s => isForbiddenFile(s));
    if (hits.length) problems.push(`${rel(file)} bundles ${hits.slice(0, 3).join(', ')}`);
  }
  return { problems, files: built.length + unbundled.length, maps: maps.length };
}

// ─── The import graph of an unbundled server ────────────────────────────────

/** Files the walk reads: JavaScript and TypeScript, not declarations. */
const isSource = file => /\.(?:[cm]?js|[cm]?ts)$/.test(file) && !/\.d\.[cm]?ts$/.test(file);
const isTypeScript = file => /\.[cm]?ts$/.test(file);

/**
 * What `src` loads at runtime: `imports` (static, re-exports, literal dynamic
 * imports), `requires`, and how many dynamic imports have a computed
 * specifier. TypeScript loses its types first, as Node's type stripping does,
 * so `import type` and `typeof import('x')` load nothing.
 */
export function runtimeSpecifiers(src, file = 'x.js') {
  let code = src;
  if (isTypeScript(file)) {
    if (!nodeModule.stripTypeScriptTypes) {
      throw new Error('reading TypeScript needs Node 22.13 or later (stripTypeScriptTypes)');
    }
    try {
      code = nodeModule.stripTypeScriptTypes(src);
    } catch {
      // Not strippable (Node refuses to run it that way either): read as is,
      // which only ever finds more imports, never fewer.
    }
  }
  const imports = new Set();
  for (const re of [...STATIC_RES, DYNAMIC_RE])
    for (const m of code.matchAll(re)) imports.add(m[1]);
  const requires = new Set();
  for (const m of code.matchAll(REQUIRE_RE)) requires.add(m[1]);
  const computed = [...code.matchAll(NON_LITERAL_IMPORT_RE)].length;
  return { imports: [...imports], requires: [...requires], computed };
}

/**
 * Node's own resolution of `spec` from `file`: the ESM resolver for imports
 * (needs --experimental-import-meta-resolve for the parent argument), the CJS
 * one for requires. A file path, or null for something that is not a file.
 */
export function nodeResolve(spec, file, how) {
  if (how === 'require') {
    const resolved = nodeModule.createRequire(file).resolve(spec);
    return path.isAbsolute(resolved) ? resolved : null;
  }
  const url = import.meta.resolve(spec, pathToFileURL(file).href);
  if (!url.startsWith('file:')) return null;
  const resolved = fileURLToPath(url);
  if (!fs.existsSync(resolved)) {
    const error = new Error(`Cannot find module '${spec}' imported from ${file}`);
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  }
  return resolved;
}

/** Whether `import.meta.resolve` honours its parent argument in this process. */
export function parentResolveWorks() {
  try {
    return import.meta
      .resolve('./probe.js', 'file:///no-dom-runtime-probe/a.js')
      .includes('no-dom-runtime-probe');
  } catch {
    return false;
  }
}

/** A walk that reached fewer files than this read nothing that matters. */
export const MIN_FILES = 10;

/**
 * Follows the runtime import graph from `entry` (relative to `root`).
 * `problems` fail the check; `unresolved` (bare specifiers Node could not
 * resolve, e.g. an optional dependency behind a try) and `computed`
 * (first-party files with a computed `import(...)`) are reported.
 */
export function walkEntry(root, entry, { resolve = nodeResolve } = {}) {
  const entryFile = path.resolve(root, entry);
  if (!fs.statSync(entryFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${entry}: no such file`);
  }
  if (resolve === nodeResolve && !parentResolveWorks()) {
    throw new Error('run node with --experimental-import-meta-resolve (the CLI does it itself)');
  }
  const rel = f => path.relative(root, f);
  const parent = new Map([[entryFile, null]]);
  const chain = file => {
    const out = [];
    for (let at = file; at; at = parent.get(at)) out.unshift(rel(at));
    return out.join(' -> ');
  };
  const problems = [];
  const unresolved = [];
  const computed = [];
  const queue = [entryFile];
  while (queue.length) {
    const file = queue.shift();
    const found = runtimeSpecifiers(fs.readFileSync(file, 'utf8'), file);
    const firstParty = !file.replace(/\\/g, '/').includes('/node_modules/');
    if (found.computed && firstParty) computed.push(`${rel(file)} (${found.computed})`);
    const specs = [
      ...found.imports.map(spec => [spec, 'import']),
      ...found.requires.map(spec => [spec, 'require']),
    ];
    for (const [spec, how] of specs) {
      if (spec.startsWith('node:') || nodeModule.isBuiltin(spec)) continue;
      if (isForbidden(spec)) {
        problems.push(`${chain(file)} imports ${spec}`);
        continue;
      }
      let target;
      try {
        target = resolve(spec, file, how);
      } catch {
        // An import-shaped specifier in CommonJS (a JSDoc `import('./x')`
        // type, an extensionless path) may still be a file require() finds.
        try {
          target = how === 'import' ? resolve(spec, file, 'require') : undefined;
        } catch {
          target = undefined;
        }
        if (target === undefined) {
          // First-party code must resolve: a typo'd path would hide its whole
          // subtree. In node_modules a miss is a comment, a type, an optional
          // dependency or a generated file: reported, not fatal.
          if (firstParty && (spec.startsWith('.') || spec.startsWith('/'))) {
            problems.push(`${chain(file)}: cannot resolve ${spec}`);
          } else {
            unresolved.push(`${rel(file)}: ${spec}`);
          }
          continue;
        }
      }
      if (!target) continue;
      if (isForbiddenFile(target)) {
        problems.push(`${chain(file)} imports ${spec} (${rel(target)})`);
        continue;
      }
      if (!isSource(target) || parent.has(target)) continue;
      parent.set(target, file);
      queue.push(target);
    }
  }
  return { problems, files: parent.size, unresolved, computed };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const RESOLVE_FLAG = '--experimental-import-meta-resolve';

function runEntry(entry, verbose) {
  if (!parentResolveWorks()) {
    if (process.execArgv.includes(RESOLVE_FLAG)) {
      console.error(`check-no-dom-runtime: this node ignores ${RESOLVE_FLAG}; cannot resolve`);
      process.exit(2);
    }
    // import.meta.resolve ignores its parent argument without the flag.
    const rerun = spawnSync(
      process.execPath,
      [
        RESOLVE_FLAG,
        '--disable-warning=ExperimentalWarning',
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
      ],
      { stdio: 'inherit' }
    );
    process.exit(rerun.status ?? 2);
  }
  let result;
  try {
    result = walkEntry(process.cwd(), entry);
  } catch (error) {
    console.error(`check-no-dom-runtime: ${error.message}`);
    process.exit(2);
  }
  if (result.computed.length) {
    console.error(
      `check-no-dom-runtime: ${entry}: computed import() not followed in ${result.computed.join(', ')}`
    );
  }
  if (verbose && result.unresolved.length) {
    console.error(`check-no-dom-runtime: ${entry}: unresolved (optional) imports:`);
    for (const u of result.unresolved) console.error(`  ${u}`);
  }
  if (result.problems.length) {
    console.error(`check-no-dom-runtime: ${entry}: the server loads a DOM at runtime:`);
    for (const p of result.problems) console.error(`  ${p}`);
    console.error(
      `Keep ${FORBIDDEN.join(', ')} out of the server: tests, Trigger tasks and scripts only.`
    );
    process.exit(1);
  }
  if (result.files < MIN_FILES) {
    console.error(
      `check-no-dom-runtime: ${entry}: the walk reached only ${result.files} files; nothing was checked`
    );
    process.exit(2);
  }
  process.stdout.write(
    `check-no-dom-runtime: ${entry}: no ${FORBIDDEN.join(', ')} in the runtime import graph (${result.files} files, ${result.unresolved.length} unresolved optional imports)\n`
  );
}

function runApp(appDir) {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--entry');
  if (at !== -1) {
    const entry = args[at + 1];
    if (!entry) {
      console.error('usage: node scripts/check-no-dom-runtime.mjs --entry <file> [--verbose]');
      process.exit(2);
    }
    runEntry(entry, args.includes('--verbose'));
  } else if (args[0]) {
    runApp(args[0]);
  } else {
    console.error(
      'usage: node scripts/check-no-dom-runtime.mjs apps/<app>  |  --entry <file> [--verbose]'
    );
    process.exit(2);
  }
}
