#!/bin/sh
# Local Cloudflare Workers build of the site (`npm run build:cf` in apps/site).
#
# The Cloudflare packages are installed by install.sh into a STANDALONE copy
# (see there for why), so this copies apps/site to a work directory outside
# the repo, installs, builds for CLOUDFLARE_ENV (default: dev), checks the
# output, and copies dist/ back into apps/site. Then, from apps/site (the
# root's wrangler is the same version):
#
#   npx wrangler dev -c dist/server/wrangler.json --port 8787
#
# SITE_CF_WORKDIR=<dir> reuses a work directory between runs (its
# node_modules is kept). A secret for `wrangler dev` (RESEND_API_KEY, to send
# for real) goes in dist/server/.dev.vars, next to the config wrangler runs;
# a rebuild removes it.
set -eu

SITE="$(cd "$(dirname "$0")/.." && pwd -P)"
WORK="${SITE_CF_WORKDIR:-$(mktemp -d)/site}"
CLOUDFLARE_ENV="${CLOUDFLARE_ENV:-dev}"
export CLOUDFLARE_ENV

mkdir -p "$WORK"
# node_modules, build output and wrangler state stay out (and, being
# excluded, a reused work directory keeps its own).
rsync -a --delete --exclude node_modules --exclude dist --exclude .astro --exclude .wrangler "$SITE"/ "$WORK"/

"$SITE/cloudflare/install.sh" "$WORK"
(cd "$WORK" && rm -rf dist && BUILD_TARGET=cloudflare npx astro build)
node "$SITE/cloudflare/check-build.mjs" "$WORK" "$CLOUDFLARE_ENV"

rm -rf "$SITE/dist"
cp -R "$WORK/dist" "$SITE/dist"
echo "build.sh: built for $CLOUDFLARE_ENV in $WORK and copied dist/ to $SITE/dist"
