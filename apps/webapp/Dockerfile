# ======================
# Build stage
# ======================
FROM node:22-alpine AS build

WORKDIR /app

ENV NODE_OPTIONS="--max-old-space-size=2048"

COPY . .

RUN npm ci --legacy-peer-deps --no-audit --no-fund

# Fix lightningcss / tailwind oxide for Alpine (better to pin in repo long-term)
RUN npm install --no-save lightningcss @tailwindcss/oxide

# ✅ Generate Prisma client at build time (prevents "@prisma/client did not initialize yet")
RUN cd packages/database && npx prisma generate

# Build the web app
RUN npx turbo run web:build


# ======================
# Production stage
# ======================
FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

COPY --from=build /app/apps/webapp/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/package-lock.json ./
COPY --from=build /app/turbo.json ./
COPY --from=build /app/packages ./packages

ENV PORT=8080
ENV HOST=0.0.0.0
ENV NODE_ENV=production

# ✅ Start server ONLY (no migrations here)
CMD ["npx", "react-router-serve", "build/server/index.js"]