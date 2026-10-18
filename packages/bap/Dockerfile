# Stage 1: Dependencies (cached layer)
FROM node:20-alpine AS deps

RUN apk add --no-cache openssl

WORKDIR /app

# Copy only package files first for better caching
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY packages/bap/package*.json ./packages/bap/

# Create dummy web workspace
RUN mkdir -p packages/web
RUN echo '{"name":"@p2p/web","version":"1.0.0","private":true}' > packages/web/package.json

# Install dependencies
RUN npm ci --ignore-scripts

# Stage 2: Build
FROM deps AS builder

WORKDIR /app

# Copy tsconfig
COPY tsconfig.base.json ./

# Copy source files
COPY packages/shared ./packages/shared
COPY packages/bap ./packages/bap

# Generate Prisma client
RUN npx prisma generate --schema=./packages/shared/prisma/schema.prisma

# Build shared then bap
RUN npm run build --workspace=@p2p/shared
RUN npm run build --workspace=@p2p/bap

# Fix shared package.json for production
RUN cd packages/shared && \
    sed -i 's|"main": "src/index.ts"|"main": "dist/index.js"|' package.json && \
    sed -i 's|"types": "src/index.ts"|"types": "dist/index.d.ts"|' package.json

# Copy Prisma generated client to dist
RUN cp -r packages/shared/src/generated packages/shared/dist/generated

# Stage 3: Production (slim final image)
FROM node:20-alpine AS runner

RUN apk add --no-cache openssl

WORKDIR /app

# Copy only what's needed for production
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/bap/package.json ./packages/bap/

# Create dummy web workspace
RUN mkdir -p packages/web
RUN echo '{"name":"@p2p/web","version":"1.0.0","private":true}' > packages/web/package.json

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts

# Copy built artifacts
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/bap/dist ./packages/bap/dist
COPY --from=builder /app/packages/shared/prisma ./packages/shared/prisma
# Copy Prisma generated client (compiled code references src/generated path)
COPY --from=builder /app/packages/shared/src/generated ./packages/shared/src/generated
# @prisma runtime is needed for Prisma to work
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

EXPOSE 4000

ENV NODE_ENV=production
ENV PORT=4000

CMD ["sh", "-c", "npx prisma db push --schema=./packages/shared/prisma/schema.prisma --skip-generate && node packages/bap/dist/bap/src/index.js"]
