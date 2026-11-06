# Build stage for Astro
FROM node:24-alpine AS build

WORKDIR /app

# One npm everywhere, the packageManager one (10.9.9), as in CI and the
# lockfile check. Node 24 bundles npm 11, which writes `libc` fields into
# lockfile entries it re-resolves and warns about dependency install scripts.
RUN npm install -g npm@10.9.9 --no-audit --no-fund --cache=/tmp/npm-self-cache \
    && rm -rf /tmp/npm-self-cache

COPY package*.json .npmrc ./
RUN npm install

COPY . .
# The docs theme downloads its fonts during the build, and Astro only warns
# when that fails. Fail the image build instead of shipping docs without them.
# The build output is printed either way.
RUN npm run build > /tmp/site-build.log 2>&1; status=$?; \
    cat /tmp/site-build.log; \
    if [ "$status" -ne 0 ]; then exit "$status"; fi; \
    if grep -q "No data found for font family" /tmp/site-build.log; then \
      echo "The docs fonts could not be downloaded; failing the build." >&2; exit 1; \
    fi; \
    rm /tmp/site-build.log

# Production stage: Astro's Node server. Pages are pre-built files it serves
# as-is; only /api/contact runs code (it needs RESEND_API_KEY to send).
# src/middleware.ts turns off the unused image and island routes.
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Fly.io sets PORT; HOST binds to 0.0.0.0 for external access.
ENV HOST=0.0.0.0
CMD ["node", "dist/server/entry.mjs"]
