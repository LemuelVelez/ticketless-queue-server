# ---- Dependencies (force dev deps even if Coolify sets NODE_ENV=production at buildtime) ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --include=dev

# ---- Build ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src

# ✅ Force output to /app/dist (overrides tsconfig outDir)
RUN npm run build -- --outDir dist --rootDir src

# ---- Runtime ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S nodejs && adduser -S nodejs -G nodejs

# Install prod deps, then add only what you need to manually run TS scripts (migrate/seed)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev \
  && npm install --no-save ts-node typescript \
  && npm cache clean --force

# Needed for: npm run migrate (ts-node uses tsconfig + src)
COPY tsconfig.json ./
COPY src ./src

# App runtime build
COPY --from=builder /app/dist ./dist

USER nodejs
EXPOSE 3000
CMD ["node", "dist/index.js"]