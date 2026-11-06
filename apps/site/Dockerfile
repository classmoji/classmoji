# Build stage for Astro
FROM node:24-alpine AS build

WORKDIR /app

# Same npm as CI and the lockfile check (packageManager npm@10.9.9): the npm
# bundled with Node 24 (11.x) handles dependency install scripts differently.
RUN npm install -g npm@10.9.9 --no-audit --no-fund --cache=/tmp/npm-self-cache \
    && rm -rf /tmp/npm-self-cache

COPY package*.json .npmrc ./
RUN npm install

COPY . .
RUN npm run build

# Production stage: Astro's Node server. Pages are pre-built files it serves
# as-is; only /api/contact runs code. It needs RESEND_API_KEY to send.
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Fly.io sets PORT; HOST binds to 0.0.0.0 for external access.
ENV HOST=0.0.0.0
CMD ["node", "dist/server/entry.mjs"]
