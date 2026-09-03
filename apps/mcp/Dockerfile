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
COPY apps/ai-agent/package.jso[n] apps/ai-agent/
COPY apps/hook-station/package.json apps/hook-station/
COPY apps/mcp/package.json apps/mcp/
COPY apps/pages/package.json apps/pages/
COPY apps/site/package.json apps/site/
COPY apps/slides/package.json apps/slides/
COPY apps/webapp/package.json apps/webapp/
COPY packages/auth/package.json packages/auth/
COPY packages/content/package.json packages/content/
COPY packages/database/package.json packages/database/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/services/package.json packages/services/
COPY packages/tasks/package.json packages/tasks/
COPY packages/ui-components/package.json packages/ui-components/
COPY packages/utils/package.json packages/utils/

RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps --no-audit --no-fund

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
COPY --from=build /app/apps/mcp ./apps/mcp

# S8: ENABLE_TEST_LOGIN must NEVER be set in deploy config — the dev
# token-mint endpoint is double-gated on NODE_ENV=development AND
# ENABLE_TEST_LOGIN=true, and CI (mcp-devmint-guard) enforces its absence here.
ENV MCP_PORT=8100
ENV NODE_ENV=production

CMD ["node", "--experimental-strip-types", "apps/mcp/src/index.ts"]
