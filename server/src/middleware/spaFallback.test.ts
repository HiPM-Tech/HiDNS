import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http, { Server } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createSpaFallback } from './spaFallback';

const root = mkdtempSync(path.join(tmpdir(), 'hidns-static-'));
const build = path.join(root, 'client', 'dist');
let server: Server;
function request(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: (server.address() as AddressInfo).port, path: url }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    }).on('error', reject);
  });
}
beforeAll(async () => {
  mkdirSync(build, { recursive: true });
  mkdirSync(path.join(root, 'data'));
  mkdirSync(path.join(root, 'client', 'dist-private'));
  writeFileSync(path.join(root, 'data', 'test.db'), 'private fixture');
  writeFileSync(path.join(root, 'client', 'dist-private', 'test.db'), 'private fixture');
  writeFileSync(path.join(build, 'index.html'), '<html>HiDNS</html>');
  writeFileSync(path.join(build, 'app.js'), 'public asset');
  const app = express();
  app.use(express.static(build));
  app.get('*', createSpaFallback(build, null));
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  rmSync(root, { recursive: true, force: true });
});
describe('SPA static file boundary', () => {
  it.each(['/../../data/test.db', '/assets/../../../data/test.db', '/../dist-private/test.db', '/%2e%2e/%2e%2e/data/test.db', '/..%2f..%2fdata/test.db'])('denies %s', async url => {
    const result = await request(url);
    expect([403, 404]).toContain(result.status);
    expect(result.body).not.toContain('private fixture');
  });
  it('serves public assets and SPA routes', async () => {
    expect(await request('/app.js')).toEqual({ status: 200, body: 'public asset' });
    expect(await request('/dashboard')).toEqual({ status: 200, body: '<html>HiDNS</html>' });
    expect((await request('/missing.js')).status).toBe(404);
    expect((await request('/api/missing')).status).toBe(404);
  });
});
