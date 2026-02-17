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

# Build the slides app
RUN npx turbo run slides:build


# ======================
# Production stage
# ======================
FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

COPY --from=build /app/apps/slides/build ./apps/slides/build
COPY --from=build /app/apps/slides/server.ts ./apps/slides/server.ts
COPY --from=build /app/apps/slides/package.json ./apps/slides/package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/package-lock.json ./
COPY --from=build /app/turbo.json ./
COPY --from=build /app/packages ./packages

WORKDIR /app/apps/slides

ENV PORT=8080
ENV HOST=0.0.0.0
ENV NODE_ENV=production

# Start using Node's experimental TypeScript support
CMD ["node", "--experimental-strip-types", "server.ts"]
