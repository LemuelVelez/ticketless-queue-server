# ---- Dependencies (includes dev deps for TypeScript build) ----
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# ---- Build (compile TS -> dist) ----
FROM node:20-alpine AS builder
WORKDIR /app

# ✅ npm needs package.json to run scripts
COPY package.json package-lock.json* ./

COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src

# ✅ your build script is: "tsc -p tsconfig.json"
RUN npm run build

# ---- Runtime (only prod deps + compiled dist) ----
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