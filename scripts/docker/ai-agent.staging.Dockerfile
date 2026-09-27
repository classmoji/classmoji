# syntax=docker/dockerfile:1.7
# Staging override for the private ai-agent submodule; keep its runtime stage in sync.
# ======================
# Build stage
# ======================
FROM node:22-alpine AS build

WORKDIR /app

ENV NODE_OPTIONS="--max-old-space-size=2048"

# Manifests only, so the npm ci layer stays cached until deps actually change.
COPY package.json package-lock.json .npmrc ./
COPY apps/admin/package.json apps/admin/
COPY apps/ai-agent/package.jso[n] apps/ai-agent/
COPY apps/content/package.json apps/content/
COPY apps/hook-station/package.json apps/hook-station/
COPY apps/mcp/package.json apps/mcp/
COPY apps/pages/package.json apps/pages/
COPY apps/site/package.json apps/site/
COPY apps/slides/package.json apps/slides/
COPY apps/webapp/package.json apps/webapp/
COPY packages/auth/package.json packages/auth/
COPY packages/content/package.json packages/content/
COPY packages/content-signing/package.json packages/content-signing/
COPY packages/database/package.json packages/database/
COPY packages/eslint-config/package.json packages/eslint-config/
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

# Drop everything the runtime stage does not run. This has to come AFTER
# `prisma generate`, because the prisma CLI is a devDependency.
#
# Nothing in the runtime needs a dev dependency: CMD is a plain `node`, not tsx,
# and apps/ai-agent/fly.toml has no release_command (only apps/webapp runs
# `prisma migrate deploy`, from its own image).
RUN npm prune --omit=dev

# The Agent SDK resolves its native executable through per-platform optional
# dependencies. None of them declares a `libc` field, so npm installs BOTH the
# glibc and the musl linux build (~210 MB each) — and on Alpine the glibc one
# cannot even relocate its symbols, so it is pure ballast. Drop every non-musl
# linux native, for whichever arch this image is built on, but only where the
# musl sibling is actually present so a surprise can never leave the SDK with no
# binary at all.
RUN if [ -f /etc/alpine-release ]; then \
      find . -type d -path '*/node_modules/@anthropic-ai/claude-agent-sdk-linux-*' \
        ! -name '*-musl' -prune -print \
      | while IFS= read -r dir; do \
          if [ -d "${dir}-musl" ]; then echo "removing wrong-libc native: ${dir}"; rm -rf "${dir}"; \
          else echo "keeping ${dir}: no musl sibling to fall back on"; fi; \
        done; \
    fi

COPY . .


# ======================
# Production stage
# ======================
FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache openssl libc6-compat git

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/package-lock.json ./
COPY --from=build /app/turbo.json ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/ai-agent ./apps/ai-agent

CMD ["node", "apps/ai-agent/src/index.js"]
