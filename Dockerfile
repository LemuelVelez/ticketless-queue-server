# 1) Install dependencies (including dev deps for build)
FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# 2) Build TypeScript
FROM node:20-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src

# Compile TS -> dist
RUN npx tsc -p tsconfig.json --outDir dist

# 3) Production image
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

COPY --from=build /app/dist ./dist

RUN chown -R node:node /app

EXPOSE 5000
USER node

CMD ["node", "dist/index.js"]
