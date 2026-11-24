// node --test scripts/check-no-dom-runtime.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { checkApp, forbiddenImports } from './check-no-dom-runtime.mjs';

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
