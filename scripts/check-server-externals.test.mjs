// node --test scripts/check-server-externals.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { checkApp, keptPaths } from './check-server-externals.mjs';

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A tiny repo: root node_modules (in the image), apps/app/node_modules (not), a server bundle. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-externals-'));
  roots.push(root);
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
  };
  const pkg = (dir, name, version, extra = {}) =>
    write(`${dir}/${name}/package.json`, { name, version, ...extra });
  write(
    'apps/app/Dockerfile',
    [
      'FROM node:24-alpine AS build',
      'COPY . .',
      'FROM node:24-alpine',
      'COPY --from=build /app/node_modules ./node_modules',
      'COPY --from=build /app/packages ./packages',
      'COPY --from=build /app/apps/app/build ./apps/app/build',
      'COPY --from=build /app/apps/app/package.json ./apps/app/package.json',
    ].join('\n')
  );
  pkg('node_modules', 'ok', '1.0.0');
  pkg('node_modules', 'req', '1.0.0');
  pkg('apps/app/node_modules', 'nested-only', '1.0.0');
  pkg('apps/app/node_modules', 'dyn-only', '1.0.0');
  pkg('apps/app/node_modules', 'resolved-only', '1.0.0');
  pkg('node_modules', 'wrong', '1.0.0');
  pkg('apps/app/node_modules', 'wrong', '2.0.0');
  pkg('node_modules', '@scope/pkg', '1.0.0');
  pkg('apps/app/node_modules', '@scope/pkg', '2.0.0');
  pkg('node_modules', 'sub', '1.0.0', {
    exports: { '.': './i.js', './feature': { import: './f.mjs' } },
  });
  pkg('node_modules', 'pattern', '1.0.0', { exports: { './*': './dist/*.js' } });
  pkg('node_modules', 'plain', '1.0.0');
  write('node_modules/plain/extra.js', '');
  // only the nested (build-time) version exports ./new
  pkg('node_modules', 'grown', '1.0.0', { exports: { '.': './i.js' } });
  pkg('apps/app/node_modules', 'grown', '2.0.0', { exports: { '.': './i.js', './new': './n.js' } });
  write(
    'apps/app/build/server/index.js',
    [
      'import fs from "fs";',
      'import path from "node:path";',
      'import { a } from "ok";',
      'import "nested-only";',
      'import { w } from "wrong";',
      'export { s } from "@scope/pkg";',
      'import { f } from "sub/feature";',
      'import { p } from "pattern/thing";',
      'import { x } from "plain/extra";',
      'import { n } from "grown/new";',
      'import { rel } from "./assets/chunk.js";',
      'const d = () => import("dyn-only");',
      'const r = require("req");',
      'const at = createRequire(import.meta.url).resolve("resolved-only");',
      'const text = `',
      'import nothing from "absent";',
      '`;',
    ].join('\n')
  );
  write('apps/app/build/client/assets/app.js', 'import "nested-only-client";');
  return root;
}

test('keptPaths reads the runtime stage COPY --from=build sources', () => {
  const root = fixture();
  assert.deepEqual(keptPaths(path.join(root, 'apps/app/Dockerfile')), [
    'node_modules',
    'packages',
    'apps/app/build',
    'apps/app/package.json',
  ]);
});

test('reports missing and wrong-version externals, and nothing else', () => {
  const root = fixture();
  const { problems, files } = checkApp(root, 'apps/app/Dockerfile');
  assert.equal(files, 1); // build/client is not server code
  const specs = problems.map(p => p.split(':')[0]).sort();
  assert.deepEqual(specs, [
    '@scope/pkg',
    'dyn-only',
    'grown/new',
    'nested-only',
    'resolved-only',
    'wrong',
  ]);
  assert.match(
    problems.find(p => p.startsWith('nested-only')),
    /1\.0\.0 at build .*missing in the image/
  );
  assert.match(
    problems.find(p => p.startsWith('wrong')),
    /2\.0\.0 at build .*1\.0\.0 in the image/
  );
  assert.match(
    problems.find(p => p.startsWith('@scope/pkg')),
    /2\.0\.0 at build .*1\.0\.0 in the image/
  );
  // the root version exists but does not export the subpath the build used
  assert.match(
    problems.find(p => p.startsWith('grown/new')),
    /2\.0\.0 at build .*missing in the image/
  );
});

test('passes once the nested versions sit at the root', () => {
  const root = fixture();
  for (const name of ['nested-only', 'dyn-only', 'resolved-only', 'wrong', '@scope/pkg', 'grown']) {
    fs.rmSync(path.join(root, 'node_modules', name), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(path.join(root, 'node_modules', name)), { recursive: true });
    fs.renameSync(
      path.join(root, 'apps/app/node_modules', name),
      path.join(root, 'node_modules', name)
    );
  }
  assert.deepEqual(checkApp(root, 'apps/app/Dockerfile').problems, []);
});

/** The fixture with its Dockerfile's last stage replaced by `runtime` lines. */
function withRuntimeStage(runtime) {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, 'apps/app/Dockerfile'),
    ['FROM node:24-alpine AS builder', 'COPY . .', 'FROM node:24-alpine', ...runtime].join('\n')
  );
  return root;
}
const specsOf = root =>
  checkApp(root, 'apps/app/Dockerfile')
    .problems.map(p => p.split(':')[0])
    .sort();

test('reads COPY flags, another stage name, several sources and continuations', () => {
  const root = withRuntimeStage([
    'COPY --link --chown=node:node --from=builder /app/node_modules ./node_modules',
    '  copy --from=builder /app/packages /app/apps/app/build \\',
    '    ./',
  ]);
  assert.deepEqual(keptPaths(path.join(root, 'apps/app/Dockerfile')), [
    'node_modules',
    'packages',
    'apps/app/build',
  ]);
  assert.ok(specsOf(root).includes('nested-only'));
});

test('an image that copies the whole app keeps its nested node_modules', () => {
  const root = withRuntimeStage([
    'COPY --from=builder /app/node_modules ./node_modules',
    'COPY --from=builder /app/apps/app ./apps/app',
  ]);
  assert.deepEqual(specsOf(root), []);
});

test('refuses a Dockerfile it cannot read, or one with nothing to check', () => {
  const cases = [
    ['COPY --from=builder /app/${APP}/build ./build'],
    ['COPY ["--from=builder", "/app/node_modules", "./node_modules"]'],
    ['COPY --from=builder /srv/node_modules ./node_modules'],
    ['COPY --from=builder /app/apps/app/build ./apps/app/build'], // no root node_modules
    ['COPY --from=builder /app/node_modules ./node_modules'], // no server files
  ];
  for (const runtime of cases)
    assert.throws(() => checkApp(withRuntimeStage(runtime), 'apps/app/Dockerfile'), runtime[0]);
});
