# Build stage for Astro
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json .npmrc ./
RUN npm install

COPY . .
RUN npm run build

# Production stage: Astro's Node server. Pages are pre-built files it serves
# as-is; only /api/contact runs code. It needs RESEND_API_KEY to send.
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Fly.io sets PORT; HOST binds to 0.0.0.0 for external access.
ENV HOST=0.0.0.0
CMD ["node", "dist/server/entry.mjs"]
