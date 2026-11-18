#!/usr/bin/env node
// scripts/check-server-externals.mjs - fail when a package the server code
// imports would resolve differently in the app's production image.
//
// A runtime image keeps only what its Dockerfile copies from the build stage
// (the root node_modules, packages/, the app's build output; not
// apps/<app>/node_modules). A package the server bundle leaves external that
// npm nested under the app, or placed at the root in another version, builds
// and passes every test, then breaks or runs the wrong code in the image.
//
// For every bare import in the app's server files (the code paths its
// Dockerfile copies under apps/<app>/, minus build/client), this resolves the
// package twice from the importing file: once through every node_modules on
// the way to the root (what the build saw), once through only the directories
// the image holds. It exits 1 listing each package missing in the image or
// resolving to another version there. Node built-ins and relative imports are
// skipped, and so is any string that resolves nowhere: the build would have
// failed on a real import like that, so it is text, not an import.
//
// Usage (from the repo root): node scripts/check-server-externals.mjs apps/<app>/Dockerfile
import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { pathToFileURL } from 'node:url';

const IMPORT_RES = [
  /^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/gm,
  /^\s*import\s*["']([^"']+)["']/gm,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  // require.resolve(), createRequire(...).resolve(), import.meta.resolve()
  /\.resolve\(\s*["']([^"']+)["']\s*\)/g,
];
const CODE = /\.(m?js|cjs|m?ts|cts)$/;

/**
 * Source paths (relative to the repo root) the Dockerfile's last stage copies:
 * from an earlier stage (`COPY --from=<stage> /app/<path> <dest>`) or from the
 * build context. '.' means everything. Throws on a COPY it cannot read (a
 * variable, the JSON form, a stage path outside /app): guessing would either
 * check nothing or report every import as missing.
 */
export function keptPaths(dockerfile) {
  const lines = fs
    .readFileSync(dockerfile, 'utf8')
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map(line => line.trim());
  const runtime = lines.slice(lines.findLastIndex(line => /^FROM\s/i.test(line)) + 1);
  const kept = [];
  for (const line of runtime) {
    if (!/^COPY\s/i.test(line)) continue;
    const args = line.split(/\s+/).slice(1);
    const fromStage = args.some(a => /^--from=/i.test(a));
    const sources = args.filter(a => !a.startsWith('--')).slice(0, -1);
    if (!sources.length || sources.some(s => s.includes('$') || s.startsWith('[')))
      throw new Error(`${dockerfile}: cannot read "${line}"`);
    for (const source of sources) {
      if (!fromStage) kept.push(path.normalize(source));
      else if (source === '/app' || source === '/app/') kept.push('.');
      else if (source.startsWith('/app/')) kept.push(path.normalize(source.slice(5)));
      else throw new Error(`${dockerfile}: "${line}" copies from outside /app`);
    }
  }
  return kept.map(k => (k.length > 1 ? k.replace(/[\\/]$/, '') : k));
}

const inside = (p, dir) => dir === '.' || p === dir || p.startsWith(dir + path.sep);

/** Package name and subpath of a bare specifier (`@scope/pkg/sub` -> ['@scope/pkg', 'sub']). */
const splitSpec = spec => {
  const parts = spec.split('/');
  const n = spec.startsWith('@') ? 2 : 1;
  return [parts.slice(0, n).join('/'), parts.slice(n).join('/')];
};

/** The first target an `exports` entry gives under Node's conditions, or null. */
function pickTarget(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(pickTarget).find(Boolean) ?? null;
  for (const c of ['node', 'import', 'require', 'default'])
    if (c in v) {
      const t = pickTarget(v[c]);
      if (t) return t;
    }
  return null;
}

/** Whether `sub` ('' for the package itself) is importable from the package at `dir`. */
function hasSubpath(dir, pkg, sub) {
  const key = sub ? `./${sub}` : '.';
  const exp = pkg.exports;
  if (exp !== undefined) {
    const isMap =
      typeof exp === 'object' &&
      !Array.isArray(exp) &&
      Object.keys(exp).some(k => k.startsWith('.'));
    if (!isMap) return key === '.' && pickTarget(exp) !== null;
    if (key in exp) return pickTarget(exp[key]) !== null;
    return Object.entries(exp).some(([k, v]) => {
      const star = k.indexOf('*');
      return (
        star >= 0 &&
        key.startsWith(k.slice(0, star)) &&
        key.endsWith(k.slice(star + 1)) &&
        pickTarget(v) !== null
      );
    });
  }
  if (!sub) return true;
  return ['', '.js', '.mjs', '.cjs', '.json', '/index.js'].some(ext =>
    fs.existsSync(path.join(dir, sub + ext))
  );
}

/**
 * Resolve `spec` from `fromDir` the way Node walks node_modules, looking only
 * in node_modules directories `allowed` accepts. Returns { version, dir } or null.
 */
export function resolvePackage(root, fromDir, spec, allowed = () => true) {
  const [name, sub] = splitSpec(spec);
  for (let d = fromDir; ; d = path.dirname(d)) {
    const nm = path.join(d, 'node_modules');
    const pkgJson = path.join(nm, name, 'package.json');
    if (allowed(path.relative(root, nm)) && fs.existsSync(pkgJson)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
      return hasSubpath(path.dirname(pkgJson), pkg, sub)
        ? { version: pkg.version, dir: path.dirname(pkgJson) }
        : null;
    }
    if (d === root || d === path.dirname(d)) return null;
  }
}

function* codeFiles(p) {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) {
    if (CODE.test(p) && !p.endsWith('.d.ts')) yield p;
    return;
  }
  for (const e of fs.readdirSync(p))
    if (e !== 'node_modules' && e !== 'client') yield* codeFiles(path.join(p, e));
}

/**
 * Checks the app whose Dockerfile is given, from repo root `root`. Returns the
 * problems (one line per specifier) and how much was looked at. Throws when the
 * Dockerfile's image has no root node_modules or no server file was found:
 * the check would pass without checking anything.
 */
export function checkApp(root, dockerfile) {
  const kept = keptPaths(path.join(root, dockerfile));
  const appDir = path.dirname(dockerfile);
  const scan = kept.includes('.')
    ? [appDir]
    : kept.filter(k => inside(k, appDir) && !k.endsWith('.json'));
  const inImage = nm => kept.some(k => inside(nm, k));
  if (!inImage('node_modules'))
    throw new Error(`${dockerfile}: its last stage copies no root node_modules`);
  const problems = new Map(); // one line per package specifier
  const seen = new Set();
  let files = 0;
  for (const s of scan)
    for (const file of codeFiles(path.join(root, s))) {
      files += 1;
      const src = fs.readFileSync(file, 'utf8');
      for (const re of IMPORT_RES)
        for (const m of src.matchAll(re)) {
          const spec = m[1];
          if (spec.startsWith('.') || spec.startsWith('/') || spec.includes(':') || isBuiltin(spec))
            continue;
          const key = `${path.dirname(file)}\0${spec}`;
          if (seen.has(key) || problems.has(spec)) continue;
          seen.add(key);
          const built = resolvePackage(root, path.dirname(file), spec);
          if (!built) continue; // resolves nowhere: text, not an import
          const image = resolvePackage(root, path.dirname(file), spec, inImage);
          const at = `${built.version} at build (${path.relative(root, built.dir)})`;
          const by = `imported by ${path.relative(root, file)}`;
          if (!image) problems.set(spec, `${spec}: ${at}, missing in the image (${by})`);
          else if (image.version !== built.version)
            problems.set(
              spec,
              `${spec}: ${at}, ${image.version} in the image (${path.relative(root, image.dir)}; ${by})`
            );
        }
    }
  if (!files) throw new Error(`${dockerfile}: no server file found under ${scan.join(', ')}`);
  return { problems: [...problems.values()].sort(), files, specifiers: seen.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dockerfile = process.argv[2];
  if (!dockerfile) {
    console.error('usage: node scripts/check-server-externals.mjs apps/<app>/Dockerfile');
    process.exit(2);
  }
  let result;
  try {
    result = checkApp(process.cwd(), dockerfile);
  } catch (error) {
    console.error(`check-server-externals: ${error.message}`);
    process.exit(2);
  }
  const { problems, files, specifiers } = result;
  if (problems.length) {
    console.error(
      `check-server-externals: ${dockerfile}: ${problems.length} import(s) resolve differently in the image:`
    );
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      'Place the version the app builds with at the root node_modules, or bundle it (ssr.noExternal).'
    );
    process.exit(1);
  }
  process.stdout.write(
    `check-server-externals: ${dockerfile}: every external import resolves the same in the image (${specifiers} imports in ${files} files)\n`
  );
}
