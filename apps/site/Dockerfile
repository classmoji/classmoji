# Build stage for Astro
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

RUN npm install -g serve

COPY --from=build /app/dist ./dist

# Fly.io sets PORT env var, bind to 0.0.0.0 for external access
CMD ["sh", "-c", "serve dist -l tcp://0.0.0.0:${PORT:-3000}"]
