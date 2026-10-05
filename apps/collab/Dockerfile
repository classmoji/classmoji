# syntax=docker/dockerfile:1.7
# ======================
# Build stage
# ======================
FROM node:22-alpine AS build

WORKDIR /app

ENV NODE_OPTIONS="--max-old-space-size=2048"

# Manifests only, so the npm ci layer stays cached until deps actually change.
COPY package.json package-lock.json .npmrc ./
COPY apps/admin/package.json apps/admin/
COPY apps/collab/package.json apps/collab/
COPY apps/ai-agent/package.jso[n] apps/ai-agent/
COPY apps/content/package.json apps/content/
COPY apps/hook-station/package.json apps/hook-station/
COPY apps/mcp/package.json apps/mcp/
COPY apps/pages/package.json apps/pages/
COPY apps/site/package.json apps/site/
COPY apps/slides/package.json apps/slides/
COPY apps/webapp/package.json apps/webapp/
COPY packages/auth/package.json packages/auth/
COPY packages/collab/package.json packages/collab/
COPY packages/content/package.json packages/content/
COPY packages/content-signing/package.json packages/content-signing/
COPY packages/database/package.json packages/database/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/page-schema/package.json packages/page-schema/
COPY packages/services/package.json packages/services/
COPY packages/tasks/package.json packages/tasks/
COPY packages/ui-components/package.json packages/ui-components/
COPY packages/utils/package.json packages/utils/

# Keep the Docker install layer cached, but use a fresh npm download cache on
# a cache miss. Unpacking the populated cache exhausted the 4 GB build host.
RUN NODE_OPTIONS=--max-old-space-size=1024 npm ci --legacy-peer-deps --no-audit --no-fund \
    --maxsockets=5 --cache=/tmp/npm-ci-cache \
    && rm -rf /tmp/npm-ci-cache

# Generate Prisma client at build time
COPY packages/database/schema.prisma packages/database/
RUN ./node_modules/.bin/prisma generate --schema packages/database/schema.prisma

COPY . .


# ======================
# Production stage
# ======================
FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/package-lock.json ./
COPY --from=build /app/turbo.json ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/collab ./apps/collab

# Must match internal_port in apps/collab/fly.toml.
ENV COLLAB_PORT=7700
ENV NODE_ENV=production

# Same command as `npm run collab:start`, but node runs as PID 1 instead of
# npm: SIGTERM has to reach Hocuspocus directly so it can flush the pending
# document stores before the machine stops (see kill_timeout in fly.toml).
CMD ["node", "--experimental-strip-types", "apps/collab/src/index.ts"]
