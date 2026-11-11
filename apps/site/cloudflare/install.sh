#!/bin/sh
# Installs what the Cloudflare Workers build of the site needs, into a
# STANDALONE copy of apps/site (never the repo checkout: `npm install` inside
# apps/site there acts on the workspace root and its lockfile).
#
#   apps/site/cloudflare/install.sh <copy of apps/site>
#
# The Fly image (apps/site/Dockerfile) installs package.json alone. The
# Cloudflare packages are NOT in package.json: there they would ship in the Fly
# image's node_modules, and in the monorepo install they dedupe to the root's
# copies, which resolve the root's vite 6 instead of the site's vite 8. So
# they go on top of the plain install with --no-save, and these pins are the
# only place their versions live (CI's deploy-site-worker job calls this
# script; build.sh calls it for local builds).
#
# The three move together: @astrojs/cloudflare 14.4.4 is the release paired
# with astro 7.4.5 whose @cloudflare/vite-plugin range (^1.63.1) admits 1.65.0,
# which pins exactly wrangler 4.152.0, the root's (apps/admin's) version. A
# newer adapter pulls a newer vite plugin and with it a second wrangler and
# workerd. Every pin must also predate the `before=` date in apps/site/.npmrc,
# which this install respects.
set -eu

ADAPTER=@astrojs/cloudflare@14.4.4
VITE_PLUGIN=@cloudflare/vite-plugin@1.65.0
WRANGLER=wrangler@4.152.0

DIR="${1:?usage: install.sh <standalone copy of apps/site>}"
cd "$DIR"

[ -f package.json ] && [ -f astro.config.mjs ] || { echo "install.sh: $DIR is not a copy of apps/site" >&2; exit 1; }
# A workspace root above the copy would turn `npm install` into a workspace
# install (and rewrite its lockfile).
case "$(cd "$DIR" && pwd -P)/" in
  "$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)"/*)
    echo "install.sh: $DIR is inside the repo checkout; copy apps/site somewhere else first" >&2; exit 1 ;;
esac

# The packageManager npm (10.9.9), as in the Dockerfile and CI.
if [ "$(npm --version)" = "10.9.9" ]; then NPM="npm"; else NPM="npx --yes npm@10.9.9"; fi

# No install scripts: nothing the build or `wrangler dev` uses needs one
# (workerd and sharp ship their binaries as optional platform packages).
$NPM install --ignore-scripts --no-audit --no-fund
$NPM install --no-save --ignore-scripts --no-audit --no-fund "$ADAPTER" "$VITE_PLUGIN" "$WRANGLER"

$NPM ls wrangler @cloudflare/vite-plugin vite @astrojs/cloudflare astro workerd miniflare

# One copy of each, and the vite plugin on the site's vite 8: a second
# wrangler/workerd or the root's vite 6 is the failure this script exists to
# prevent, so stop here instead of building with it.
node --input-type=module -e '
  import { readdirSync, readFileSync, existsSync } from "node:fs";
  import { join } from "node:path";
  const versions = new Map();
  const walk = dir => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.name.startsWith("@")) { walk(join(dir, entry.name)); continue; }
      const pkgDir = join(dir, entry.name);
      const manifest = join(pkgDir, "package.json");
      if (existsSync(manifest)) {
        const { name, version } = JSON.parse(readFileSync(manifest, "utf8"));
        if (name) versions.set(name, [...(versions.get(name) ?? []), `${version} (${pkgDir})`]);
      }
      walk(join(pkgDir, "node_modules"));
    }
  };
  walk("node_modules");
  const fail = message => { console.error(`install.sh: ${message}`); process.exit(1); };
  for (const name of ["wrangler", "workerd", "miniflare", "@cloudflare/vite-plugin", "@astrojs/cloudflare", "vite", "astro"]) {
    const found = versions.get(name) ?? [];
    if (found.length !== 1) fail(`expected one ${name}, found ${found.length}: ${found.join(", ") || "none"}`);
  }
  const vite = versions.get("vite")[0];
  if (!vite.startsWith("8.")) fail(`vite is ${vite}, not vite 8 (the version the site pins)`);
  console.log(`install.sh: one copy each of wrangler, workerd, miniflare, the vite plugin, the adapter, astro, and vite ${vite.split(" ")[0]}.`);
'
