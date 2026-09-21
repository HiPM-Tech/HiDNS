import { Request, Response } from 'express';
import path from 'path';

interface EmbeddedFile { content: Buffer; mimeType: string }

export function createSpaFallback(clientBuildPath: string | null, embeddedClient: Record<string, EmbeddedFile> | null) {
  return (req: Request, res: Response) => {
    // Don't interfere with API routes
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ code: 404, msg: 'API endpoint not found' });
    }

    // 检查路径是否包含文件扩展名（静态资源请求）
    const hasExtension = /\.[a-zA-Z0-9]+$/.test(req.path);

    if (hasExtension) {
      // 静态资源请求 — 优先从文件系统查找，其次嵌入式客户端
      if (clientBuildPath) {
        // Resolve against the static root and reject paths that escape it.
        const root = path.resolve(clientBuildPath);
        const filePath = path.resolve(root, req.path.replace(/^\//, ''));
        const relativePath = path.relative(root, filePath);
        if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
          return res.status(403).send('Forbidden');
        }
        try {
          if (require('fs').existsSync(filePath)) {
            return res.sendFile(filePath);
          }
        } catch {
          // 文件不存在，继续
        }
      }

      // 从嵌入式客户端响应对应静态资源
      if (embeddedClient) {
        const staticFile = embeddedClient[req.path];
        if (staticFile) {
          return res.type(staticFile.mimeType).send(staticFile.content);
        }
      }

      // 找不到资源
      return res.status(404).send('File not found');
    }

    // 无扩展名 → SPA 导航请求，返回 index.html
    if (clientBuildPath) {
      const spaIndex = path.join(clientBuildPath, 'index.html');
      try {
        if (require('fs').existsSync(spaIndex)) {
          return res.sendFile(spaIndex);
        }
      } catch {
        // 文件不存在，继续
      }
    }

    // 策略 2: 嵌入式客户端（SEA 二进制）
    if (embeddedClient) {
      const indexFile = embeddedClient['/index.html'];
      if (indexFile) {
        return res.type('html').send(indexFile.content);
      }
    }

    res.status(404).send('index.html not found');
  };
}
