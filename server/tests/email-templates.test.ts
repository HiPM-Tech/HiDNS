import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';
import { DEFAULT_TEMPLATES, renderEmailTemplate, renderTemplate } from '../src/service/emailTemplates';
import { getConnection } from '../src/db/connection';

describe('邮件模板（#43 C3）', () => {
  let handle: TestDbHandle;
  beforeAll(async () => { handle = await setupTestDb(); });
  afterAll(async () => { await handle.cleanup(); });

  it('没有自定义模板时使用默认模板并渲染变量', async () => {
    const { subject, body } = await renderEmailTemplate('verification_code', { code: '123456', ttlMinutes: 10 });
    expect(subject).toBe(DEFAULT_TEMPLATES.verification_code.subject);
    expect(body).toContain('123456');
    expect(body).toContain('10 分钟');
  });

  it('自定义模板优先于默认模板', async () => {
    await getConnection().execute(
      "INSERT INTO email_templates (type, subject, body) VALUES ('verification_code', '自定义标题', '验证码 {{code}}')",
    );
    const { subject, body } = await renderEmailTemplate('verification_code', { code: '654321', ttlMinutes: 5 });
    expect(subject).toBe('自定义标题');
    expect(body).toBe('验证码 654321');
  });

  it('未知变量渲染为空串，不会留下 {{占位符}}', () => {
    const result = renderTemplate({ subject: 'S', body: 'a={{a}} b={{missing}}' }, { a: 1 });
    expect(result.body).toBe('a=1 b=');
  });
});