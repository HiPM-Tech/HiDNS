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

# Build server (backend) —— 同时产出单文件 bundle，生产镜像因此不需要 node_modules
RUN pnpm --filter dnsmgr-server run build:bundle

# 提供商图标：运行时按文件路径读取，无法内联。
# dist 里同目录还有大量已 bundle 的 .js/.map，只挑图片资源，避免把它们也带进镜像。
RUN mkdir -p /app/server/dist-assets \
 && cd /app/server/dist/lib/dns/providers \
 && find . -type f \( -name '*.svg' -o -name '*.png' -o -name '*.ico' -o -name '*.jpg' -o -name '*.jpeg' \) -exec cp --parents {} /app/server/dist-assets/ \;

# Production stage
FROM node:24-alpine AS production

# Accept CI build flag from builder
ARG CI_BUILD=false

# 数据库客户端工具（DSM 备份功能依赖 CLI）
RUN apk add --no-cache mysql-client postgresql-client sqlite

# Create app directory
WORKDIR /app

# 服务端已打包成单文件（server/scripts/build-bundle.mjs），
# 22 个运行时依赖全部内联，因此这里不再安装 node_modules。
# 唯一需要留在文件系统的是 swagger-ui 的静态资源（浏览器直接加载的 html/js/css）。
# 只保留 UMD 版与样式：swagger-ui-express 加载的是 swagger-ui-bundle.js，
# *.map 与 es-module 版在运行时用不到，删掉可省约 9 MB
# 锁定精确版本：bundle 里唯一的外部 require 是 swagger-ui-dist/absolute-path，
# 用 5.x 浮动版本一旦上游改名，镜像会在启动时 MODULE_NOT_FOUND，且无法本地复现。
RUN npm init -y >/dev/null && npm install --no-save --omit=dev --no-package-lock swagger-ui-dist@5.32.1 \
 && cd node_modules/swagger-ui-dist \
 && rm -f *.map swagger-ui-es-*.js \
 && cd /app \
 && rm -f package.json package-lock.json

# 单文件服务端
COPY --from=builder /app/server/dist-bundle/app.cjs ./app.cjs

# 提供商图标（仅图片，见 builder 阶段的 dist-assets）
COPY --from=builder /app/server/dist-assets ./dist/lib/dns/providers

# 公共后缀快照：运行时按路径读取，无法内联（缺失会退化成 curated 列表）
COPY --from=builder /app/server/dist-bundle/data ./dist/data

# 嵌入式客户端（SEA 构建时使用；普通镜像走 client/dist 静态目录）
COPY --from=builder /app/server/dist/embedded-client.js* ./dist/

# Copy built client files from builder
COPY --from=builder /app/client/dist ./client/dist

# Create data directory for persistent storage
RUN mkdir -p /app/data

# Expose port
EXPOSE 3001

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001
# V8 堆上限：显式设定，避免容器里按物理内存估算（宿主机 32G、容器限 1G 时会严重误判，
# 结果是堆一路涨到被 cgroup 杀掉，而不是提前做完整 GC）。
# 默认 1024：本项目最大的内存路径是 grouped 视图（超管全表物化 + 解析缓存），
# 512 在中等规模实例上就可能触发「JavaScript heap out of memory」。
# 容器内存受限时按「上限的 ~70%」覆盖，例如 768M 容器：-e NODE_OPTIONS="--max-old-space-size=512"。
#
# 没有把 --max-semi-space-size 调大：CI 的 GC 基准（scripts/gc-bench.mjs，30 万次迭代）显示
# 默认参数 482599 ops/s、semi=32 时 466711 ops/s（-3.3%），RSS 也没有下降。
# 这条基准覆盖的是「分配密集、对象短命」的路径，也就是本服务最典型的请求处理形态。
ENV NODE_OPTIONS="--max-old-space-size=1024"
ENV CI_BUILD=${CI_BUILD}
# 构建指纹：CI 传入 commit，启动横幅与日志会打印，便于确认实例跑的是哪个提交
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
# 单文件镜像里没有 package.json，版本由构建期注入（否则启动横幅是 unknown）
ARG APP_VERSION=unknown
ENV HIDNS_BUILD_SHA=${GIT_SHA}
ENV HIDNS_BUILD_TIME=${BUILD_TIME}
ENV HIDNS_BUILD_VERSION=${APP_VERSION}
# 生产镜像默认 info：稳态日志量可控。
# 排查现场时用 -e HIDNS_LOG_LEVEL=debug 覆盖即可，无需重建镜像。
# CI 自身的构建/测试日志由 release.yml 的 workflow 级 env 设为 debug，两者互不影响。
ENV HIDNS_LOG_LEVEL=info

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/api/init/status', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the server (which also serves the frontend)
CMD ["node", "app.cjs"]
