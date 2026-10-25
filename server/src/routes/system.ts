import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { SystemOperations, isDbConnected } from '../db/bal/business-adapter';

const router = Router();

// Get system information for about page
router.get('/info', authMiddleware, async (req: Request, res: Response) => {
  try {
    // Get database info from business adapter
    const dbInfo = await SystemOperations.getDatabaseInfo();
    
    // Get server package version from root package.json
    let serverVersion = require('../../package.json').version;
    
    // Check if this is a CI build and add -ci suffix
    const isCIBuild = process.env.CI_BUILD === 'true' || 
                      process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REF?.includes('pull');
    
    if (isCIBuild && !serverVersion.includes('-ci')) {
      serverVersion = `${serverVersion}-ci`;
    }
    
    res.json({
      code: 0,
      data: {
        version: serverVersion, // System version uses backend package.json version
        serverVersion,
        database: dbInfo,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language: req.headers['accept-language'] || 'en',
        isCIBuild, // Add flag for frontend to display CI indicator
      },
      msg: 'success',
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      msg: error instanceof Error ? error.message : 'Failed to get system info',
    });
  }
});

// Get system version information (version, deploy mode, log level, node status)
router.get('/version', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const serverVersion = require('../../package.json').version;

    // Detect deployment mode
    let deployMode: 'sea' | 'pkg' | 'dev';
    if (!!(process as any).pkg) {
      deployMode = 'pkg';
    } else {
      try {
        const sea = require('node:sea');
        deployMode = typeof sea.isSea === 'function' && sea.isSea() ? 'sea' : 'dev';
      } catch {
        const exe = require('path').basename(process.execPath).toLowerCase();
        deployMode = exe === 'hidns.exe' || exe === 'hidns' ? 'sea' : 'dev';
      }
    }

    // Log level
    const logLevel = process.env.HIDNS_LOG_LEVEL || 'info';

    // Node status
    const uptime = process.uptime();
    const startTime = new Date(Date.now() - uptime * 1000).toISOString();
    const dbConnected = isDbConnected();

    res.json({
      code: 0,
      data: {
        version: serverVersion,
        nodeVersion: process.version,
        deployMode,
        logLevel,
        nodeStatus: {
          status: 'running',
          uptime,
          startTime,
          dbConnected,
        },
      },
      msg: 'success',
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      msg: error instanceof Error ? error.message : 'Failed to get system version info',
    });
  }
});

export default router;
