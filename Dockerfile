# Multi-stage build for DNSMgr (Frontend + Backend in one image)
FROM node:24-alpine AS builder

# Accept CI build flag
ARG CI_BUILD=false

# Install pnpm
RUN npm install -g pnpm

# Set working directory
WORKDIR /app

# Copy root package files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy server package files
COPY server/package.json server/.npmrc ./server/

# Copy client package files  
COPY client/package.json ./client/

# Install all dependencies (including devDependencies for build)
RUN pnpm install --no-frozen-lockfile

# Copy source code
COPY . .

# Build client (frontend)
RUN pnpm --filter dnsmgr-client build

# Build server (backend)
RUN pnpm --filter dnsmgr-server build

# Production stage
FROM node:24-alpine AS production

# Accept CI build flag from builder
ARG CI_BUILD=false

# Install pnpm and database client tools for DSM backups
RUN npm install -g pnpm && \
    apk add --no-cache mysql-client postgresql-client sqlite

# Create app directory
WORKDIR /app

# Copy root package files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy server package files
COPY server/package.json server/.npmrc ./server/

# Install production dependencies only
RUN pnpm install --no-frozen-lockfile --prod

# Copy built server files from builder
COPY --from=builder /app/server/dist ./server/dist

# Copy server scripts
COPY --from=builder /app/server/scripts ./server/scripts

# Copy built client files from builder
COPY --from=builder /app/client/dist ./client/dist

# Create data directory for persistent storage
RUN mkdir -p /app/data

# Expose port
EXPOSE 3001

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001
ENV CI_BUILD=${CI_BUILD}
# 构建指纹：CI 传入 commit，启动横幅与日志会打印，便于确认实例跑的是哪个提交
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV HIDNS_BUILD_SHA=${GIT_SHA}
ENV HIDNS_BUILD_TIME=${BUILD_TIME}
# 发布镜像默认 debug 日志（CI 构建的版本用于排查现场问题）；
# 生产稳态可用 -e HIDNS_LOG_LEVEL=info 覆盖，无需重建镜像。
ENV HIDNS_LOG_LEVEL=debug

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/api/init/status', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the server (which also serves the frontend)
CMD ["node", "server/dist/app.js"]
