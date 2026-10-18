FROM node:20-alpine AS base

# Dependencies stage
FROM base AS deps
WORKDIR /app

# Copy root package files
COPY package*.json ./

# Copy web package
COPY packages/web/package*.json ./packages/web/

# Create dummy package.json for other workspaces to satisfy npm
RUN mkdir -p packages/shared packages/bap
RUN echo '{"name":"@p2p/shared","version":"1.0.0"}' > packages/shared/package.json
RUN echo '{"name":"@p2p/bap","version":"1.0.0"}' > packages/bap/package.json

# Install dependencies
RUN npm ci --ignore-scripts

# Build stage
FROM base AS builder
WORKDIR /app

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules

# Copy source files
COPY package*.json ./
COPY packages/web ./packages/web

# Create dummy workspaces
RUN mkdir -p packages/shared packages/bap
RUN echo '{"name":"@p2p/shared","version":"1.0.0"}' > packages/shared/package.json
RUN echo '{"name":"@p2p/bap","version":"1.0.0"}' > packages/bap/package.json

# Build-time environment variables
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID

ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID
ENV NEXT_TELEMETRY_DISABLED=1

# Build the app
RUN npm run build --workspace=@p2p/web

# Production stage
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy public assets
COPY --from=builder /app/packages/web/public ./packages/web/public

# Copy standalone build
COPY --from=builder --chown=nextjs:nodejs /app/packages/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/packages/web/.next/static ./packages/web/.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "packages/web/server.js"]
