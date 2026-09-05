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

RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps --no-audit --no-fund

# Fix lightningcss / tailwind oxide for Alpine
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-save lightningcss @tailwindcss/oxide

# Generate Prisma client at build time
COPY packages/database/schema.prisma packages/database/
RUN ./node_modules/.bin/prisma generate --schema packages/database/schema.prisma

COPY . .

# Build the pages app
RUN npx turbo run pages:build


# ======================
# Production stage
# ======================
FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

COPY --from=build /app/node_modules ./node_modules

COPY --from=build /app/apps/pages/build ./apps/pages/build
COPY --from=build /app/apps/pages/server.ts ./apps/pages/server.ts
# server.ts imports from server/ (the site-host middleware) — skipping this
# directory crash-loops the app at boot with ERR_MODULE_NOT_FOUND.
COPY --from=build /app/apps/pages/server ./apps/pages/server
COPY --from=build /app/apps/pages/package.json ./apps/pages/package.json
COPY --from=build /app/package.json ./
COPY --from=build /app/package-lock.json ./
COPY --from=build /app/turbo.json ./
COPY --from=build /app/packages ./packages

WORKDIR /app/apps/pages

ENV PORT=8080
ENV HOST=0.0.0.0
ENV NODE_ENV=production

# Start using Node's experimental TypeScript support
CMD ["node", "--experimental-strip-types", "server.ts"]
