# ======================
# Build stage
# ======================
FROM node:22-alpine AS build

WORKDIR /app

ENV NODE_OPTIONS="--max-old-space-size=2048"

COPY . .

RUN npm ci --legacy-peer-deps --no-audit --no-fund

# Generate Prisma client at build time
RUN cd packages/database && npx prisma generate


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
COPY --from=build /app/apps/hook-station ./apps/hook-station

ENV PORT=8080
ENV HOST=0.0.0.0
ENV NODE_ENV=production

CMD ["node", "apps/hook-station/src/index.js"]
