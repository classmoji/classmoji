// Checks a Cloudflare build of the site before anything runs or deploys it.
//
//   node apps/site/cloudflare/check-build.mjs <site copy> <dev|staging>
//
// Called by build.sh and by the deploy-site-worker job in
// .github/workflows/deploy-fly-staging.yml. Fails (exit 1) on the first
// problem; prints only names and paths, never values.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [dir, environment] = process.argv.slice(2);
if (!dir || !['dev', 'staging'].includes(environment)) {
  console.error('usage: check-build.mjs <site copy> <dev|staging>');
  process.exit(2);
}

const problems = [];
const fail = message => problems.push(message);

// The generated config: dist/server/wrangler.json, ONE environment flattened.
const configPath = join(dir, 'dist/server/wrangler.json');
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null;
if (!config) {
  fail(`${configPath} is missing (was this a BUILD_TARGET=cloudflare build?)`);
} else {
  const name = `classmoji-site-${environment}`;
  if (config.name !== name) fail(`built for ${config.name}, not ${name} (CLOUDFLARE_ENV=${environment}?)`);

  const routes = JSON.stringify(config.routes ?? []);
  const expectedRoutes = environment === 'staging'
    ? JSON.stringify([{ pattern: 'site.staging.classmoji.io', custom_domain: true }])
    : '[]';
  if (routes !== expectedRoutes) fail(`routes are ${routes}, expected exactly ${expectedRoutes}`);
  if (config.route) fail(`a single "route" is set (${config.route}); only "routes" is expected`);
  if (config.workers_dev !== false) fail(`workers_dev is ${config.workers_dev}, expected false`);

  const limits = Object.fromEntries((config.ratelimits ?? []).map(r => [r.name, r.simple]));
  const expectedLimits = {
    CONTACT_RATE_LIMIT: { limit: 3, period: 60 },
    CONTACT_RATE_LIMIT_GLOBAL: { limit: 10, period: 60 },
  };
  for (const [binding, simple] of Object.entries(expectedLimits)) {
    if (JSON.stringify(limits[binding]) !== JSON.stringify(simple)) {
      fail(`ratelimit ${binding} is ${JSON.stringify(limits[binding])}, expected ${JSON.stringify(simple)}`);
    }
  }
  if (config.version_metadata?.binding !== 'CF_VERSION_METADATA') fail('no CF_VERSION_METADATA version_metadata binding');
  if (config.assets?.binding !== 'ASSETS') fail('no ASSETS binding (the adapter should inject it)');
  // `session: false` and `imageService: 'compile'` keep the adapter from
  // adding these; a KV namespace would be provisioned on the first deploy.
  if (config.kv_namespaces?.length) fail(`unexpected kv_namespaces: ${config.kv_namespaces.map(k => k.binding).join(', ')}`);
  if (config.images) fail(`unexpected images binding: ${config.images.binding}`);
  if (!(config.compatibility_flags ?? []).includes('nodejs_compat')) fail('nodejs_compat is not set');
}

// dist/client/_headers: the adapter's immutable rule for hashed assets, and
// on staging the noindex rule for every file.
const headersPath = join(dir, 'dist/client/_headers');
const headers = existsSync(headersPath) ? readFileSync(headersPath, 'utf8') : '';
if (!/^\/_astro\/\*\s*\n\s+Cache-Control: public, max-age=31536000, immutable/m.test(headers)) {
  fail(`${headersPath} has no immutable /_astro/* rule`);
}
const noindex = /^\/\*\s*\n\s+X-Robots-Tag: noindex\s*$/m.test(headers);
if (environment === 'staging' && !noindex) fail(`${headersPath} has no "/*  X-Robots-Tag: noindex" rule`);
if (environment !== 'staging' && noindex) fail(`${headersPath} has the staging noindex rule in a ${environment} build`);

// Nothing server-side among the public files.
for (const name of ['wrangler.json', '.dev.vars', 'server']) {
  if (existsSync(join(dir, 'dist/client', name))) fail(`dist/client/${name} would be served publicly`);
}

// The build reads GITHUB_TOKEN (the star count in the header); its value must
// not end up in the output.
const files = [];
const walk = path => {
  for (const entry of readdirSync(path)) {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
};
walk(join(dir, 'dist'));
for (const secretName of ['GITHUB_TOKEN', 'GH_TOKEN']) {
  const value = process.env[secretName]?.trim();
  if (!value) continue;
  const leaked = files.filter(file => readFileSync(file).includes(value));
  if (leaked.length) fail(`the ${secretName} value appears in ${leaked.length} built file(s), e.g. ${leaked[0]}`);
}

if (problems.length) {
  for (const problem of problems) console.error(`::error::check-build: ${problem}`);
  process.exit(1);
}
console.log(
  `check-build: ${config.name} OK (${files.length} files; routes ${JSON.stringify(config.routes ?? [])}; ` +
    `rate limits and version metadata bound; _headers ${environment === 'staging' ? 'with' : 'without'} noindex).`,
);
