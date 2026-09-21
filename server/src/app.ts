// Load environment variables FIRST, before any other imports
// This ensures JWT_SECRET and other env vars are available during module initialization
import { loadEnv } from './config/env';
loadEnv();

// 未配置数据库时使用临时内存数据库，避免在引导前生成实际的 SQLite 文件
if (!process.env.DB_TYPE && !process.env.DB_PATH) {
  process.env.DB_PATH = ':memory:';
  process.env._TEMP_DB = '1';
}

// 解析 SEA 二进制 CLI 参数
// 支持: -l <log_level> -p <port> -i install|uninstall -u on|off
(function parseSeaArgs() {
  const args = process.argv.slice(2);

  // 先扫描 -u 参数（默认 on），确保 -i 也能获取
  let autoUpdate = 'on';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-u' && i + 1 < args.length) {
      const val = args[i + 1];
      if (val === 'on' || val === 'off') {
        autoUpdate = val;
      }
      break;
    }
  }
  process.env.HIDNS_AUTO_UPDATE = autoUpdate === 'on' ? 'true' : 'false';

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-p' || args[i] === '--port') && i + 1 < args.length) {
      process.env.PORT = args[++i];
    } else if ((args[i] === '-l' || args[i] === '--log-level') && i + 1 < args.length) {
      process.env.HIDNS_LOG_LEVEL = args[++i];
    } else if (args[i] === '-u' && i + 1 < args.length) {
      // 已在前置扫描中处理，跳过值
      i++;
    } else if (args[i] === '-i' && i + 1 < args.length) {
      const action = args[++i];
      if (action === 'install' || action === 'uninstall') {
        const { execSync } = require('child_process');
        const binPath = process.execPath;
        const platform = process.platform;

        // 从全部参数中收集 -l、-p、-u，确保服务启动时带上
        const serviceArgs: string[] = [];
        const allArgs = process.argv.slice(2);
        for (let j = 0; j < allArgs.length; j++) {
          const a = allArgs[j];
          if ((a === '-p' || a === '--port') && j + 1 < allArgs.length) {
            serviceArgs.push(a, allArgs[++j]);
          } else if ((a === '-l' || a === '--log-level') && j + 1 < allArgs.length) {
            serviceArgs.push(a, allArgs[++j]);
          } else if (a === '-u' && j + 1 < allArgs.length) {
            serviceArgs.push(a, allArgs[++j]);
          }
        }
        // 未指定 -u 时默认追加 -u on
        if (!serviceArgs.includes('-u')) {
          serviceArgs.push('-u', 'on');
        }
        const argsStr = serviceArgs.length > 0 ? ' ' + serviceArgs.join(' ') : '';

        if (action === 'install') {
          if (platform === 'win32') {
            console.log('📦 Installing HiDNS Windows Service...');
            try {
              const quotedBinPath = `"${binPath}${argsStr}"`;
              execSync(`sc create "HiDNS" binPath= ${quotedBinPath} displayName= "HiDNS Manager" start= auto`, { stdio: 'inherit' });
              execSync(`sc description "HiDNS" "DNS Aggregation Management Platform"`, { stdio: 'inherit' });
              execSync(`sc failure "HiDNS" reset= 86400 actions= restart/5000/restart/10000/restart/30000`, { stdio: 'inherit' });
              console.log('🚀 Starting HiDNS service...');
              execSync(`sc start "HiDNS"`, { stdio: 'inherit' });
              console.log('✅ HiDNS service installed and started successfully.');
              console.log(`ℹ️  Binary: ${binPath}${argsStr}`);
            } catch (err: any) {
              console.error('❌ Failed to install service:', err.message);
            }
          } else if (platform === 'linux') {
            console.log('📦 Installing HiDNS Linux Systemd Service...');
            try {
              const unit = `[Unit]
Description=HiDNS Manager
After=network.target

[Service]
Type=simple
ExecStart=${binPath}${argsStr}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
              execSync(`cat > /etc/systemd/system/hidns.service << 'SERVICEEOF'\n${unit}\nSERVICEEOF`, { stdio: 'inherit' });
              execSync('systemctl daemon-reload', { stdio: 'inherit' });
              execSync('systemctl enable hidns', { stdio: 'inherit' });
              console.log('🚀 Starting HiDNS service...');
              execSync('systemctl start hidns', { stdio: 'inherit' });
              console.log('✅ HiDNS service installed and started successfully.');
              console.log(`ℹ️  Binary: ${binPath}${argsStr}`);
            } catch (err: any) {
              console.error('❌ Failed to install service:', err.message);
            }
          } else if (platform === 'darwin') {
            console.log('📦 Installing HiDNS macOS Launchd Service...');
            try {
              const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hipm-tech.hidns</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binPath}</string>${serviceArgs.map(a => `\n    <string>${a}</string>`).join('')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/hidns.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/hidns.err</string>
</dict>
</plist>
`;
              const plistPath = process.env.HOME + '/Library/LaunchAgents/com.hipm-tech.hidns.plist';
              execSync(`mkdir -p "${process.env.HOME}/Library/LaunchAgents"`, { stdio: 'inherit' });
              // 写入 plist 文件（避免 heredoc 转义问题，用 node 写文件）
              execSync(`node -e "require('fs').writeFileSync('${plistPath}', ${JSON.stringify(plist)})"`, { stdio: 'inherit' });
              execSync(`launchctl load "${plistPath}"`, { stdio: 'inherit' });
              console.log('🚀 Starting HiDNS service...');
              execSync('launchctl start com.hipm-tech.hidns', { stdio: 'inherit' });
              console.log('✅ HiDNS service installed and started successfully.');
              console.log(`ℹ️  Binary: ${binPath}${argsStr}`);
            } catch (err: any) {
              console.error('❌ Failed to install service:', err.message);
            }
          } else {
            console.error(`❌ Unsupported platform: ${platform}`);
          }
        } else {
          if (platform === 'win32') {
            console.log('📦 Uninstalling HiDNS Windows Service...');
            try { execSync(`sc stop "HiDNS"`, { stdio: 'inherit' }); } catch { /* 服务可能未运行 */ }
            try {
              execSync(`sc delete "HiDNS"`, { stdio: 'inherit' });
              console.log('✅ HiDNS service uninstalled successfully.');
            } catch (err: any) {
              console.error('❌ Failed to uninstall service:', err.message);
            }
          } else if (platform === 'linux') {
            console.log('📦 Uninstalling HiDNS Linux Systemd Service...');
            try {
              execSync('systemctl stop hidns', { stdio: 'inherit' });
              execSync('systemctl disable hidns', { stdio: 'inherit' });
              execSync('rm -f /etc/systemd/system/hidns.service', { stdio: 'inherit' });
              execSync('systemctl daemon-reload', { stdio: 'inherit' });
              console.log('✅ HiDNS service uninstalled successfully.');
            } catch (err: any) {
              console.error('❌ Failed to uninstall service:', err.message);
            }
          } else if (platform === 'darwin') {
            console.log('📦 Uninstalling HiDNS macOS Launchd Service...');
            try {
              execSync('launchctl stop com.hipm-tech.hidns', { stdio: 'inherit' });
            } catch { /* 可能未运行 */ }
            try {
              const plistPath = process.env.HOME + '/Library/LaunchAgents/com.hipm-tech.hidns.plist';
              execSync(`launchctl unload "${plistPath}"`, { stdio: 'inherit' });
              execSync(`rm -f "${plistPath}"`, { stdio: 'inherit' });
              console.log('✅ HiDNS service uninstalled successfully.');
            } catch (err: any) {
              console.error('❌ Failed to uninstall service:', err.message);
            }
          } else {
            console.error(`❌ Unsupported platform: ${platform}`);
          }
        }
        process.exit(0);
      }
    }
  }
})();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { createSpaFallback } from './middleware/spaFallback';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import http from 'http';
import path from 'path';

// Get the current file directory
const APP_ROOT = path.resolve();
import { createConnection, isDbInitialized, hasUsers, connect } from './db/connection';
import { initializeDSM } from './db/dsm/init-dsm';
// import { initSchema } from './db/schema'; // Deprecated: Replaced by DSM
// import { initSchema as initSchemaWithMigration } from './db/init'; // Deprecated: Replaced by DSM
import { disconnect, getConnection } from './db/dal/connection';
import { authMiddleware, adminOnly } from './middleware/auth';
import { errorHandler, asyncHandler } from './middleware/errorHandler';
import { requestLogger, requestIdMiddleware } from './middleware/requestLogger';
import { clientIPMiddleware } from './middleware/clientIP';

import authRouter from './routes/auth';
import usersRouter from './routes/users';
import teamsRouter from './routes/teams';
import accountsRouter from './routes/accounts';
import domainsRouter from './routes/domains';
import providersRouter from './routes/providers';
import recordsRouter, { emailTemplatesRouter } from './routes/records';
import initRouter from './routes/init';
import systemRouter from './routes/system';
import settingsRouter from './routes/settings';
import securityRouter from './routes/security';
import securityPolicyRouter from './routes/securityPolicy';
import auditRouter from './routes/audit';
// emailTemplatesRouter has been moved to records.ts under /api/domains/email-templates
// import emailTemplatesRouter from './routes/emailTemplates';
import tunnelsRouter from './routes/tunnels';
import webauthnRouter from './routes/webauthn';
import tokensRouter from './routes/tokens';
import nsMonitorRouter from './routes/ns-monitor';
import networkRouter from './routes/network';
import rdapRouter from './routes/rdap';
import mcpConfigRouter from './routes/mcp-config';
import mcpApiKeysRouter from './routes/mcp-apikeys';
import mcpOAuthRouter from './routes/mcp-oauth';
import mcpAuditRouter from './routes/mcp-audit';
import mcpProtocolRouter from './routes/mcp-protocol';
import servicemonitorRouter from './routes/servicemonitor';
import resourceMonitorRouter from './routes/resource-monitor';
import { rdapLimiter } from './middleware/rateLimit';
import { getAuditLogs } from './service/auditExport';
import { getString, parseInteger, parsePagination, sendError, sendSuccess } from './utils/http';

import { startServiceMonitorJob } from './service/serviceMonitorJob';
import { startWhoisJob } from './service/whois';
import { startNsMonitorJob } from './service/nsMonitorJob';
import { startDomainRenewalJob } from './service/domainRenewalJob';
import { startRecordCountCacheRefresh } from './service/recordCountCache';
import { startDomainSyncJob } from './service/domainSyncJob';
import { startGroupedCacheRefreshJob } from './service/groupedCacheJob';
import { startMcpOAuthCleanupJob } from './service/mcpOAuthCleanupJob';
import { startResourceMonitorJob } from './service/resource/job';
import { startResourcePruneJob } from './service/resource/prune';
import { checkForUpdate, downloadUpdate } from './service/autoUpdater';

// 读取 package.json 获取版本信息
import { readFileSync } from 'fs';
let packageVersion = 'unknown';
try {
  const packageJson = JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf-8'));
  packageVersion = packageJson.version || 'unknown';
} catch (error) {
  // 忽略错误，使用默认版本
}

/**
 * 打印启动横幅
 */
function printBanner(port: number): void {
  // Use named constants for better maintainability
  const CYAN = '\x1b[36m';
  const MAGENTA = '\x1b[35m';
  const GRAY = '\x1b[90m';
  const RESET = '\x1b[0m';
  const BOLD = '\x1b[1m';

  const banner = `
${CYAN}╔═══════════════════════════════════════════════════════════╗${RESET}
${CYAN}║${RESET}                                                       ${CYAN}║${RESET}
${CYAN}║${RESET}   ██╗  ██╗██╗██████╗ ███╗   ██╗███████╗              ${CYAN}║${RESET}
${CYAN}║${RESET}   ██║  ██║██║██╔══██╗████╗  ██║██╔════╝              ${CYAN}║${RESET}
${CYAN}║${RESET}   ███████║██║██║  ██║██╔██╗ ██║███████╗              ${CYAN}║${RESET}
${CYAN}║${RESET}   ██╔══██║██║██║  ██║██║╚██╗██║╚════██║              ${CYAN}║${RESET}
${CYAN}║${RESET}   ██║  ██║██║██████╔╝██║ ╚████║███████║              ${CYAN}║${RESET}
${CYAN}║${RESET}   ╚═╝  ╚═╝╚═╝╚═════╝ ╚═╝  ╚═══╝╚══════╝              ${CYAN}║${RESET}
${CYAN}║${RESET}                                                       ${CYAN}║${RESET}
${CYAN}║${RESET}   ${BOLD}${MAGENTA}HiDNS Manager${RESET}                                    ${CYAN}║${RESET}
${CYAN}║${RESET}                                                       ${CYAN}║${RESET}
${CYAN}║${RESET}   ${GRAY}Project:${RESET} HiDNS Manager                         ${CYAN}║${RESET}
${CYAN}║${RESET}   ${GRAY}Version:${RESET} ${packageVersion.padEnd(42)}${CYAN}║${RESET}
${CYAN}║${RESET}   ${GRAY}GitHub:${RESET}  https://github.com/HiPM-Tech/HiDNS    ${CYAN}║${RESET}
${CYAN}║${RESET}                                                       ${CYAN}║${RESET}
${CYAN}╚═══════════════════════════════════════════════════════════╝${RESET}
`;
  console.log(banner);
}
import { initRenewalSchedulers } from './service/renewalInit';
import { wsService } from './service/websocket';
import { initWhoisSchedulers } from './service/whois';
import { createLogger } from './lib/logger';
const log = createLogger('Server').sub('App');
import { OAuthOperations, McpOperations } from './db/bal/business-adapter';

const app = express();

// Server instance for graceful shutdown
let server: http.Server | null = null;

const PORT = parseInt(process.env.PORT || '3001', 10);

// Global state to track initialization
let isInitialized = false;

async function checkInitialization(): Promise<boolean> {
  return await isDbInitialized() && await hasUsers();
}

// Middlewares
// Trust proxy - enables correct req.protocol and req.ip behind reverse proxies
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy !== undefined && trustProxy !== '') {
  app.set('trust proxy', trustProxy);
} else if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', [
    'loopback',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '169.254.0.0/16',
  ]);
}

// Helmet - Security headers (must be before other middlewares)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // Required for React/Vite
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'", 'https:'],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: null,
    },
  },
  crossOriginOpenerPolicy: false, // Disable on HTTP to avoid browser warnings
  crossOriginEmbedderPolicy: false, // Allow embedding resources
  originAgentCluster: false, // Disable on HTTP to avoid browser warnings
}));

// Parse cookies (for httpOnly JWT cookie)
app.use(cookieParser());

// CORS configuration - automatically allow requesting origin
// In production, you can restrict by setting CORS_ORIGIN env var (comma-separated)
const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // If no origin specified (same-origin request), allow it
    if (!origin) {
      return callback(null, true);
    }

    // If CORS_ORIGIN is set, only allow those origins
    if (process.env.CORS_ORIGIN) {
      const allowedOrigins = process.env.CORS_ORIGIN.split(',').map(o => o.trim());
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    }

    // Default: allow all origins (development mode)
    // This makes it work out of the box without configuration
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400, // 24 hours
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(requestIdMiddleware);
app.use(clientIPMiddleware); // 必须在 requestLogger 之前，确保日志记录真实 IP
app.use(requestLogger);

// Swagger setup
const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'HiDNS API',
      version: '1.0.0',
      description: `HiDNS - DNS Aggregation Management Platform API

## Authentication

This API supports two authentication methods:

### 1. JWT Token (User Login)
After logging in via \`/api/auth/login\`, you will receive a JWT token.
Include it in the Authorization header:
\`\`\`
Authorization: Bearer <jwt_token>
\`\`\`

### 2. API Token (Programmatic Access)
API tokens can be created from the web UI (Settings > API Tokens) and are
suitable for automated scripts and CI/CD pipelines.

Include the API token in the Authorization header:
\`\`\`
Authorization: Bearer <api_token>
\`\`\`

API tokens have the same permissions as the user who created them and can be
restricted to specific domains and time ranges.

### Token Permissions
- API tokens inherit the creator's role (User/Admin/Super Admin)
- Domain restrictions: Tokens can be limited to specific domains
- Time restrictions: Tokens can have start/end time limits
- All API endpoints support both JWT and API token authentication`,
    },
    servers: [
      {
        url: process.env.API_BASE_URL || `http://localhost:${PORT}`,
        description: process.env.API_BASE_URL ? 'Custom API URL' : 'Local development',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT or API Token',
          description: 'Enter your JWT token or API token',
        },
      },
    },
  },
  apis: ['./src/routes/*.ts', './dist/routes/*.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Initialize routes - always available
app.use('/api/init', initRouter);

// Middleware to check initialization status for protected routes
function initCheckMiddleware(req: Request, res: Response, next: NextFunction) {
  if (isInitialized) {
    return next();
  }
  // Return 503 if not initialized
  res.status(503).json({
    code: 503,
    msg: 'System not initialized. Please complete setup first.',
    data: { needsInit: true }
  });
}

// Apply initialization check middleware to protected paths
const protectedPaths = ['/api/auth', '/api/users', '/api/teams', '/api/accounts', '/api/domains', '/api/logs', '/api/settings', '/api/tokens', '/api/mcp', '/api/servicemonitor', '/api/resource-monitor'];
protectedPaths.forEach(path => {
  app.use(path, initCheckMiddleware);
});

// Routes - these will only be accessible if isInitialized is true
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/teams', teamsRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/domains/email-templates', emailTemplatesRouter); // Use separate router to avoid conflicts
app.use('/api/domains', domainsRouter);
app.use('/api/providers', providersRouter);
app.use('/api/domains/:domainId/records', recordsRouter);
app.use('/api/rdap', rdapLimiter, rdapRouter);
app.use('/api/system', systemRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/security', securityRouter);
app.use('/api/security', securityPolicyRouter);
app.use('/api/audit', auditRouter);
// Email templates API moved to /api/domains/email-templates (see records.ts)
// app.use('/api/email-templates', emailTemplatesRouter);
app.use('/api/tunnels', tunnelsRouter);
app.use('/api/auth/webauthn', webauthnRouter);
app.use('/api/tokens', tokensRouter);
app.use('/api/ns-monitor', nsMonitorRouter);
app.use('/api/network', networkRouter);
app.use('/api/servicemonitor', servicemonitorRouter);
app.use('/api/resource-monitor', resourceMonitorRouter);

// MCP 路由 - 统一合并到父级路由器，避免重复注册 /api/mcp
const mcpRouter = express.Router();
mcpRouter.use('/', mcpConfigRouter); // /config, /status, /.well-known/*
mcpRouter.use('/api-keys', mcpApiKeysRouter); // Authenticated
mcpRouter.use('/oauth', mcpOAuthRouter); // Mixed（部分公开、部分需认证）
mcpRouter.use('/audit-logs', mcpAuditRouter); // Authenticated
mcpRouter.use('/audit-stats', mcpAuditRouter); // Authenticated
// 协议路由放最后，确保更具体的管理路由优先匹配
mcpRouter.use('/', mcpProtocolRouter); // /(Streamable HTTP), /sse(SSE)
app.use('/api/mcp', mcpRouter);

// Logs route
/**
 * @swagger
 * /api/logs:
 *   get:
 *     summary: Get operation logs (admin only)
 *     tags: [Logs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *       - in: query
 *         name: domain
 *         schema:
 *           type: string
 *       - in: query
 *         name: userId
 *         schema:
 *           type: integer
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           example: 2026-04-01
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           example: 2026-04-04
 *     responses:
 *       200:
 *         description: Operation logs
 */
app.get('/api/logs', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  try {
    const { page, pageSize } = parsePagination(req.query, { defaultPageSize: 50, maxPageSize: 200 });
    const { total, logs } = await getAuditLogs(page, pageSize, {
      domain: getString(req.query.domain),
      userId: parseInteger(req.query.userId),
      action: getString(req.query.action),
      startDate: getString(req.query.startDate),
      endDate: getString(req.query.endDate),
    });

    sendSuccess(res, {
      total,
      list: logs.map((log) => ({
        id: log.id,
        user_id: log.userId,
        username: log.username,
        nickname: log.nickname,
        action: log.action,
        domain: log.domain,
        data: JSON.stringify(log.data),
        created_at: log.createdAt,
      })),
    });
  } catch (error) {
    sendError(res, error instanceof Error ? error.message : 'Failed to fetch logs', 500);
  }
});

// Serve static files from client build directory
// Support both development and packaged executable (SEA binary)
const possiblePaths = [
  // Packaged: assets are in APP_ROOT/client/dist
  path.join(APP_ROOT, 'client/dist'),
  // Development: client/dist from server/src
  path.join(APP_ROOT, '../../client/dist'),
  // Alternative: from server/dist
  path.join(APP_ROOT, '../client/dist'),
  // Fallback: client folder next to executable
  path.join(process.cwd(), 'client'),
];

let clientBuildPath = '';
for (const p of possiblePaths) {
  try {
    if (require('fs').existsSync(p)) {
      clientBuildPath = p;
      console.log('✅ Serving static files from:', p);
      break;
    }
  } catch (e) {
    // Path might not be accessible in pkg snapshot
  }
}

/** 嵌入式客户端文件索引（SEA 二进制场景） */
interface EmbeddedFile { content: Buffer; mimeType: string; }
let embeddedClient: Record<string, EmbeddedFile> | null = null;

if (clientBuildPath) {
  // CORS for static assets (required when crossorigin is used on script/link)
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  });
  app.use(express.static(clientBuildPath));
} else {
  // 尝试从嵌入式模块加载（SEA 二进制打包时生成）
  try {
    embeddedClient = require('./embedded-client');
    if (embeddedClient) {
      console.log('✅ Serving embedded client files');
    }
  } catch {
    // 嵌入式客户端不可用
  }

  if (!embeddedClient) {
    console.warn('⚠️ Client build directory not found. API-only mode.');
  }
}

// SPA fallback — 处理所有非 API 路由
// 注意：express.static 已在前面注册，正常情况下静态资源会被它拦截。
// 此回退仅处理 express.static 未能匹配的情况（如嵌入式客户端场景）。
app.get('*', createSpaFallback(clientBuildPath, embeddedClient));

// Global error handler (must be last)
app.use(errorHandler);

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(
  signal: string,
  initCheckInterval?: NodeJS.Timeout,
  oauthStateCleanupInterval?: NodeJS.Timeout
): Promise<void> {
  if (initCheckInterval) clearInterval(initCheckInterval);
  if (oauthStateCleanupInterval) clearInterval(oauthStateCleanupInterval);

  log.info(`${signal} received, starting graceful shutdown...`);

  // Shutdown WebSocket service
  wsService.shutdown();

  try {
    await disconnect();
    log.info('Database disconnected gracefully');
  } catch (err) {
    log.error('Error during database disconnect', { error: err });
  }

  if (server) {
    server.close(() => {
      log.info('Server closed');
      process.exit(0);
    });
  } else {
    log.info('No server instance to close');
    process.exit(0);
  }
}

// Initialize database connection and check state
async function initializeApp() {
  try {
    // Initialize new database system (unified connection)
    await connect();

    // Run unified schema initialization and migration checks
    // Using new Declarative Schema Management (DSM)
    await initializeDSM();

    // 强制写入磁盘，确保 schema 变更持久化
    const conn = getConnection();
    if (conn.checkpoint) {
      await conn.checkpoint();
      log.info('✅ WAL checkpoint completed after DSM reconciliation.');
    }

    // 重启数据库连接管理，确保连接池以最新 schema 状态运行
    await disconnect();
    log.info('🔄 Database connection closed, reconnecting...');
    await connect();
    log.info('✅ Database connection re-established.');

    // Check if system is initialized
    isInitialized = await checkInitialization();

    if (isInitialized) {
      log.info('System initialized. Running in normal mode.');

      // 重启时清理所有未分配用户的临时 OAuth 客户端
      McpOperations.cleanupUnassignedOAuthClients().then((count: number) => {
        if (count > 0) log.info(`Cleaned up ${count} unassigned temporary clients on startup`);
      }).catch((err: unknown) => {
        log.error('Failed to cleanup unassigned clients on startup', { error: err });
      });

      // 初始化续期和 WHOIS 调度器
      initRenewalSchedulers();
      initWhoisSchedulers();

      startServiceMonitorJob();
      startWhoisJob();
      startNsMonitorJob();
      startDomainRenewalJob();
      startRecordCountCacheRefresh(30); // Refresh every 30 minutes
      startDomainSyncJob(0.5); // Sync every 30 minutes
      startGroupedCacheRefreshJob();
      startResourceMonitorJob();
      startResourcePruneJob();
    } else {
      log.info('System not initialized. Running in initialization mode.');
      log.info('Please access the setup wizard to configure the system.');
    }

    // Start server with WebSocket support
    server = http.createServer(app);

    // Initialize WebSocket service
    wsService.initialize(server);

    // 打印启动横幅
    printBanner(PORT);

    server.listen(PORT, () => {
      log.info(`HiDNS running on http://localhost:${PORT}`);
      log.info(`API Docs: http://localhost:${PORT}/api/docs`);
      if (!isInitialized) {
        log.info(`Setup Wizard: http://localhost:${PORT}/setup`);
      }
    });

    // Re-check initialization status periodically (every 5 seconds)
    const initCheckInterval = setInterval(async () => {
      const newState = await checkInitialization();
        if (!isInitialized && newState) {
          // System just got initialized
          isInitialized = true;
          log.info('System initialized detected. Normal routes are now enabled.');
          log.info('You may need to refresh the page.');
          startServiceMonitorJob();
          startWhoisJob();
          startNsMonitorJob();
          startDomainRenewalJob();
          startRecordCountCacheRefresh(30); // Refresh every 30 minutes
          startDomainSyncJob(0.5); // Sync every 30 minutes
          startResourceMonitorJob();
          startResourcePruneJob();
        }
    }, 5000);

    // 定期清理过期的 OAuth states (每 10 分钟)
    const oauthStateCleanupInterval = setInterval(async () => {
      try {
        const deletedCount = await OAuthOperations.cleanupExpiredStates();
        if (deletedCount > 0) {
          log.debug(`Cleaned up ${deletedCount} expired states`);
        }
      } catch (err) {
        log.error('Failed to cleanup expired states', { error: err });
      }
    }, 10 * 60 * 1000);

    // 启动 MCP OAuth 临时客户端定期清理任务（每 5 分钟）
    startMcpOAuthCleanupJob();

    // 启动自动更新检测（仅 SEA 二进制模式且 HIDNS_AUTO_UPDATE=true）
    startAutoUpdateCheck();

    // Graceful shutdown
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM', initCheckInterval, oauthStateCleanupInterval));
    process.on('SIGINT', () => gracefulShutdown('SIGINT', initCheckInterval, oauthStateCleanupInterval));

  } catch (error) {
    log.info('Database not configured. Running in initialization mode.');
    log.info('Please access the setup wizard to configure the system.');

    server = http.createServer(app);

    // Initialize WebSocket service
    wsService.initialize(server);

    // 打印启动横幅
    printBanner(PORT);

    server.listen(PORT, () => {
      log.info(`HiDNS running on http://localhost:${PORT}`);
      log.info(`API Docs: http://localhost:${PORT}/api/docs`);
      log.info(`Setup Wizard: http://localhost:${PORT}/setup`);
    });

    // Re-check initialization status periodically
    const MAX_RETRIES = 60; // Maximum 60 retries (5 minutes at 5s intervals)
    let retryCount = 0;
    const initCheckInterval = setInterval(async () => {
      try {
        await connect();
        await initializeDSM(); // Use DSM for initialization
        const newState = await checkInitialization();
        if (newState) {
          isInitialized = true;
          clearInterval(initCheckInterval);
          startServiceMonitorJob();
          startWhoisJob();
          startNsMonitorJob();
          startDomainRenewalJob();
          startRecordCountCacheRefresh(30); // Refresh every 30 minutes
          startDomainSyncJob(0.5); // Sync every 30 minutes
          startResourceMonitorJob();
          startResourcePruneJob();
          log.info('System initialized detected. Normal routes are now enabled.');
          log.info('You may need to refresh the page.');
        }
      } catch (err) {
        retryCount++;
        if (retryCount >= MAX_RETRIES) {
          log.error(`Failed to initialize after ${MAX_RETRIES} attempts. Stopping retry.`);
          clearInterval(initCheckInterval);
        }
        // Still not initialized
      }
    }, 5000);

    // 启动自动更新检测（仅 SEA 二进制模式且 HIDNS_AUTO_UPDATE=true）
    startAutoUpdateCheck();

    // Graceful shutdown - use the unified gracefulShutdown function
    // Note: oauthStateCleanupInterval is not started in this branch, so pass undefined
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM', initCheckInterval));
    process.on('SIGINT', () => gracefulShutdown('SIGINT', initCheckInterval));
  }
}

/**
 * 启动自动更新检测（SEA 二进制 + HIDNS_AUTO_UPDATE=true 时生效）
 * - 启动时立即检测一次
 * - 之后每 6 小时检测一次
 */
function startAutoUpdateCheck(): void {
  if (process.env.HIDNS_AUTO_UPDATE !== 'true') return;

  // 判断是否 SEA 二进制（process.execPath 不是 node 本身）
  const isSea = !process.execPath.endsWith('node') && !process.execPath.endsWith('node.exe');
  if (!isSea) {
    log.info('Auto-update skipped: not running as SEA binary');
    return;
  }

  log.info('Auto-update enabled, checking for updates...');

  async function doCheck(): Promise<void> {
    try {
      const result = await checkForUpdate();
      if (result.hasUpdate && result.downloadUrl) {
        log.info(`Update available: ${result.currentVersion} → ${result.latestVersion}`);
        console.log(`\n📦 Update available: ${result.currentVersion} → ${result.latestVersion}`);
        console.log(`   Release: ${result.releaseName || result.latestVersion}`);
        console.log(`   Downloading...`);

        const scriptPath = await downloadUpdate(result.downloadUrl);

        console.log(`✅ Update downloaded. Restarting in 3 seconds...\n`);

        // Spawn restart script and exit
        const { spawn } = require('child_process');
        if (process.platform === 'win32') {
          spawn('cmd.exe', ['/c', scriptPath], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
        }

        // Give the script a moment to start, then exit
        setTimeout(() => process.exit(0), 500);
      } else if (result.error) {
        log.debug(`Update check failed: ${result.error}`);
      }
    } catch (err: any) {
      log.error('Auto-update check error', { error: err.message });
    }
  }

  // 立即执行一次，之后每 6 小时检查
  doCheck();
  setInterval(doCheck, 6 * 60 * 60 * 1000);
}

// Start the application
initializeApp();

export default app;
