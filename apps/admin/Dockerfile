# ======================
# Build stage
# ======================
FROM node:22-alpine AS build

WORKDIR /app

ENV NODE_OPTIONS="--max-old-space-size=2048"

COPY . .

RUN npm ci --legacy-peer-deps --no-audit --no-fund

# Fix lightningcss / tailwind oxide for Alpine
RUN npm install --no-save lightningcss @tailwindcss/oxide

# Generate Prisma client at build time
RUN cd packages/database && npx prisma generate

# Build the admin app
RUN npx turbo run admin:build


# ======================
# Production stage
# ======================
FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

COPY --from=build /app/apps/admin/build ./apps/admin/build
COPY --from=build /app/apps/admin/server.ts ./apps/admin/server.ts
# The server/ directory is NOT optional: server.ts loads ./server/app.ts, and an
# image shipped without it crash-loops at boot with ERR_MODULE_NOT_FOUND while
# the deploy job still reads green. apps/pages learned this the hard way.
COPY --from=build /app/apps/admin/server ./apps/admin/server
COPY --from=build /app/apps/admin/package.json ./apps/admin/package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/package-lock.json ./
COPY --from=build /app/turbo.json ./
COPY --from=build /app/packages ./packages

WORKDIR /app/apps/admin

ENV PORT=8080
ENV HOST=0.0.0.0
ENV NODE_ENV=production

# Start using Node's experimental TypeScript support
CMD ["node", "--experimental-strip-types", "server.ts"]
