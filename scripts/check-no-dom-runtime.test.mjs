// node --test scripts/check-no-dom-runtime.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkApp,
  forbiddenImports,
  runtimeSpecifiers,
  walkEntry,
} from './check-no-dom-runtime.mjs';

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A tiny app: a built server, its source map, and the unbundled server.ts. */
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-dom-runtime-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

const CLEAN = {
  'apps/app/build/server/index.js': [
    '/**',
    " * BlockNote's server editor (jsdom) is not used here; see from 'jsdom' notes.",
    ' */',
    'import { createRequestHandler } from "react-router";',
    'const ua = navigator.userAgent.includes(`jsdom`);',
    'export default createRequestHandler;',
  ].join('\n'),
  'apps/app/build/server/index.js.map': {
    sources: ['../../app/root.tsx', '../../../../node_modules/react/index.js'],
  },
  'apps/app/server.ts': "import express from 'express';\n",
};

test('a server that only names jsdom in prose and strings passes', () => {
  const { problems, files, maps } = checkApp(fixture(CLEAN), 'apps/app');
  assert.deepEqual(problems, []);
  assert.equal(files, 2);
  assert.equal(maps, 1);
});

test('an import of jsdom in the built server fails (how a bundled server-util shows up)', () => {
  const root = fixture({
    ...CLEAN,
    'apps/app/build/server/assets/chunk.js': 'import * as f from "jsdom";\nexport { f };\n',
  });
  assert.deepEqual(checkApp(root, 'apps/app').problems, [
    'apps/app/build/server/assets/chunk.js imports jsdom',
  ]);
});

test('a dynamic import, a require and a subpath count too', () => {
  assert.deepEqual(
    forbiddenImports(
      [
        'const a = await import("@blocknote/server-util");',
        "const b = require('jsdom/lib/api.js');",
        'export { c } from "@classmoji/page-schema/html";',
        'import "@classmoji/page-schema";',
        'import x from "jsdom-global-not-it";',
      ].join('\n')
    ).sort(),
    ['@blocknote/server-util', '@classmoji/page-schema/html', 'jsdom/lib/api.js']
  );
});

test('the shapes a bundler writes: __require, a template-literal import, same-line minified imports', () => {
  assert.deepEqual(forbiddenImports('var dom = __require("jsdom");\n'), ['jsdom']);
  assert.deepEqual(forbiddenImports('const m = await import(`jsdom`);\n'), ['jsdom']);
  assert.deepEqual(
    forbiddenImports(
      'let x=1;import{J}from"jsdom";export{y}from"@blocknote/server-util";\n'
    ).sort(),
    ['@blocknote/server-util', 'jsdom']
  );
  assert.deepEqual(forbiddenImports('function f(){}import"@classmoji/page-schema/html";\n'), [
    '@classmoji/page-schema/html',
  ]);
  // Not imports: an interpolated template, a property named require, prose.
  assert.deepEqual(
    forbiddenImports(
      [
        'const a = import(`${base}/jsdom`);',
        'obj.myrequire("jsdom");',
        ' * Import it from "jsdom" only in tests.',
      ].join('\n')
    ),
    []
  );
});

test('a source map naming a forbidden package fails, even with no import left', () => {
  const root = fixture({
    ...CLEAN,
    'apps/app/build/server/index.js.map': {
      sources: ['../../../../node_modules/@blocknote/server-util/dist/blocknote-server-util.js'],
    },
  });
  assert.equal(checkApp(root, 'apps/app').problems.length, 1);
  assert.match(checkApp(root, 'apps/app').problems[0], /bundles .*@blocknote\/server-util/);
});

test('the unbundled server files are read as they are', () => {
  const root = fixture({
    ...CLEAN,
    'apps/app/server/siteHost.ts': "import { JSDOM } from 'jsdom';\n",
  });
  assert.deepEqual(checkApp(root, 'apps/app').problems, [
    'apps/app/server/siteHost.ts imports jsdom',
  ]);
});

test('no built server is an error, never a pass', () => {
  const root = fixture({ 'apps/app/server.ts': "import express from 'express';\n" });
  assert.throws(() => checkApp(root, 'apps/app'), /no built server/);
});

// ─── --entry: the runtime import graph of an unbundled server ───────────────

/**
 * A resolver for fixtures: relative paths as files, a bare name as
 * `node_modules/<name>/index.js` (the walk's own Node resolution needs
 * --experimental-import-meta-resolve; the CLI tests below use it).
 */
function fixtureResolve(root) {
  return (spec, from) => {
    const target = spec.startsWith('.')
      ? path.resolve(path.dirname(from), spec)
      : path.join(root, 'node_modules', spec, 'index.js');
    if (!fs.existsSync(target)) throw new Error(`cannot find ${spec}`);
    return target;
  };
}

test('TypeScript is read as Node runs it: type-only imports load nothing', async () => {
  const found = await runtimeSpecifiers(
    [
      "import type { JSDOM } from 'jsdom';",
      "export type Html = typeof import('@classmoji/page-schema/html');",
      "import { type A, b } from './b.ts';",
      "export * from './c.ts';",
      "const lazy = () => import('./d.ts');",
      'const computed = (s: string) => import(s);',
      '/** Loaded with a dynamic `import()` on first use. */',
    ].join('\n'),
    'entry.ts'
  );
  assert.deepEqual(found.imports.sort(), ['./b.ts', './c.ts', './d.ts']);
  assert.equal(found.computed, 1);
});

test('comments, strings and template literals load nothing; real loads still count', async () => {
  const found = await runtimeSpecifiers(
    [
      "// later: import('@classmoji/page-schema/html') when needed",
      "/* import('./x.ts') */",
      'const doc = `',
      'import App from "./App";',
      'import { JSDOM } from "jsdom"',
      "require('jsdom')",
      '`;',
      'const s = "require(\'jsdom\')";',
      "const r = /require\\('jsdom'\\)/;",
      "/* x */ import './real.ts';",
      "const lit = () => import(/* @vite-ignore */ 'lit');",
      'const dep = require(\'dep\'); const h = __require("helper");',
      "obj.myrequire('nope');",
    ].join('\n'),
    'entry.js'
  );
  assert.deepEqual(found.imports.sort(), ['./real.ts', 'lit']);
  assert.deepEqual(found.requires.sort(), ['dep', 'helper']);
  assert.equal(found.computed, 0);
});

test('a computed import() in first-party code fails; in a dependency it is only listed', async () => {
  const root = fixture({
    'src/index.ts': "import 'dep';\nexport const load = (s: string) => import(s);\n",
    'node_modules/dep/index.js':
      "// optional: import('jsdom') if a DOM is wanted\nexport const f = n => import(n);\n",
  });
  const { problems, computed } = await walkEntry(root, 'src/index.ts', {
    resolve: fixtureResolve(root),
  });
  assert.deepEqual(problems, [
    'src/index.ts: an import() with a computed specifier cannot be followed',
  ]);
  assert.deepEqual(computed, ['node_modules/dep/index.js (1)']);
});

test('the walk follows static, re-exported and lazy imports into packages', async () => {
  const root = fixture({
    'src/index.ts': "import { a } from './a.ts';\nexport { a };\n",
    'src/a.ts': "export * from 'pkg';\nexport const a = () => import('./lazy.ts');\n",
    'src/lazy.ts': "export const l = require('dep');\n",
    'node_modules/pkg/index.js': 'export const p = 1;\n',
    'node_modules/dep/index.js': "module.exports = require('jsdom');\n",
  });
  const { problems, files } = await walkEntry(root, 'src/index.ts', {
    resolve: fixtureResolve(root),
  });
  assert.deepEqual(problems, [
    'src/index.ts -> src/a.ts -> src/lazy.ts -> node_modules/dep/index.js imports jsdom',
  ]);
  assert.equal(files, 5);
});

test('a resolved file inside a forbidden module fails, whatever the specifier', async () => {
  const root = fixture({
    'src/index.ts': "export * from '../packages/page-schema/src/server.ts';\n",
    'packages/page-schema/src/server.ts': "export const e = () => import('./serverEditor.ts');\n",
    'packages/page-schema/src/serverEditor.ts': 'export const s = 1;\n',
  });
  const { problems } = await walkEntry(root, 'src/index.ts', { resolve: fixtureResolve(root) });
  assert.deepEqual(problems, [
    'src/index.ts -> packages/page-schema/src/server.ts imports ./serverEditor.ts (packages/page-schema/src/serverEditor.ts)',
  ]);
});

test('a first-party relative import that does not resolve fails; a missing entry throws', async () => {
  const root = fixture({ 'src/index.ts': "import './gone.ts';\n" });
  const { problems } = await walkEntry(root, 'src/index.ts', { resolve: fixtureResolve(root) });
  assert.deepEqual(problems, ['src/index.ts: cannot resolve ./gone.ts']);
  await assert.rejects(
    walkEntry(root, 'src/nope.ts', { resolve: fixtureResolve(root) }),
    /no such/
  );
});

test('CLI: commented and string imports are not loads (nothing forbidden, nothing unresolved)', () => {
  const root = fixture({
    'src/index.ts': [
      "// import('@classmoji/page-schema/html') was the lazy converter",
      "/* import('./x.ts') */",
      'export const tpl = `',
      'import App from "./App";',
      'import { JSDOM } from "jsdom"',
      '`;',
      "import './a.ts';",
    ].join('\n'),
    'src/a.ts': 'export {};\n',
  });
  const run = cli(root, 'src/index.ts');
  // Two files: too few to pass, but nothing forbidden (exit 2, not 1).
  assert.equal(run.status, 2, run.stderr);
  assert.doesNotMatch(run.stderr, /loads a DOM/);
});

const SCRIPT = fileURLToPath(new URL('./check-no-dom-runtime.mjs', import.meta.url));
const cli = (root, entry) =>
  spawnSync(process.execPath, [SCRIPT, '--entry', entry], { cwd: root, encoding: 'utf8' });

test('CLI: Node resolution, a lazy import of a forbidden package fails (exit 1)', () => {
  const root = fixture({
    'src/index.ts': "export const later = () => import('@classmoji/page-schema/html');\n",
  });
  const run = cli(root, 'src/index.ts');
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /src\/index\.ts imports @classmoji\/page-schema\/html/);
});

test('CLI: a walk that reaches almost nothing is an error, never a pass (exit 2)', () => {
  const root = fixture({ 'src/index.ts': "import './a.ts';\n", 'src/a.ts': 'export {};\n' });
  const run = cli(root, 'src/index.ts');
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /reached only 2 files/);
});
