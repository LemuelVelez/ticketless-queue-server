# ---- Dependencies (force dev deps even if Coolify sets NODE_ENV=production at buildtime) ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --include=dev

# ---- Build ----
FROM node:20-alpine AS builder
WORKDIR /app

# npm needs package.json to run scripts, and we want predictable dist output
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

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER nodejs
EXPOSE 3000
CMD ["node", "dist/index.js"]