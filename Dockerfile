# ---- Dependencies (includes dev deps for TypeScript build) ----
FROM node:20-alpine AS deps
WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci

# ---- Build (compile TS -> dist) ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src

# Your package.json "build" is: tsc -p tsconfig.json
# But your "start" expects dist/index.js.
# So we pass CLI flags to force output into /dist without changing your repo files.
RUN npm run build -- --outDir dist --rootDir src

# ---- Runtime (only prod deps + compiled dist) ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Create non-root user
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs

# Install only production deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output
COPY --from=builder /app/dist ./dist

# If you have other runtime files (views/templates/public/etc), copy them here as needed:
# COPY --from=builder /app/public ./public

USER nodejs

EXPOSE 3000

# Optional healthcheck (enable if you want Coolify to use container health)
# HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
#   CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/'},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]